"""Printable grid sheet.

Layout (landscape A4 by default):
    [#]  o  ......... o  [#]
     o   .  GRID70x50  .   o
    [#]  o  .....[s]... o  [#]

Corners are solid black squares (same as the drawing sheet), so
``scan.find_paper_quad`` detects them out of the box. The 4 mid-side
circles are decorative (extra alignment cues for the user; the detector
ignores non-square candidates). The bottom-edge small black square is
the orientation marker used by ``scan._orient_with_marker``.
"""
from __future__ import annotations

import cv2
import numpy as np


def make_grid_sheet(
    width_mm: int = 297,
    height_mm: int = 210,
    cols: int = 50,
    rows: int = 30,
    marker_mm: int = 13,
    circle_mm: int = 9,
    orient_mm: int = 9,
    dpi: int = 200,
    margin_mm: int = 10,
    grid_line_rgb: tuple[int, int, int] = (210, 210, 210),
) -> np.ndarray:
    """Return the grid sheet as an RGB ndarray ready for PNG encoding.

    The inner grid sits between the 4 corner markers; cells are square-ish
    but the function keeps the requested cols×rows even if the aspect ratio
    of the inner area doesn't perfectly match.
    """
    px_per_mm = dpi / 25.4
    W = int(width_mm * px_per_mm)
    H = int(height_mm * px_per_mm)
    M = int(marker_mm * px_per_mm)
    R = int(circle_mm * px_per_mm / 2)
    OS = int(orient_mm * px_per_mm)
    pad = int(margin_mm * px_per_mm)

    img = np.full((H, W, 3), 255, np.uint8)

    # 4 corner squares
    cv2.rectangle(img, (pad, pad), (pad + M, pad + M), (0, 0, 0), -1)
    cv2.rectangle(img, (W - pad - M, pad), (W - pad, pad + M), (0, 0, 0), -1)
    cv2.rectangle(img, (pad, H - pad - M), (pad + M, H - pad), (0, 0, 0), -1)
    cv2.rectangle(img, (W - pad - M, H - pad - M), (W - pad, H - pad), (0, 0, 0), -1)

    # 3 mid-side circles (top / left / right) — bottom slot holds the
    # orientation square instead.
    midx = W // 2
    midy = H // 2
    cv2.circle(img, (midx, pad + M // 2), R, (0, 0, 0), -1)        # top
    cv2.circle(img, (pad + M // 2, midy), R, (0, 0, 0), -1)        # left
    cv2.circle(img, (W - pad - M // 2, midy), R, (0, 0, 0), -1)    # right

    # Bottom orientation square — smaller than the corners, sits in the
    # bottom corner-marker band (NOT inside the grid area).
    ox = midx - OS // 2
    oy = (H - pad - M) + (M - OS) // 2  # vertically centered in bottom band
    cv2.rectangle(img, (ox, oy), (ox + OS, oy + OS), (0, 0, 0), -1)

    # Inner grid bounds = inside corner markers
    gx0 = pad + M
    gy0 = pad + M
    gx1 = W - pad - M
    gy1 = H - pad - M
    gw = gx1 - gx0
    gh = gy1 - gy0

    # Grid lines (light gray, 1 px)
    for c in range(cols + 1):
        x = gx0 + int(round(c * gw / cols))
        cv2.line(img, (x, gy0), (x, gy1), grid_line_rgb, 1)
    for r in range(rows + 1):
        y = gy0 + int(round(r * gh / rows))
        cv2.line(img, (gx0, y), (gx1, y), grid_line_rgb, 1)

    return img
