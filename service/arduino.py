"""Arduino bridge: outbound LED frames + inbound capture-button events.

Outgoing protocol (Python → Arduino):
    HEADER(0xAA 0x55) | u16 led_count BE | RGB bytes (count*3) | u8 xor checksum

Incoming protocol (Arduino → Python): newline-terminated ASCII lines.
The only line we currently care about is ``BTN`` — sent when the physical
capture button is pressed (active-low, debounced on the firmware side).
"""
import logging
import serial
import struct
import threading
import time
from typing import Optional

log = logging.getLogger("service.arduino")

HEADER = b"\xAA\x55"


class LedBridge:
    """Bidirectional serial bridge for the LED strip + capture button."""

    def __init__(self, port: str, baud: int, led_count: int, on_button=None):
        self.port = port
        self.baud = baud
        self.led_count = led_count
        self.ser: Optional[serial.Serial] = None
        self._lock = threading.Lock()
        self.on_button = on_button  # callable() — fired on each BTN line
        self._reader: Optional[threading.Thread] = None
        self._running = False

    def open(self) -> bool:
        """Try to open the serial port. Returns True on success, False otherwise.

        On failure the bridge stays usable but is a no-op — calls to
        :meth:`send_frame` / :meth:`play_travel` simply do nothing so the
        rest of the system keeps running without LEDs.
        """
        if not self.port:
            log.info("LED bridge: no port configured, running offline")
            return False
        try:
            log.debug("opening serial %s @ %d baud", self.port, self.baud)
            self.ser = serial.Serial(self.port, self.baud, timeout=0.1)
            time.sleep(2.0)  # let the Arduino finish auto-reset
            self._running = True
            self._reader = threading.Thread(target=self._read_loop, daemon=True, name="led-reader")
            self._reader.start()
            log.info("LED bridge open on %s", self.port)
            return True
        except Exception as e:
            log.warning("LED bridge open failed: %s", e)
            self.ser = None
            return False

    def _read_loop(self):
        """Continuously parse newline-terminated lines from the Arduino."""
        buf = b""
        while self._running and self.ser:
            try:
                chunk = self.ser.read(64)
            except Exception as e:
                log.warning("serial read error: %s; backing off", e)
                time.sleep(0.5)
                continue
            if not chunk:
                continue
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                msg = line.strip().decode("ascii", errors="ignore")
                if not msg:
                    continue
                log.debug("arduino -> %r", msg)
                if msg.startswith("BTN") and self.on_button:
                    try:
                        self.on_button()
                    except Exception as e:
                        log.warning("on_button callback failed: %s", e)

    def close(self):
        log.info("LED bridge closing")
        self._running = False
        if self.ser:
            try:
                self.ser.close()
            except Exception:
                pass
            self.ser = None

    def send_frame(self, rgb_bytes: bytes):
        if not self.ser:
            return
        if len(rgb_bytes) != self.led_count * 3:
            return
        chk = 0
        for b in rgb_bytes:
            chk ^= b
        pkt = HEADER + struct.pack(">H", self.led_count) + rgb_bytes + bytes([chk])
        with self._lock:
            try:
                self.ser.write(pkt)
            except Exception:
                self.close()

    @staticmethod
    def hex_to_rgb(h: str):
        h = h.lstrip("#")
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))

    def play_travel(self, palette: list[str], duration_s: float = 3.0, fps: int = 60):
        """Sweep + pulse the palette colours along the strip ('drawing travels')."""
        if not self.ser or not palette:
            log.debug("play_travel skipped (no serial or empty palette)")
            return
        log.info("LED travel start: %.1fs @ %dfps colours=%s", duration_s, fps, palette[:3])
        cols = [self.hex_to_rgb(c) for c in palette]
        n = self.led_count
        steps = int(duration_s * fps)
        for s in range(steps):
            t = s / steps
            buf = bytearray(n * 3)
            for i in range(n):
                pos = i / max(1, n - 1)
                # color picks from palette by position; sweep brightness from start to end
                col = cols[int(pos * len(cols)) % len(cols)]
                head = t  # sweep position 0..1
                dist = abs(pos - head)
                gain = max(0.0, 1.0 - dist * 6.0)
                pulse = 0.5 + 0.5 * (1 - abs(2 * t - 1))
                k = gain * pulse
                buf[i * 3] = int(col[0] * k)
                buf[i * 3 + 1] = int(col[1] * k)
                buf[i * 3 + 2] = int(col[2] * k)
            self.send_frame(bytes(buf))
            time.sleep(1.0 / fps)
        self.send_frame(bytes(n * 3))  # off
