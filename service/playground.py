"""Realtime parameter playground.

Serves an HTML page (mounted at ``/playground/``) with sliders that drive
the live capture pipeline:

  * detection params       (paper_min_area_ratio, stability_frames)
  * bg-removal params      (block_size, C, min_speckle_area, feather)
  * adaptive-detector inset (corner crop %)

The page polls two endpoints to render a side-by-side comparison:

  * ``/playground/raw.jpg``     — raw warped sheet (no bg removal)
  * ``/playground/processed.png`` — same frame after bg removal with the
    parameters currently in the sliders (transparent paper)

A POST to ``/playground/save`` writes the current values back into
``settings.json`` so they are picked up on next capture.
"""
import logging
from typing import Optional

import cv2
import numpy as np
from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

from .bg_remove import threshold_remove
from .scan import find_paper_quad, warp

log = logging.getLogger("service.playground")
router = APIRouter()


def _grab_warped(cams_by_label: dict, label: str, min_area_ratio: float, inset_pct: float):
    """Return (raw_bgr, warped_bgr_or_None, quad_or_None) from camera ``label``."""
    cam = cams_by_label.get(label)
    if cam is None:
        return None, None, None
    frame = cam.read()
    if frame is None:
        return None, None, None
    quad = find_paper_quad(frame, min_area_ratio)
    warped = None
    if quad is not None:
        try:
            w = warp(frame, quad)
            ih, iw = w.shape[:2]
            ix = max(2, int(iw * inset_pct))
            iy = max(2, int(ih * inset_pct))
            w = w[iy:ih - iy, ix:iw - ix]
            if w.size > 0:
                warped = w
        except Exception as e:
            log.warning("playground warp failed: %s", e)
    return frame, warped, quad


def install(app, cams_by_label, settings, save_settings):
    """Register dynamic playground routes, then mount the static page.

    IMPORTANT: routes must be added BEFORE the StaticFiles mount, otherwise
    the mount matches first for every ``/playground/*`` path and shadows
    the dynamic endpoints with a 404.
    """
    from fastapi.staticfiles import StaticFiles
    from .config import ROOT

    @app.get("/playground/raw.jpg")
    async def raw_jpg(cam: str = "overhead", min_area: float = 0.05, inset: float = 0.06):
        _, warped, _ = _grab_warped(cams_by_label, cam, min_area, inset)
        target = warped if warped is not None else cams_by_label.get(cam) and cams_by_label[cam].read()
        if target is None or target.size == 0:
            return Response(status_code=503)
        ok, buf = cv2.imencode(".jpg", target, [cv2.IMWRITE_JPEG_QUALITY, 80])
        if not ok:
            return Response(status_code=500)
        return Response(content=buf.tobytes(), media_type="image/jpeg",
                        headers={"Cache-Control": "no-store"})

    @app.get("/playground/processed.png")
    async def processed_png(
        cam: str = "overhead",
        min_area: float = 0.05,
        inset: float = 0.06,
        block_size: int = 41,
        C: int = 12,
        speckle: int = 8,
        feather: int = 1,
    ):
        _, warped, _ = _grab_warped(cams_by_label, cam, min_area, inset)
        if warped is None:
            return Response(status_code=204)
        try:
            rgba = threshold_remove(
                warped,
                block_size=int(block_size),
                C=int(C),
                min_speckle_area=int(speckle),
                feather=int(feather),
            )
        except Exception as e:
            log.warning("playground bg_remove failed: %s", e)
            return Response(status_code=500)
        bgra = cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA)
        ok, buf = cv2.imencode(".png", bgra)
        if not ok:
            return Response(status_code=500)
        return Response(content=buf.tobytes(), media_type="image/png",
                        headers={"Cache-Control": "no-store"})

    @app.get("/playground/state")
    async def state():
        return {
            "cameras": list(cams_by_label.keys()),
            "settings": settings.model_dump(),
        }

    @app.post("/playground/save")
    async def save(req: Request):
        patch = await req.json()
        log.info("playground save -> %s", patch)
        for k, v in patch.items():
            if hasattr(settings, k):
                setattr(settings, k, v)
        save_settings(settings)
        return JSONResponse({"ok": True, "settings": settings.model_dump()})

    # NOTE: must be the LAST step — adding the StaticFiles mount earlier would
    # cause it to swallow every /playground/* path and 404 the routes above.
    app.mount(
        "/playground",
        StaticFiles(directory=str(ROOT / "service" / "playground_static"), html=True),
        name="playground",
    )
