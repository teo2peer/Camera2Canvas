"""MediaPipe-based hand tracker + ad-hoc gesture classifier.

If mediapipe import fails (e.g. on a Python version without wheels) the
tracker silently disables itself: ``HandTracker.ok`` is False and
``process()`` returns empty. The rest of the pipeline keeps working.
"""
import logging
import numpy as np
from typing import Optional

log = logging.getLogger("service.hands")


class HandTracker:
    def __init__(self, sensitivity: float = 0.7):
        try:
            import mediapipe as mp
            self.mp_hands = mp.solutions.hands.Hands(
                model_complexity=0,
                max_num_hands=2,
                min_detection_confidence=sensitivity,
                min_tracking_confidence=sensitivity,
            )
            self.ok = True
            log.info("MediaPipe Hands ready (sensitivity=%.2f)", sensitivity)
        except Exception as e:
            log.warning("MediaPipe Hands unavailable: %s — gesture trigger disabled", e)
            self.mp_hands = None
            self.ok = False

    def process(self, bgr) -> list[dict]:
        if not self.ok or self.mp_hands is None:
            return []
        import cv2
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        res = self.mp_hands.process(rgb)
        out = []
        if not res.multi_hand_landmarks:
            return out
        for i, lms in enumerate(res.multi_hand_landmarks):
            pts = np.array([[lm.x, lm.y, lm.z] for lm in lms.landmark])
            handedness = "R"
            if res.multi_handedness and i < len(res.multi_handedness):
                handedness = res.multi_handedness[i].classification[0].label[0]
            gesture = classify(pts)
            out.append({"hand": handedness, "gesture": gesture, "landmarks": pts.tolist()})
        return out


def classify(pts: np.ndarray) -> str:
    """Gesture classifier on 21 mediapipe landmarks (normalized x,y,z; smaller y = up)."""
    # landmark IDs: 0 wrist, 1-4 thumb, 5-8 index, 9-12 mid, 13-16 ring, 17-20 pinky
    finger_tips = [8, 12, 16, 20]
    finger_pips = [6, 10, 14, 18]
    finger_mcps = [5, 9, 13, 17]
    # finger extended: tip is significantly above PIP (smaller y)
    extended = [pts[t][1] < pts[p][1] - 0.015 for t, p in zip(finger_tips, finger_pips)]
    # finger folded: tip below MCP (curled into palm)
    folded = [pts[t][1] > pts[m][1] + 0.005 for t, m in zip(finger_tips, finger_mcps)]
    n_ext = sum(extended)
    n_folded = sum(folded)

    thumb_tip_y, thumb_ip_y, thumb_mcp_y, wrist_y = pts[4][1], pts[3][1], pts[2][1], pts[0][1]
    thumb_up = (thumb_tip_y < thumb_ip_y - 0.01) and (thumb_tip_y < thumb_mcp_y - 0.02) and (thumb_tip_y < wrist_y - 0.05)

    if thumb_up and n_folded >= 3 and n_ext == 0:
        return "thumbs_up"
    if n_ext == 4:
        return "open_palm"
    if n_folded >= 3 and not thumb_up:
        return "fist"
    if extended[0] and extended[1] and not extended[2] and not extended[3]:
        return "peace"
    if extended[0] and not extended[1] and not extended[2] and not extended[3]:
        return "point"
    return "unknown"
