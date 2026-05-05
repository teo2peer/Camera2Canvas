"""FastAPI service: camera + scan + LED + websocket bridge to Electron.

Endpoints
---------
* ``GET  /cameras``                 — list of opened camera labels (overhead/front)
* ``GET  /cameras/devices``         — list physical devices (slow probe)
* ``GET  /preview/{label}.jpg``     — single JPEG snapshot with detection overlay
* ``GET  /preview/{label}.mjpg``    — multipart JPEG live stream (shared producer)
* ``GET  /template/sheet.png``      — printable A4 sheet with 4 corner markers
* ``WS   /ws``                      — event bus (drawing_detected, drawing_captured,
                                       hand_gesture, button_press, …)
* ``GET  /drawings/<id>.png``       — saved drawings (StaticFiles)
* ``GET  /thumbs/<id>.png``         — saved thumbnails (StaticFiles)
* ``GET  /tablet/``                 — tablet UI (StaticFiles)

Lifecycle
---------
On startup we:
  1) initialise SQLite,
  2) open the LED serial bridge (best-effort; service still runs without it),
  3) open every camera in the configured ``camera_mode``,
  4) spawn one ``CapturePipeline`` task per camera.

The Python service is the *only* process touching cameras. Electron consumes
frames purely via the HTTP MJPEG endpoint above.
"""
import asyncio
import json
import threading
from contextlib import asynccontextmanager

import cv2
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import db
from .arduino import LedBridge
from .camera import CameraSource
from .config import DRAW_DIR, ROOT, THUMB_DIR, load_settings, save_settings
from .logconf import setup_logging
from .pipeline import CapturePipeline

setup_logging()
import logging
log = logging.getLogger("service.main")

SETTINGS = load_settings()

# ---- runtime state -------------------------------------------------------
clients: set[WebSocket] = set()                     # connected websocket peers
pipelines: list[CapturePipeline] = []               # one per camera
cams: list[CameraSource] = []                       # raw camera handles
cams_by_label: dict[str, CameraSource] = {}         # "overhead"/"front" -> cam
last_quad_by_label: dict[str, list[int] | None] = {}  # bbox of last detected sheet
led: LedBridge | None = None

# Shared MJPEG producer state.
# A single asyncio task per camera updates these; every HTTP consumer reads.
_jpeg_cache: dict[str, bytes] = {}
_jpeg_seq: dict[str, int] = {}
_encoder_started: set[str] = set()


# --------------------------------------------------------------------------
# Websocket helpers
# --------------------------------------------------------------------------
async def broadcast(msg: dict) -> None:
    """Send ``msg`` (as JSON) to every connected websocket client. Logs at DEBUG."""
    if not clients:
        return
    payload = json.dumps(msg)
    log.debug("ws broadcast %s -> %d client(s)", msg.get("type"), len(clients))
    dead = []
    for ws in clients:
        try:
            await ws.send_text(payload)
        except Exception as e:
            log.warning("ws send failed (%s); dropping client", e)
            dead.append(ws)
    for d in dead:
        clients.discard(d)


def start_led_animation_for(palette: list[str]) -> None:
    """Kick the LED 'travel' animation in a daemon thread so it never blocks."""
    if led is None:
        log.debug("LED animation skipped (no bridge)")
        return
    log.info("LED travel animation: palette=%s", palette[:3])
    threading.Thread(target=led.play_travel, args=(palette,), daemon=True).start()


async def on_capture_hook(msg: dict) -> None:
    """Pipeline broadcast hook.

    Side-effects on top of the plain broadcast:
      * cache last detected bbox per camera (for MJPEG overlay)
      * trigger LED animation when a drawing is captured
    """
    mtype = msg.get("type")
    if mtype == "drawing_detected":
        for k in cams_by_label:
            last_quad_by_label[k] = msg.get("bbox")
    elif mtype == "drawing_captured":
        log.info("drawing captured id=%s palette=%s", msg.get("id"), msg.get("palette"))
    elif mtype == "capture_error":
        log.error("capture error: %s", msg.get("error"))
    await broadcast(msg)
    if mtype == "drawing_captured":
        start_led_animation_for(msg.get("palette", []))
    elif mtype == "grid_scanned":
        # Build a small palette from the filled cells so the strip glows
        # in the colours the user drew on the grid.
        cells = msg.get("cells") or []
        seen: list[str] = []
        for row in cells:
            for cell in row:
                if cell.get("filled"):
                    h = cell.get("hex", "")
                    if h and h not in seen:
                        seen.append(h)
                        if len(seen) >= 5:
                            break
            if len(seen) >= 5:
                break
        if seen:
            start_led_animation_for(seen)


# --------------------------------------------------------------------------
# Preview encoder (shared across all consumers)
# --------------------------------------------------------------------------
def _encode_preview(frame, bb, max_w: int = 480, q: int = 60) -> bytes | None:
    """Resize-then-JPEG-encode a frame, drawing the detection bbox if present.

    Runs in a thread executor so the asyncio loop stays responsive.
    """
    h, w = frame.shape[:2]
    if w > max_w:
        scale = max_w / w
        frame = cv2.resize(frame, (max_w, int(h * scale)))
        if bb:
            bb = [int(v * scale) for v in bb]
    if bb:
        cv2.rectangle(frame, (bb[0], bb[1]), (bb[2], bb[3]), (0, 255, 80), 2)
    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, q])
    return buf.tobytes() if ok else None


async def _producer(label: str, cam: CameraSource) -> None:
    """Single encoder loop per camera. Updates ``_jpeg_cache[label]`` at ~12 fps.

    If the camera momentarily yields no frame, we still bump ``seq`` so
    consumers don't stall, and we re-emit the last good JPEG so the
    browser <img> never goes black on a transient hiccup.
    """
    log.info("preview producer started for %s", label)
    loop = asyncio.get_event_loop()
    target_dt = 1 / 24
    seq = 0
    consecutive_empty = 0
    while label in cams_by_label:
        t0 = loop.time()
        frame = cam.read()
        if frame is not None:
            consecutive_empty = 0
            bb = last_quad_by_label.get(label)
            try:
                jpg = await loop.run_in_executor(None, _encode_preview, frame, bb)
            except Exception as e:
                log.warning("preview encode error for %s: %s", label, e)
                jpg = None
            if jpg is not None:
                _jpeg_cache[label] = jpg
                seq += 1
                _jpeg_seq[label] = seq
        else:
            consecutive_empty += 1
            if consecutive_empty == 25:
                log.warning("preview producer for %s: no frames for ~2s", label)
            # bump seq on cached so consumers see a 'tick' and resend
            if label in _jpeg_cache:
                seq += 1
                _jpeg_seq[label] = seq
        elapsed = loop.time() - t0
        await asyncio.sleep(max(0.0, target_dt - elapsed))
    log.info("preview producer stopped for %s", label)


def _ensure_producer(label: str, cam: CameraSource) -> None:
    if label in _encoder_started:
        return
    _encoder_started.add(label)
    asyncio.get_event_loop().create_task(_producer(label, cam))


# --------------------------------------------------------------------------
# Lifespan: open hardware, spin pipelines, tear down on exit
# --------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    global led
    log.info("==== service starting ====")
    log.info("settings: %s", SETTINGS.model_dump())

    await db.init()
    log.info("sqlite ready")

    # Arduino LED bridge — also receives the capture button (BTN\n).
    def _on_button():
        """Called from the serial reader thread when a BTN line is received."""
        log.info("Arduino button pressed -> arming all pipelines")
        for p in pipelines:
            p.button_pending = True
        try:
            asyncio.run_coroutine_threadsafe(
                broadcast({"type": "button_press"}),
                asyncio.get_event_loop(),
            )
        except Exception:
            pass

    led = LedBridge(SETTINGS.led_serial_port, SETTINGS.led_baud, SETTINGS.led_count, on_button=_on_button)
    led_ok = led.open()
    log.info("LED bridge: %s (port=%r baud=%d count=%d)",
             "OK" if led_ok else "OFFLINE", SETTINGS.led_serial_port, SETTINGS.led_baud, SETTINGS.led_count)
    await broadcast({"type": "serial_status", "connected": led_ok})

    # Resolve which cameras to try based on camera_mode.
    sources: list[tuple[str, int]] = []
    if SETTINGS.camera_mode in ("overhead", "both"):
        sources.append(("overhead", SETTINGS.overhead_camera_index))
    if SETTINGS.camera_mode in ("front", "both"):
        sources.append(("front", SETTINGS.front_camera_index))
    log.info("camera plan: %s", sources)

    tasks: list[asyncio.Task] = []
    for label, idx in sources:
        try:
            mirror = (label == "front" and SETTINGS.mirror_front) or \
                     (label == "overhead" and SETTINGS.mirror_overhead)
            cam = CameraSource(idx, mirror=mirror)
            log.info("camera[%s] mirror=%s", label, mirror)
            cam.open()
            cams.append(cam)
            cams_by_label[label] = cam
            pipe = CapturePipeline(SETTINGS, on_capture_hook)
            pipelines.append(pipe)
            tasks.append(asyncio.create_task(pipe.run(cam, label)))
            log.info("camera[%s@%d] OPEN — pipeline running", label, idx)
        except Exception as e:
            log.error("camera[%s@%d] open failed: %s", label, idx, e)
            await broadcast({"type": "camera_error", "source": label, "error": str(e)})

    log.info("==== service ready (cameras=%d clients=0) ====", len(cams))

    yield

    log.info("==== service shutting down ====")
    for t in tasks:
        t.cancel()
    for c in cams:
        try:
            c.close()
        except Exception:
            pass
    if led:
        led.close()
    log.info("==== service stopped ====")


# --------------------------------------------------------------------------
# App + routes
# --------------------------------------------------------------------------
app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.mount("/drawings", StaticFiles(directory=str(DRAW_DIR)), name="drawings")
app.mount("/thumbs", StaticFiles(directory=str(THUMB_DIR)), name="thumbs")
app.mount("/tablet", StaticFiles(directory=str(ROOT / "service" / "tablet_static"), html=True), name="tablet")

# Realtime parameter playground (mounted at /playground/)
from . import playground as _pg  # noqa: E402
_pg.install(app, cams_by_label, SETTINGS, save_settings)


@app.get("/cameras")
async def list_cameras():
    """Return the labels of the cameras the service successfully opened."""
    return {"cameras": list(cams_by_label.keys())}


@app.get("/cameras/devices")
async def list_camera_devices():
    """Slow probe of physical camera devices (DirectShow names on Windows)."""
    log.info("device enumeration requested")
    from .enumerate_cams import list_all
    devices = await asyncio.get_event_loop().run_in_executor(None, list_all)
    log.info("found devices: %s", devices)
    return {"devices": devices}


@app.get("/template/sheet.png")
async def template_sheet(width_mm: int = 297, height_mm: int = 210, marker_mm: int = 25, dpi: int = 200):
    """Generate a printable sheet — landscape A4 by default — with 4 black corner
    markers and a smaller 5th orientation marker centred on the bottom edge.

    The orientation marker tells the detector which side is "down" so the
    digitised drawing always comes out the right way up regardless of how
    the user held the sheet.
    """
    import numpy as np
    log.debug("template sheet requested: %dx%dmm marker=%dmm dpi=%d",
              width_mm, height_mm, marker_mm, dpi)
    px_per_mm = dpi / 25.4
    W = int(width_mm * px_per_mm)
    H = int(height_mm * px_per_mm)
    M = int(marker_mm * px_per_mm)
    Mo = int(M * 0.55)              # orientation marker is ~55% of corner size
    pad = int(10 * px_per_mm)       # safe margin from sheet edge
    img = np.full((H, W, 3), 255, np.uint8)
    # 4 corner markers
    cv2.rectangle(img, (pad,         pad),         (pad + M,    pad + M),    (0, 0, 0), -1)
    cv2.rectangle(img, (W - pad - M, pad),         (W - pad,    pad + M),    (0, 0, 0), -1)
    cv2.rectangle(img, (pad,         H - pad - M), (pad + M,    H - pad),    (0, 0, 0), -1)
    cv2.rectangle(img, (W - pad - M, H - pad - M), (W - pad,    H - pad),    (0, 0, 0), -1)
    # 1 orientation marker — centred horizontally, on the bottom edge,
    # well inside the corner squares so it's clearly between them.
    cx = W // 2
    cv2.rectangle(img,
                  (cx - Mo // 2, H - pad - Mo),
                  (cx + Mo // 2, H - pad),
                  (0, 0, 0), -1)
    ok, buf = cv2.imencode(".png", img)
    return Response(content=buf.tobytes() if ok else b"", media_type="image/png",
                    headers={"Content-Disposition": "inline; filename=sheet.png"})


@app.get("/template/grid.png")
async def template_grid(
    width_mm: int = 297,
    height_mm: int = 210,
    cols: int | None = None,
    rows: int | None = None,
    marker_mm: int = 13,
    circle_mm: int = 9,
    orient_mm: int = 9,
    dpi: int = 200,
):
    """Printable grid sheet: 4 corner squares, 4 mid-side circles, 1 bottom
    orientation square, and an inner ``cols x rows`` grid. Defaults pulled
    from settings if unspecified."""
    if cols is None: cols = SETTINGS.grid_cols
    if rows is None: rows = SETTINGS.grid_rows
    from .grid_template import make_grid_sheet
    log.debug("grid sheet requested: %dx%dmm cols=%d rows=%d", width_mm, height_mm, cols, rows)
    img = make_grid_sheet(width_mm, height_mm, cols, rows, marker_mm, circle_mm, orient_mm, dpi)
    ok, buf = cv2.imencode(".png", img)
    return Response(content=buf.tobytes() if ok else b"", media_type="image/png",
                    headers={"Content-Disposition": "inline; filename=grid.png"})


@app.get("/template/grid.html")
async def template_grid_html():
    """HTML wrapper that prints the grid PNG at exact A4 landscape size.
    Browsers default to 'fit page' which scales raw PNGs; embedding the image
    inside a page with @page A4 landscape + 0 margin guarantees 1:1."""
    html = """<!doctype html>
<html><head><meta charset="utf-8"><title>Grid sheet</title>
<style>
  @page { size: A4 landscape; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  img { display: block; width: 297mm; height: 210mm; }
  @media print { body > .hint { display: none; } }
  .hint { position: fixed; top: 8px; right: 8px; font: 12px system-ui;
          background: #000; color: #fff; padding: 6px 10px; border-radius: 4px; }
</style></head>
<body>
  <div class="hint">Print → A4 landscape → margins: none → scale: 100%</div>
  <img src="/template/grid.png" alt="grid sheet">
  <script>window.addEventListener('load',()=>setTimeout(()=>window.print(),300));</script>
</body></html>"""
    return Response(content=html, media_type="text/html")


@app.post("/grid/scan/{label}")
async def grid_scan(label: str, cols: int = 50, rows: int = 30):
    """Scan the named camera once for a grid sheet. Returns per-cell colours."""
    cam = cams_by_label.get(label)
    if cam is None:
        return Response(status_code=404)
    frame = cam.read()
    if frame is None:
        return Response(status_code=503)
    from .grid_capture import scan_grid
    result = await asyncio.get_event_loop().run_in_executor(
        None, scan_grid, frame, cols, rows
    )
    if result is None:
        return Response(status_code=422, content=b'{"error":"no sheet detected"}',
                        media_type="application/json")
    try:
        await broadcast({"type": "grid_scanned", "source": label,
                         "rows": result["rows"], "cols": result["cols"],
                         "cells": result["cells"]})
    except Exception:
        pass
    return result


@app.get("/grid/preview/{label}.png")
async def grid_preview(label: str, cols: int = 50, rows: int = 30):
    """Debug overlay: warped sheet with detected fills painted on top."""
    cam = cams_by_label.get(label)
    if cam is None:
        return Response(status_code=404)
    frame = cam.read()
    if frame is None:
        return Response(status_code=503)
    from .grid_capture import scan_grid, render_overlay
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, scan_grid, frame, cols, rows)
    if result is None:
        return Response(status_code=422)
    img = await loop.run_in_executor(None, render_overlay, frame, result)
    if img is None:
        return Response(status_code=500)
    ok, buf = cv2.imencode(".png", img)
    return Response(content=buf.tobytes() if ok else b"", media_type="image/png",
                    headers={"Cache-Control": "no-store"})


@app.get("/preview/{label}.jpg")
async def preview_jpg(label: str):
    """Single JPEG snapshot of the named camera (with green detection bbox)."""
    cam = cams_by_label.get(label)
    if cam is None:
        log.debug("preview snapshot 404: unknown label %r", label)
        return Response(status_code=404)
    frame = cam.read()
    if frame is None:
        return Response(status_code=503)
    bb = last_quad_by_label.get(label)
    jpg = await asyncio.get_event_loop().run_in_executor(None, _encode_preview, frame, bb)
    if jpg is None:
        return Response(status_code=500)
    return Response(content=jpg, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@app.get("/preview/{label}.mjpg")
async def preview_mjpg(label: str):
    """Multipart JPEG live stream backed by the shared producer."""
    cam = cams_by_label.get(label)
    if cam is None:
        log.debug("mjpg 404: unknown label %r", label)
        return Response(status_code=404)
    _ensure_producer(label, cam)
    log.info("mjpg consumer attached: %s", label)

    async def gen():
        boundary = b"--frame\r\n"
        last_seq = -1
        last_send = 0.0
        try:
            while True:
                loop = asyncio.get_event_loop()
                seq = _jpeg_seq.get(label, 0)
                jpg = _jpeg_cache.get(label)
                if jpg is None or seq == last_seq:
                    await asyncio.sleep(0.01)
                    continue
                last_seq = seq
                last_send = loop.time()
                yield (
                    boundary
                    + b"Content-Type: image/jpeg\r\nContent-Length: "
                    + str(len(jpg)).encode()
                    + b"\r\n\r\n"
                    + jpg
                    + b"\r\n"
                )
        except (asyncio.CancelledError, GeneratorExit):
            log.info("mjpg consumer detached: %s", label)
            return

    return StreamingResponse(gen(), media_type="multipart/x-mixed-replace; boundary=frame")


# --------------------------------------------------------------------------
# WebSocket — primary event bus
# --------------------------------------------------------------------------
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    clients.add(ws)
    log.info("ws connected (peers=%d)", len(clients))
    try:
        items = await db.list_active()
        await ws.send_text(json.dumps({
            "type": "drawings_list",
            "items": [
                {"id": it["id"],
                 "url": f"http://127.0.0.1:{SETTINGS.http_port}/drawings/{it['id']}.png",
                 "palette": it["palette"]}
                for it in items
            ],
        }))
        log.debug("sent drawings_list to new client (n=%d)", len(items))
        while True:
            text = await ws.receive_text()
            try:
                msg = json.loads(text)
            except Exception:
                log.warning("ws bad payload: %r", text[:120])
                continue
            log.debug("ws recv %s", msg.get("type"))
            await handle_client_msg(msg)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.warning("ws loop error: %s", e)
    finally:
        clients.discard(ws)
        log.info("ws disconnected (peers=%d)", len(clients))


async def handle_client_msg(msg: dict) -> None:
    """Dispatch admin/tablet commands coming over the websocket."""
    t = msg.get("type")
    if t == "admin:delete":
        ids = msg.get("ids", [])
        log.info("admin: delete %d drawings", len(ids))
        await db.soft_delete(ids)
        await broadcast({"type": "admin:deleted", "ids": ids})
    elif t == "admin:delete_oldest":
        n = int(msg.get("n", 10))
        log.info("admin: delete oldest %d", n)
        ids = await db.soft_delete_oldest(n)
        await broadcast({"type": "admin:deleted", "ids": ids})
    elif t == "admin:set_game":
        log.info("admin: set_game -> %s", msg.get("game"))
        await broadcast({"type": "set_game", "game": msg.get("game", "world")})
    elif t == "admin:set_settings":
        log.info("admin: set_settings patch=%s", msg.get("patch"))
        for k, v in msg.get("patch", {}).items():
            if hasattr(SETTINGS, k):
                setattr(SETTINGS, k, v)
        save_settings(SETTINGS)
        # Apply mirror toggles live to the already-open cameras.
        if "front" in cams_by_label:
            cams_by_label["front"].mirror = bool(SETTINGS.mirror_front)
        if "overhead" in cams_by_label:
            cams_by_label["overhead"].mirror = bool(SETTINGS.mirror_overhead)
        await broadcast({"type": "settings", "settings": SETTINGS.model_dump()})
    elif t == "tablet:shape":
        log.info("tablet shape -> %s", msg.get("shape"))
        await broadcast({"type": "shape_command", "shape": msg.get("shape")})
    else:
        log.debug("ws unhandled type=%r", t)


def main():
    log.info("uvicorn launching on %s:%d", SETTINGS.ws_host, SETTINGS.http_port)
    uvicorn.run("service.main:app", host=SETTINGS.ws_host, port=SETTINGS.http_port, log_level="info")


if __name__ == "__main__":
    main()
