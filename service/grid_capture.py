"""Grid sheet scanner.

Uses the existing 4-corner + orientation-marker detection (``scan.py``)
to locate the grid sheet, warps it flat, then samples each of the inner
``cols x rows`` cells. Each cell is reported as either empty (white
paper) or filled with the dominant non-white colour found in its centre.
"""
from __future__ import annotations

import logging

import cv2
import numpy as np

from .scan import find_paper_quad, warp

log = logging.getLogger("service.grid_capture")


def _cell_color(cell: np.ndarray, sat_thresh: int = 35, dark_v: int = 100) -> tuple[bool, str]:
    """Return (filled, hex_color) for a cell ROI in BGR.

    Classifies the cell into one of three buckets:
      * white / empty paper  → (False, "#ffffff")
      * predominantly dark   → (True, "#000000")     ← snap to pure black
      * coloured             → (True, "#rrggbb")     ← median of coloured pixels
    Two-bucket fill detection: a pixel is "filled" if it's either saturated
    (S ≥ sat_thresh) or dark (V ≤ dark_v with low saturation).
    """
    if cell.size == 0:
        return False, "#ffffff"
    hsv = cv2.cvtColor(cell, cv2.COLOR_BGR2HSV)
    s = hsv[..., 1]
    v = hsv[..., 2]
    coloured = s >= sat_thresh
    dark = (~coloured) & (v <= dark_v)
    fill = coloured | dark
    ratio = float(fill.mean())
    if ratio < 0.20:
        return False, "#ffffff"
    if int(dark.sum()) > int(coloured.sum()):
        return True, "#000000"
    fp = cell[coloured]
    if fp.size == 0:
        return True, "#000000"
    med = np.median(fp.reshape(-1, 3), axis=0)
    b, g, r = [int(round(x)) for x in med]
    return True, f"#{r:02x}{g:02x}{b:02x}"


def is_grid_sheet(warped: np.ndarray, min_zones: int = 3) -> bool:
    """Look for circular markers in the top / left / right edge zones.

    A printed grid sheet has 3 black filled circles, one centred on each
    of those edges, *between* the corner squares. A drawing sheet has
    none. We threshold the sheet, scan blob contours, and count how many
    of the 3 expected zones contain a sufficiently circular blob of the
    right size. ≥ ``min_zones`` of 3 → grid.
    """
    if warped.size == 0:
        return False
    H, W = warped.shape[:2]
    gray = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY) if warped.ndim == 3 else warped
    blurred = cv2.GaussianBlur(gray, (3, 3), 0)
    _, th = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    cnts, _ = cv2.findContours(th, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)

    img_area = H * W
    # Circle on the printed sheet is ~9 mm on a 297 mm sheet → diameter ≈ 3 %
    # of long side → area ≈ (π/4)·0.03² ≈ 7e-4 of sheet area. Allow generously.
    min_a = img_area * 5e-5
    max_a = img_area * 5e-3

    cx_mid, cy_mid = W / 2.0, H / 2.0
    edge_band = max(W, H) * 0.13  # how close to an edge the blob must be
    centre_tol = max(W, H) * 0.20  # how close to the mid-axis

    found = {"top": False, "bottom": False, "left": False, "right": False}
    for c in cnts:
        a = cv2.contourArea(c)
        if a < min_a or a > max_a:
            continue
        peri = cv2.arcLength(c, True)
        if peri <= 0:
            continue
        circularity = 4.0 * np.pi * a / (peri * peri)
        if circularity < 0.55:  # circles ~0.95, squares ~0.78 (orient marker)
            continue
        x, y, w, h = cv2.boundingRect(c)
        bx, by = x + w / 2.0, y + h / 2.0
        if not found["top"] and by < edge_band and abs(bx - cx_mid) < centre_tol:
            found["top"] = True
        elif not found["bottom"] and by > H - edge_band and abs(bx - cx_mid) < centre_tol:
            found["bottom"] = True
        elif not found["left"] and bx < edge_band and abs(by - cy_mid) < centre_tol:
            found["left"] = True
        elif not found["right"] and bx > W - edge_band and abs(by - cy_mid) < centre_tol:
            found["right"] = True

    hits = sum(found.values())
    log.info("is_grid_sheet: edge markers %s (%d/4)", found, hits)
    return hits >= min_zones


def _is_grid_sheet_legacy(warped: np.ndarray, min_circles: int = 2) -> bool:
    """Return True if the warped sheet looks like a grid (≥``min_circles``
    of the 4 mid-side circle markers are visible).

    Drawing sheets have NO circle markers, only corner squares + a single
    bottom orientation square — so this gives a clean 1-bit discriminator.
    """
    if warped.size == 0:
        return False
    H, W = warped.shape[:2]
    gray = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY) if warped.ndim == 3 else warped
    # Probe a small square at each expected mid-side circle position.
    # Probe size ≈ corner-marker thickness; use ~5% of long side so a
    # 9 mm circle on a 297 mm sheet (~3% of long side) is comfortably
    # inside the probe window.
    p = max(12, int(max(H, W) * 0.05))
    # Mid-side anchors are roughly on the warp boundary (warp goes
    # corner-centre to corner-centre). The circles sit just inside the
    # corner-marker band, so probe a bit inset from the edge.
    inset = max(6, int(max(H, W) * 0.025))
    cx, cy = W // 2, H // 2
    anchors = [
        (cx, inset + p // 2),                   # top
        (cx, H - inset - p // 2),               # bottom
        (inset + p // 2, cy),                   # left
        (W - inset - p // 2, cy),               # right
    ]
    hits = 0
    for ax, ay in anchors:
        x0 = max(0, ax - p)
        y0 = max(0, ay - p)
        x1 = min(W, ax + p)
        y1 = min(H, ay + p)
        roi = gray[y0:y1, x0:x1]
        if roi.size == 0:
            continue
        # A circle / square marker means a noticeable dark fraction in the probe.
        dark_ratio = float((roi < 110).mean())
        if dark_ratio > 0.06:
            hits += 1
    log.debug("is_grid_sheet: %d/4 mid-side circle hits", hits)
    return hits >= min_circles


def scan_grid_from_warped(
    flat: np.ndarray,
    cols: int = 50,
    rows: int = 30,
    sample_inset: float = 0.18,
) -> dict | None:
    """Sample cells on an already-warped sheet. Use this from the pipeline
    when the warp has already been computed."""
    H, W = flat.shape[:2]
    # Force the warped sheet to match the grid aspect (landscape grid →
    # landscape warp). The corner-detector occasionally returns a 90°
    # rotated quad order; we recover by transposing here.
    want_landscape = cols > rows
    is_landscape = W > H
    if want_landscape != is_landscape:
        flat = cv2.rotate(flat, cv2.ROTATE_90_CLOCKWISE)
        H, W = flat.shape[:2]
        log.info("scan_grid_from_warped: rotated 90° to match grid aspect")

    # The warp output spans the corner-marker centres, so the grid area
    # is inset by roughly one marker half-width on every side. Approximate
    # that by trimming a fixed fraction; tuned to match grid_template's
    # corner / margin sizes.
    # Trim enough off each edge to skip the corner-marker band AND the
    # mid-side circles (which sit on the warp boundary). On a 297mm sheet
    # with 13mm corners + 9mm circles, the markers occupy ~6.5mm into the
    # warp on every side; we trim a generous ~5% to be safe.
    trim_x = int(W * 0.050)
    trim_y = int(H * 0.050)
    inner = flat[trim_y:H - trim_y, trim_x:W - trim_x]
    ih, iw = inner.shape[:2]
    if ih < rows * 4 or iw < cols * 4:
        log.warning("scan_grid: warped area too small (%dx%d) for %dx%d grid", iw, ih, cols, rows)
        return None

    cells: list[list[dict]] = []
    cw = iw / cols
    ch = ih / rows
    pad_x = max(1, int(cw * sample_inset))
    pad_y = max(1, int(ch * sample_inset))
    for r in range(rows):
        row: list[dict] = []
        y0 = int(r * ch) + pad_y
        y1 = int((r + 1) * ch) - pad_y
        for c in range(cols):
            x0 = int(c * cw) + pad_x
            x1 = int((c + 1) * cw) - pad_x
            roi = inner[max(0, y0):max(y0 + 1, y1), max(0, x0):max(x0 + 1, x1)]
            filled, hexcol = _cell_color(roi)
            row.append({"filled": filled, "hex": hexcol})
        cells.append(row)

    return {
        "rows": rows,
        "cols": cols,
        "warped_shape": [iw, ih],
        "cells": cells,
    }


def scan_grid(
    frame: np.ndarray,
    cols: int = 50,
    rows: int = 30,
    sample_inset: float = 0.25,
    paper_min_area_ratio: float = 0.05,
) -> dict | None:
    """Detect, warp, then sample. Returns None if no sheet visible."""
    quad = find_paper_quad(frame, paper_min_area_ratio)
    if quad is None:
        log.debug("scan_grid: no quad")
        return None
    flat = warp(frame, quad, target_long_side=1800)
    return scan_grid_from_warped(flat, cols, rows, sample_inset)


def render_overlay(frame: np.ndarray, result: dict) -> np.ndarray | None:
    """Annotate the warped sheet with the detected fills (debug PNG)."""
    quad = find_paper_quad(frame, 0.05)
    if quad is None:
        return None
    flat = warp(frame, quad, target_long_side=1800)
    H, W = flat.shape[:2]
    # Trim enough off each edge to skip the corner-marker band AND the
    # mid-side circles (which sit on the warp boundary). On a 297mm sheet
    # with 13mm corners + 9mm circles, the markers occupy ~6.5mm into the
    # warp on every side; we trim a generous ~5% to be safe.
    trim_x = int(W * 0.050)
    trim_y = int(H * 0.050)
    cols = result["cols"]
    rows = result["rows"]
    iw = W - 2 * trim_x
    ih = H - 2 * trim_y
    cw = iw / cols
    ch = ih / rows
    overlay = flat.copy()
    for r in range(rows):
        for c in range(cols):
            cell = result["cells"][r][c]
            if not cell["filled"]:
                continue
            hx = cell["hex"].lstrip("#")
            rr, gg, bb = int(hx[0:2], 16), int(hx[2:4], 16), int(hx[4:6], 16)
            x0 = trim_x + int(c * cw)
            y0 = trim_y + int(r * ch)
            x1 = trim_x + int((c + 1) * cw)
            y1 = trim_y + int((r + 1) * ch)
            cv2.rectangle(overlay, (x0, y0), (x1, y1), (bb, gg, rr), -1)
    return cv2.addWeighted(flat, 0.4, overlay, 0.6, 0)
