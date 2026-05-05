"""Background removal.

For a marker/pen drawing on a white sheet the cleanest approach is to find
the ink mask (dark pixels) and use that as the alpha channel directly.
Everything that isn't ink — including white pixels enclosed by strokes —
becomes transparent in one shot.

Strategy (``threshold_remove``):
  1. Grayscale.
  2. Adaptive + Otsu threshold to find ink, robust to uneven lighting.
  3. Light morphological clean-up to drop speckles and seal pinholes inside
     thick strokes.
  4. Feather the mask 1 px so anti-aliased stroke edges look smooth instead
     of staircased.
  5. Use the mask as alpha; RGB stays untouched so coloured strokes keep
     their original colour.
"""
import logging

import cv2
import numpy as np

log = logging.getLogger("service.bg_remove")


def threshold_remove(
    bgr: np.ndarray,
    block_size: int = 41,         # adaptive-threshold neighbourhood (odd)
    C: int = 12,                  # adaptive-threshold bias; lower = more ink kept
    min_speckle_area: int = 8,    # contours smaller than this get dropped
    feather: int = 1,             # gaussian blur radius for smooth alpha edges
    preserve_interiors: bool = True,  # keep pixels enclosed by closed shapes
    seal_kernel: int = 3,         # MORPH_CLOSE kernel to bridge near-closed gaps
) -> np.ndarray:
    """Return RGBA. Ink + interior of any closed shape stays opaque; only
    pixels reachable from the image border (true background) become
    transparent."""
    if bgr.ndim == 2:
        bgr = cv2.cvtColor(bgr, cv2.COLOR_GRAY2BGR)
    h, w = bgr.shape[:2]

    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (3, 3), 0)

    bs = block_size if block_size % 2 == 1 else block_size + 1
    adapt = cv2.adaptiveThreshold(
        blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, bs, C
    )
    _, otsu = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    ink = cv2.bitwise_or(adapt, otsu)

    if min_speckle_area > 0:
        cnts, _ = cv2.findContours(ink, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        for c in cnts:
            if cv2.contourArea(c) < min_speckle_area:
                cv2.drawContours(ink, [c], -1, 0, -1)

    ink = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))

    mask = ink
    if preserve_interiors:
        # Use a slightly more aggressive close on a *copy* to bridge small
        # gaps in nearly-closed shapes for the flood-fill step only — we
        # don't want this thickening to leak into the actual alpha.
        k = max(3, seal_kernel) | 1
        sealed = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8))
        # Pad with non-ink so flood-fill from (0,0) reaches the true outside
        # even when ink touches the original border.
        padded = cv2.copyMakeBorder(sealed, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=0)
        ff = padded.copy()
        ffmask = np.zeros((padded.shape[0] + 2, padded.shape[1] + 2), np.uint8)
        cv2.floodFill(ff, ffmask, (0, 0), 255)
        # ff: ink=255 (orig), outside=255 (filled), enclosed=0
        enclosed = (ff[1:-1, 1:-1] == 0).astype(np.uint8) * 255
        mask = cv2.bitwise_or(ink, enclosed)

    if feather > 0:
        k = feather * 2 + 1
        alpha = cv2.GaussianBlur(mask, (k, k), 0)
    else:
        alpha = mask

    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    return np.dstack([rgb, alpha])


def ml_remove(bgr: np.ndarray) -> np.ndarray:
    """U2Net-based extraction. Falls back to threshold if rembg isn't installed."""
    try:
        from rembg import remove
    except ImportError:
        log.warning("rembg not installed; falling back to threshold_remove")
        return threshold_remove(bgr)
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    out = remove(rgb)
    if out.shape[2] == 3:
        out = np.dstack([out, np.full(out.shape[:2], 255, np.uint8)])
    return out
