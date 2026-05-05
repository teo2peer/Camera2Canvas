"""Per-camera capture pipeline.

One ``CapturePipeline`` runs in a long-lived asyncio task per camera. Each
iteration of ``run()``:

  1. Grab the latest frame (no blocking — camera reader is its own thread).
  2. Detect the marker sheet (4 black corner squares) — runs in an executor
     so heavy OpenCV work doesn't block the event loop.
  3. Run hand tracking + emit gesture events.
  4. Decide whether to capture, based on three independent triggers:
       * **auto**          — sheet stable for N frames
       * **gesture**       — thumbs-up confirmed for N consecutive frames
       * **Arduino button** — set externally via ``button_pending``
  5. On capture: warp the inner rectangle, crop the marker corners,
     remove background, extract palette, save PNG + thumb + DB row,
     and broadcast ``drawing_captured``.

Any exception inside the loop is caught and logged: the pipeline must
**never** crash, since the digitization station is the user-visible heart
of the installation.
"""
import asyncio
import logging
import time
import traceback
import uuid

import cv2
import numpy as np
from PIL import Image

from . import db
from .bg_remove import ml_remove, threshold_remove
from .camera import CameraSource
from .config import DRAW_DIR, THUMB_DIR, Settings
from .grid_capture import is_grid_sheet, scan_grid_from_warped
from .hands import HandTracker
from .palette import extract_palette
from .scan import StabilityTracker, find_paper_quad, warp

log = logging.getLogger("service.pipeline")


class CapturePipeline:
    def __init__(self, settings: Settings, broadcast):
        self.settings = settings
        self.broadcast = broadcast            # async fn(dict) — push event to clients
        self.stab = StabilityTracker(frames_required=settings.stability_frames)
        self.hands = HandTracker(sensitivity=settings.gesture_sensitivity)
        self.cooldown_until = 0.0             # epoch s; capture suppressed until this time
        self.armed_quad: np.ndarray | None = None  # remembered quad for gesture-confirm
        self.thumbs_streak = 0
        self.thumbs_required = 3              # consecutive frames of thumbs_up to confirm
        self.button_pending = False           # set true by Arduino button reader
        log.info(
            "CapturePipeline init: trigger=%s bg=%s stability_frames=%d hands_ok=%s",
            settings.scan_trigger, settings.bg_removal,
            settings.stability_frames, self.hands.ok,
        )

    # ------------------------------------------------------------------
    async def run(self, cam: CameraSource, source: str):
        """Main loop. ``source`` is the camera label (overhead/front)."""
        log.info("pipeline[%s] starting", source)
        loop = asyncio.get_event_loop()
        target_dt = 1 / 20  # cap at 20 fps to share CPU with MJPEG encoder
        had_quad_last = False
        while True:
            try:
                t0 = loop.time()
                frame = cam.read()
                if frame is None:
                    await asyncio.sleep(0.05)
                    continue
                now = time.time()

                # --- 1. paper-marker detection ---------------------------
                try:
                    quad = await loop.run_in_executor(
                        None, find_paper_quad, frame, self.settings.paper_min_area_ratio
                    )
                except Exception as e:
                    log.warning("paper detect failed: %s", e)
                    quad = None
                stable = self.stab.update(quad)
                if quad is not None and not had_quad_last:
                    log.debug("pipeline[%s] sheet ENTERED frame", source)
                    had_quad_last = True
                elif quad is None and had_quad_last:
                    log.debug("pipeline[%s] sheet LEFT frame", source)
                    had_quad_last = False

                # --- 2. hands & gestures ---------------------------------
                hands_out: list[dict] = []
                if self.hands.ok:
                    try:
                        hands_out = await loop.run_in_executor(None, self.hands.process, frame)
                    except Exception as e:
                        log.warning("hand process failed: %s", e)
                    for h in hands_out:
                        if h.get("gesture") not in (None, "unknown"):
                            log.debug("hand %s gesture=%s", h["hand"], h["gesture"])
                        try:
                            await self.broadcast({"type": "hand_gesture", **h})
                        except Exception:
                            pass

                # --- 3. broadcast detection bbox so UI can show overlay --
                if quad is not None:
                    try:
                        bb = [int(quad[:, 0].min()), int(quad[:, 1].min()),
                              int(quad[:, 0].max()), int(quad[:, 1].max())]
                        progress = min(1.0, self.stab.count / max(1, self.stab.required))
                        await self.broadcast({
                            "type": "drawing_detected",
                            "bbox": bb,
                            "progress": progress,
                        })
                    except Exception:
                        pass

                # Suppress firing during cool-down (right after a capture).
                if now < self.cooldown_until:
                    await asyncio.sleep(0.03)
                    continue

                # --- 4. trigger decisions --------------------------------
                trigger = self.settings.scan_trigger
                should_capture = False

                if trigger in ("auto", "auto+gesture") and stable and quad is not None:
                    if trigger == "auto":
                        should_capture = True
                        log.info("pipeline[%s] AUTO trigger fired (stability)", source)
                    else:
                        # In hybrid mode, just remember the quad for the gesture branch.
                        self.armed_quad = quad

                # Gesture confirmation requires N consecutive frames.
                gestures = {h["gesture"] for h in hands_out}
                if "thumbs_up" in gestures:
                    self.thumbs_streak += 1
                else:
                    self.thumbs_streak = 0
                if trigger in ("gesture", "auto+gesture"):
                    if self.thumbs_streak >= self.thumbs_required and quad is not None:
                        should_capture = True
                        self.thumbs_streak = 0
                        log.info("pipeline[%s] GESTURE trigger fired (thumbs_up)", source)

                # Arduino button always works regardless of trigger mode.
                if self.button_pending and quad is not None:
                    should_capture = True
                    self.button_pending = False
                    log.info("pipeline[%s] BUTTON trigger fired", source)
                elif self.button_pending and quad is None:
                    log.debug("pipeline[%s] button pressed but no sheet visible — ignoring", source)
                    self.button_pending = False

                # --- 5. capture ------------------------------------------
                if should_capture:
                    q = self.armed_quad if self.armed_quad is not None else quad
                    self.armed_quad = None
                    self.stab.reset()
                    self.cooldown_until = now + 2.5
                    try:
                        await self._capture(frame, q, source)
                    except Exception as e:
                        log.error("capture failed: %s\n%s", e, traceback.format_exc())
                        try:
                            await self.broadcast({"type": "capture_error", "error": str(e)})
                        except Exception:
                            pass
                        # Never let the loop die — keep the scanner alive.
                        self.cooldown_until = time.time() + 1.0

                # --- 6. pace -------------------------------------------
                elapsed = loop.time() - t0
                if elapsed < target_dt:
                    await asyncio.sleep(target_dt - elapsed)
                else:
                    await asyncio.sleep(0)
            except asyncio.CancelledError:
                log.info("pipeline[%s] cancelled", source)
                raise
            except Exception as e:
                log.error("pipeline[%s] loop error: %s\n%s", source, e, traceback.format_exc())
                await asyncio.sleep(0.2)

    # ------------------------------------------------------------------
    async def _capture(self, frame: np.ndarray, quad: np.ndarray, source: str):
        """Warp → crop → bg-remove → palette → save → broadcast.

        Each stage has a graceful fallback so a single failure doesn't
        abort the capture (a slightly worse drawing is still better than
        the user seeing nothing happen).
        """
        log.info("[capture] start (source=%s)", source)
        loop = asyncio.get_event_loop()

        # 1. perspective warp; bbox crop fallback
        warped_full = None
        try:
            warped_full = await loop.run_in_executor(None, warp, frame, quad)
            if warped_full is None or warped_full.size == 0:
                raise ValueError("empty warp")
            ih, iw = warped_full.shape[:2]
            inset_pct = float(getattr(self.settings, "paper_inset", 0.06))
            ins_x = max(2, int(iw * inset_pct))
            ins_y = max(2, int(ih * inset_pct))
            warped = warped_full[ins_y:ih - ins_y, ins_x:iw - ins_x]
            if warped.size == 0:
                raise ValueError("empty after inset")
            log.debug("[capture] warped+inset shape=%s", warped.shape)
        except Exception as e:
            log.warning("[capture] warp failed (%s); falling back to bbox crop", e)
            x1, y1 = int(quad[:, 0].min()), int(quad[:, 1].min())
            x2, y2 = int(quad[:, 0].max()), int(quad[:, 1].max())
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(frame.shape[1], x2), min(frame.shape[0], y2)
            warped = frame[y1:y2, x1:x2].copy()
            if warped.size == 0:
                warped = frame.copy()
            warped_full = warped

        # 2a. grid sheet branch — must run on the FULL warp (mid-side circles
        # sit on the very edge of the warped output, the inset would crop them).
        try:
            if is_grid_sheet(warped_full):
                log.info("[capture] detected GRID sheet")
                grid_cols = int(getattr(self.settings, "grid_cols", 50))
                grid_rows = int(getattr(self.settings, "grid_rows", 30))
                try:
                    await self.broadcast({
                        "type": "grid_scanning",
                        "source": source,
                        "rows": grid_rows,
                        "cols": grid_cols,
                    })
                except Exception:
                    pass
                result = await loop.run_in_executor(
                    None, scan_grid_from_warped, warped_full, grid_cols, grid_rows
                )
                if result is not None:
                    await self.broadcast({
                        "type": "grid_scanned",
                        "source": source,
                        "rows": result["rows"],
                        "cols": result["cols"],
                        "cells": result["cells"],
                    })
                    log.info("[capture] grid_scanned %dx%d", result["cols"], result["rows"])
                    # Cooldown until LED travel finishes and mosaic appears
                    # on screen. After that, new scans are allowed even while
                    # the mosaic is still displayed.
                    self.cooldown_until = time.time() + 4.0
                    return
                log.warning("[capture] is_grid_sheet=True but scan failed; falling through to drawing path")
        except Exception as e:
            log.warning("[capture] grid branch error (%s); falling through to drawing path", e)

        # 2b. background removal (drawing branch)
        try:
            if self.settings.bg_removal == "ml":
                rgba = await loop.run_in_executor(None, ml_remove, warped)
            else:
                s = self.settings
                rgba = await loop.run_in_executor(
                    None, lambda: threshold_remove(
                        warped,
                        block_size=int(getattr(s, "bg_block_size", 41)),
                        C=int(getattr(s, "bg_C", 12)),
                        min_speckle_area=int(getattr(s, "bg_speckle", 8)),
                        feather=int(getattr(s, "bg_feather", 1)),
                    )
                )
            log.debug("[capture] bg_removal=%s shape=%s", self.settings.bg_removal, rgba.shape)
        except Exception as e:
            log.warning("[capture] bg removal failed (%s); using opaque", e)
            rgb = cv2.cvtColor(warped, cv2.COLOR_BGR2RGB)
            alpha = np.full(rgb.shape[:2], 255, np.uint8)
            rgba = np.dstack([rgb, alpha])

        # 3. dominant colors
        try:
            palette = extract_palette(rgba, k=5)
            log.debug("[capture] palette=%s", palette)
        except Exception as e:
            log.warning("[capture] palette failed (%s); using neutral", e)
            palette = ["#888888"] * 5

        # 4. persist
        rid = uuid.uuid4().hex[:12]
        png_path = DRAW_DIR / f"{rid}.png"
        thumb_path = THUMB_DIR / f"{rid}.png"
        Image.fromarray(rgba, "RGBA").save(png_path, "PNG")
        log.info("[capture] saved %s", png_path)

        try:
            h, w = rgba.shape[:2]
            scale = 256 / max(1, w)
            tw, th = max(1, int(w * scale)), max(1, int(h * scale))
            Image.fromarray(rgba, "RGBA").resize((tw, th), Image.LANCZOS).save(thumb_path, "PNG")
        except Exception as e:
            log.warning("[capture] thumb failed (%s); reusing full png", e)
            thumb_path = png_path

        try:
            await db.add_drawing({
                "id": rid,
                "palette": palette,
                "file_path": str(png_path),
                "thumb_path": str(thumb_path),
                "width": rgba.shape[1],
                "height": rgba.shape[0],
                "source": source,
            })
        except Exception as e:
            log.error("[capture] db insert failed: %s — drawing kept on disk at %s", e, png_path)

        # 5. notify clients
        try:
            await self.broadcast({
                "type": "drawing_captured",
                "id": rid,
                "url": f"http://127.0.0.1:{self.settings.http_port}/drawings/{rid}.png",
                "palette": palette,
                "w": rgba.shape[1],
                "h": rgba.shape[0],
                "source": source,
            })
        except Exception as e:
            log.error("[capture] broadcast failed: %s", e)
        log.info("[capture] done id=%s", rid)
