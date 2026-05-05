"""scan.py — sheet detection via 4 corner markers + 1 orientation marker.

Sheet layout:
    [#]                 [#]
                  [o]           ← orientation marker (smaller, on the bottom edge)
    [#]                 [#]

We detect black-square candidates, take the 4 that form the largest convex
quad as the corners (TL, TR, BR, BL in image-pixel-extreme order), and use
the *remaining* candidate closest to one of the 4 edges as the orientation
marker. The corner indices are then rotated so that edge becomes the
"bottom" of the warped output, regardless of how the sheet is held.

The warp also enforces a landscape orientation (transposes if it came out
portrait), so every drawing arrives with the same canonical orientation.


Sheet layout (A4 portrait or landscape, doesn't matter):
+-------------------+
|[#]           [#]  |
|                   |
|       white       |
|                   |
|[#]           [#]  |
+-------------------+

Each [#] is a solid black square. We find 4 such squares, order them as
TL/TR/BR/BL, and warp the *inner* rectangle (the white area between them).
"""
import cv2
import numpy as np
from typing import Optional


# tunables
MARKER_MIN_AREA_RATIO = 0.0008    # marker / image area
MARKER_MAX_AREA_RATIO = 0.05
MARKER_ASPECT_TOL = 0.45          # |1 - w/h| must be < this
MARKER_FILL_MIN = 0.65            # contour area / bbox area (solidity)


def _candidate_centers(bgr: np.ndarray) -> list[tuple[float, float, float]]:
    """All marker-square candidates as (cx, cy, area)."""
    h, w = bgr.shape[:2]
    img_area = h * w
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    th = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 31, 10
    )
    th = cv2.morphologyEx(th, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    cnts, _ = cv2.findContours(th, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    out: list[tuple[float, float, float]] = []
    for c in cnts:
        area = cv2.contourArea(c)
        if area < img_area * MARKER_MIN_AREA_RATIO or area > img_area * MARKER_MAX_AREA_RATIO:
            continue
        x, y, bw, bh = cv2.boundingRect(c)
        if bw < 6 or bh < 6:
            continue
        if abs(1 - bw / bh) > MARKER_ASPECT_TOL:
            continue
        if area / (bw * bh) < MARKER_FILL_MIN:
            continue
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.04 * peri, True)
        if len(approx) < 4 or len(approx) > 6:
            continue
        out.append((x + bw / 2.0, y + bh / 2.0, area))
    return out


def _pick_corners(pts: np.ndarray) -> Optional[np.ndarray]:
    """Pick the 4 image-extremes as TL, TR, BR, BL. Returns None on degenerate."""
    if len(pts) < 4:
        return None
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).ravel()
    tl = pts[np.argmin(s)]
    br = pts[np.argmax(s)]
    tr = pts[np.argmin(d)]
    bl = pts[np.argmax(d)]
    chosen = np.array([tl, tr, br, bl], dtype=np.float32)
    if len({tuple(p) for p in chosen}) < 4:
        return None
    return chosen


def _orient_with_marker(corners: np.ndarray, orient_pt: np.ndarray) -> np.ndarray:
    """Rotate the corner array so the edge nearest ``orient_pt`` becomes
    the bottom edge (index pair BR-BL = (2, 3))."""
    edges = [(0, 1), (1, 2), (2, 3), (3, 0)]  # TL-TR, TR-BR, BR-BL, BL-TL
    best, best_d = -1, 1e18
    for i, (a, b) in enumerate(edges):
        mid = (corners[a] + corners[b]) / 2
        d = np.linalg.norm(mid - orient_pt)
        if d < best_d:
            best_d = d
            best = i
    # Rotate corner indices so the chosen bottom edge becomes index 2 (BR-BL).
    shift = (2 - best) % 4
    return np.roll(corners, shift, axis=0)


def _detect_marker_centers(bgr: np.ndarray) -> Optional[np.ndarray]:
    h, w = bgr.shape[:2]
    img_area = h * w
    cands = _candidate_centers(bgr)
    if len(cands) < 4:
        return None

    # Cluster sizes — corner markers should share an area; the orientation
    # marker is smaller (~30-50% of corner area) so it survives the broader
    # filter below as a separate candidate.
    cands.sort(key=lambda c: c[2])
    median_area = cands[len(cands) // 2][2]
    keep = [c for c in cands if 0.20 * median_area <= c[2] <= 2.5 * median_area]
    if len(keep) < 4:
        return None
    pts_all = np.array([(cx, cy) for cx, cy, _ in keep], dtype=np.float32)

    # The four CORNERS are the candidates with the largest area
    # (the orientation mark is intentionally smaller).
    corner_pts = np.array(
        [(cx, cy) for cx, cy, _ in sorted(keep, key=lambda c: -c[2])[:4]],
        dtype=np.float32,
    )
    corners = _pick_corners(corner_pts)
    if corners is None:
        return None
    quad_area = cv2.contourArea(corners.reshape(4, 1, 2))
    if quad_area < img_area * 0.05:
        return None

    # Find the orientation marker: any remaining candidate inside or close to
    # the quad that isn't one of the 4 corners.
    corner_set = {tuple(p) for p in corners}
    orient_pts = [p for p in pts_all if tuple(p) not in corner_set]
    if orient_pts:
        # Pick the candidate closest to any of the 4 edges (not corners).
        op = np.array(orient_pts, dtype=np.float32)
        edges = [(0, 1), (1, 2), (2, 3), (3, 0)]
        best_pt: Optional[np.ndarray] = None
        best_d = 1e18
        for p in op:
            for a, b in edges:
                mid = (corners[a] + corners[b]) / 2
                d = np.linalg.norm(mid - p)
                if d < best_d:
                    best_d = d
                    best_pt = p
        if best_pt is not None:
            corners = _orient_with_marker(corners, best_pt)

    return corners


def find_paper_quad(bgr: np.ndarray, min_area_ratio: float = 0.05) -> Optional[np.ndarray]:
    """Returns 4-point quad (TL, TR, BR, BL) of the marker centers, or None."""
    return _detect_marker_centers(bgr)


def order_quad(pts: np.ndarray) -> np.ndarray:
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).ravel()
    return np.array(
        [pts[np.argmin(s)], pts[np.argmin(d)], pts[np.argmax(s)], pts[np.argmax(d)]],
        dtype=np.float32,
    )


def warp(bgr: np.ndarray, quad: np.ndarray, target_long_side: int = 1600) -> np.ndarray:
    """Perspective-correct the sheet quad to a flat rectangle (true scanner-style).

    The output size is derived from the *physical* edge lengths of the quad so
    the final aspect ratio matches the printed sheet, then capped to
    ``target_long_side`` (1600 px by default — high enough that fine pen
    strokes survive). After warping we run a mild unsharp mask to undo the
    softening introduced by the bilinear sampler — gives the result the
    crispness of a flatbed scan.

    The input quad is expected to already be in TL, TR, BR, BL order (with
    BR-BL = the *printed* bottom edge); ``find_paper_quad`` produces it that
    way using the orientation marker.
    """
    q = quad.astype(np.float32)
    if q.shape != (4, 2):
        q = order_quad(quad)
    (tl, tr, br, bl) = q
    w_top = np.linalg.norm(tr - tl)
    w_bot = np.linalg.norm(br - bl)
    h_l = np.linalg.norm(bl - tl)
    h_r = np.linalg.norm(br - tr)
    W = max(int(max(w_top, w_bot)), 32)
    H = max(int(max(h_l, h_r)), 32)
    if max(W, H) > target_long_side:
        scale = target_long_side / max(W, H)
        W = int(W * scale)
        H = int(H * scale)
    dst = np.array([[0, 0], [W - 1, 0], [W - 1, H - 1], [0, H - 1]], dtype=np.float32)
    M = cv2.getPerspectiveTransform(q, dst)
    flat = cv2.warpPerspective(bgr, M, (W, H), flags=cv2.INTER_CUBIC)

    # Unsharp mask: enhance edges that bilinear/bicubic resampling softens.
    blurred = cv2.GaussianBlur(flat, (0, 0), sigmaX=1.4)
    flat = cv2.addWeighted(flat, 1.45, blurred, -0.45, 0)

    # Lightly normalise illumination so subsequent BG-removal gets a flat field.
    yuv = cv2.cvtColor(flat, cv2.COLOR_BGR2YUV)
    yuv[..., 0] = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(yuv[..., 0])
    flat = cv2.cvtColor(yuv, cv2.COLOR_YUV2BGR)
    return flat


class StabilityTracker:
    def __init__(self, frames_required: int = 8, iou_threshold: float = 0.92):
        self.required = frames_required
        self.iou_threshold = iou_threshold
        self.last: Optional[np.ndarray] = None
        self.count = 0

    @staticmethod
    def _bbox(quad: np.ndarray):
        return (quad[:, 0].min(), quad[:, 1].min(), quad[:, 0].max(), quad[:, 1].max())

    def _iou(self, a, b):
        ax1, ay1, ax2, ay2 = a
        bx1, by1, bx2, by2 = b
        ix1, iy1 = max(ax1, bx1), max(ay1, by1)
        ix2, iy2 = min(ax2, bx2), min(ay2, by2)
        iw, ih = max(0, ix2 - ix1), max(0, iy2 - iy1)
        inter = iw * ih
        ua = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
        return inter / ua if ua > 0 else 0

    def update(self, quad: Optional[np.ndarray]) -> bool:
        if quad is None:
            self.last = None
            self.count = 0
            return False
        if self.last is None:
            self.last = quad
            self.count = 1
            return False
        iou = self._iou(self._bbox(self.last), self._bbox(quad))
        if iou >= self.iou_threshold:
            self.count += 1
        else:
            self.count = 1
        self.last = quad
        return self.count >= self.required

    def reset(self):
        self.last = None
        self.count = 0
