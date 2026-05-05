"""Threaded camera reader.

OpenCV's ``VideoCapture.read()`` blocks the calling thread until the next
frame is available. To prevent that from stalling either the asyncio loop
or the MJPEG encoder, we keep a daemon thread continuously polling the
device and stash the latest frame in a slot guarded by a lock. Consumers
call :meth:`read` to get a *copy* of whatever the latest frame is — never
blocking longer than a memcpy.

If the camera produces no frames for ~10s the reader auto-reopens it
(in case a USB hub momentarily dropped it).
"""
import logging
import threading
import time
from typing import Optional

import cv2

log = logging.getLogger("service.camera")


class CameraSource:
    def __init__(self, index: int, width: int = 1280, height: int = 720, mirror: bool = False):
        self.index = index
        self.width = width
        self.height = height
        self.mirror = mirror   # horizontally flip every frame at read time
        self.cap: Optional[cv2.VideoCapture] = None
        self._lock = threading.Lock()
        self._frame = None
        self._running = False
        self._thread: Optional[threading.Thread] = None

    # ------------------------------------------------------------------
    def open(self) -> None:
        """Try to open the device with multiple backends. Raises on failure."""
        last_err = None
        backends = [cv2.CAP_DSHOW, cv2.CAP_MSMF, cv2.CAP_ANY]
        cap = None
        for be in backends:
            try:
                log.debug("trying backend=%s for index=%d", be, self.index)
                c = cv2.VideoCapture(self.index, be)
                if c.isOpened():
                    cap = c
                    log.info("camera idx=%d opened via backend=%s", self.index, be)
                    break
                c.release()
            except Exception as e:
                last_err = e
                log.warning("backend %s threw: %s", be, e)
        if cap is None:
            raise RuntimeError(f"camera index {self.index} could not open ({last_err})")
        try:
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        except Exception as e:
            log.debug("set caps failed (non-fatal): %s", e)
        self.cap = cap
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True, name=f"cam-{self.index}")
        self._thread.start()
        log.debug("camera idx=%d reader thread started", self.index)

    # ------------------------------------------------------------------
    def _loop(self) -> None:
        """Daemon thread: continuously pull frames into ``self._frame``."""
        fail = 0
        reopen_backoff = 1.0
        while self._running and self.cap:
            try:
                ok, frame = self.cap.read()
            except Exception:
                ok, frame = False, None
            if ok and frame is not None:
                if fail:
                    log.debug("camera idx=%d frames recovered after %d fails", self.index, fail)
                fail = 0
                if self.mirror:
                    frame = cv2.flip(frame, 1)   # horizontal flip — corrects mirrored webcams
                reopen_backoff = 1.0
                with self._lock:
                    self._frame = frame
            else:
                fail += 1
                time.sleep(0.02)
                if fail >= 500:  # ~10 s of dead reads → reopen
                    log.warning("camera idx=%d stalled %d reads, reopening", self.index, fail)
                    fail = 0
                    try:
                        self.cap.release()
                    except Exception:
                        pass
                    try:
                        self.open_existing_index()
                        reopen_backoff = 1.0
                    except Exception as e:
                        log.error("camera idx=%d reopen failed: %s (backoff %.1fs)",
                                  self.index, e, reopen_backoff)
                        time.sleep(reopen_backoff)
                        reopen_backoff = min(reopen_backoff * 2, 5.0)

    def open_existing_index(self) -> None:
        last_err = None
        for be in (cv2.CAP_DSHOW, cv2.CAP_MSMF, cv2.CAP_ANY):
            try:
                c = cv2.VideoCapture(self.index, be)
                if c.isOpened():
                    try:
                        c.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
                        c.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
                        c.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                    except Exception:
                        pass
                    self.cap = c
                    log.info("camera idx=%d reopened via backend=%s", self.index, be)
                    return
                c.release()
            except Exception as e:
                last_err = e
        raise RuntimeError(f"reopen failed for idx={self.index} ({last_err})")

    # ------------------------------------------------------------------
    def read(self):
        """Return a copy of the latest frame, or None if nothing yet."""
        with self._lock:
            return None if self._frame is None else self._frame.copy()

    def close(self) -> None:
        log.info("camera idx=%d closing", self.index)
        self._running = False
        if self._thread:
            self._thread.join(timeout=1)
        if self.cap:
            try:
                self.cap.release()
            except Exception:
                pass
            self.cap = None
