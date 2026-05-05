# Drawing-to-Game Installation

Physical-to-digital art installation. User draws on paper → camera scans → drawing travels through WS2812B LED strip → enters virtual world → becomes playable character across mini-games.

## Layout
- `service/` — Python CV + WebSocket service (FastAPI, OpenCV, MediaPipe, pyserial).
- `app/` — Electron + Babylon.js + Rapier renderer.
- `firmware/` — Arduino FastLED bridge for WS2812B strip.
- `data/` — runtime: drawings, thumbs, SQLite, settings.

## Run (dev)
```
# service
python -m venv .venv && .venv\Scripts\activate
pip install -e service
python -m service.main

# app (separate shell)
cd app && npm install && npm run dev
```

## Architecture
See `C:\Users\teo2d\.claude\plans\i-am-planning-to-transient-seahorse.md`.
