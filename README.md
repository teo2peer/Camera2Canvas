# 🎨 Drawing-to-Game

> **Draw on paper. Watch it come alive.**
> A physical-to-digital installation that turns hand-drawn pictures into
> playable characters in a virtual world — connected by a magic light strip
> in between.

<p align="center">
  <em>Paper → camera → LEDs → screen → game</em>
</p>

<!--
Badges (uncomment when CI / packaging is set up)

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Python](https://img.shields.io/badge/python-3.10%2B-blue)
![Node](https://img.shields.io/badge/node-18%2B-green)
-->

## ✨ What it does

A visitor draws something on a marker sheet, holds it up to a camera, and the
drawing visibly travels along an LED strip and lands inside a virtual hub on
the screen. From there it can be played as a character across several
mini-games — platformer, tank shooter, racer, shape-formation toy.

The result is a delightful loop of *making something physical → seeing it in
the digital world → playing with it.*

## 🧩 Features

- 📷 **Auto-detected paper scanning** — finds an A4 sheet by 4 black corner
  markers + a bottom-edge orientation marker, perspective-warps it like a
  flatbed scanner, removes the white background, extracts the dominant
  palette.
- 👋 **Multiple capture triggers** — auto-stability, thumbs-up gesture
  (MediaPipe), or a physical Arduino button.
- ✨ **LED travel animation** — palette colours sweep along a WS2812B strip in
  sync with the on-screen portal effect.
- 🎮 **Mini-games** with Babylon.js + Rapier3D — Sky Jump, Tank War, Speed
  Race, Shape Organizer, plus a hub world.
- 🎛️ **Live admin panel** — sliders, color pickers, image picker for the
  background, light/dark theme.
- 🔧 **Realtime tuning playground** — `/playground/` web UI with
  side-by-side raw + processed view of the current frame.
- 🎵 **Procedural ambient music** — pure Web Audio, four moods, configurable
  volume and tempo.
- 💾 **Persistent gallery** — every drawing is kept in SQLite; admin can prune.

## 🖼️ Screenshots

> _Drop your screenshots / GIFs in `docs/` and reference them here._

```
docs/world.png        — hub world
docs/skyjump.png      — sky-jump platformer
docs/admin.png        — admin overlay
docs/playground.png   — capture playground
```

## 🏛️ Architecture

```
[Camera] ─┐
          │      ┌──────────────────┐         ┌──────────────────────┐
[Arduino]─┼─USB─►│ Python CV Service├─WS:8765─┤ Electron App         │
          │      │ FastAPI · OpenCV │         │ Babylon.js · Rapier  │
[Joystick]┘      │ MediaPipe · sql  │         │ TS · electron-store  │
                 └──────────────────┘         └──────────────────────┘
                       │   ▲                          ▲
                       ▼   │                          │
                  [SQLite + PNGs]            [Tablet via local HTTP]
```

- **Python service** owns *everything* hardware-related — cameras, LED serial,
  CV, websocket bus.
- **Electron app** is render-only — it streams MJPEG previews from the service
  and reacts to events. It never opens a camera itself.
- **Tablet UI** lets an operator switch games or trigger formations from a
  second device on the same network.

## 🛠️ Tech stack

| Layer    | Tools                                                              |
| -------- | ------------------------------------------------------------------ |
| Vision   | OpenCV, MediaPipe Hands, scikit-learn (KMeans), optional `rembg`    |
| Service  | FastAPI, Uvicorn, aiosqlite, pyserial                               |
| Renderer | Electron, TypeScript, Vite, Babylon.js, Rapier3D, electron-store    |
| Hardware | Arduino + FastLED, WS2812B strip, USB camera, push-button          |

## 🚀 Quickstart

### 1) Clone

```bash
git clone https://github.com/<your-user>/drawing-to-game.git
cd drawing-to-game
```

### 2) Python service

```bash
python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS / Linux
source .venv/bin/activate

pip install -e .
# Optional, for ML-based background removal:
# pip install -e ".[ml]"
```

### 3) Electron app

```bash
cd app
npm install
```

### 4) Run

The Electron main process auto-spawns the Python service when it starts. You
can also run it yourself in a separate shell:

```bash
# terminal A — service (optional; auto-spawned otherwise)
python -m service.main

# terminal B — app
cd app
npm run dev
```

A production-style build:

```bash
cd app
npm run build && npm start
```

## 🖨️ Print the marker sheet

Detection requires a sheet with 4 black corner squares + 1 smaller orientation
marker on the bottom edge. Print one of:

- Through the app: **Admin (F9) → Preview & Tools → Print marker sheet**
- Direct URL while the service runs: <http://127.0.0.1:8765/template/sheet.png>

## 🔌 Hardware (optional but recommended)

| Part                 | Notes                                                        |
| -------------------- | ------------------------------------------------------------ |
| USB camera           | 720p+ overhead is the recommended primary                    |
| Arduino (Uno/Nano)   | Flashing `firmware/led_bridge.ino` (FastLED)                 |
| WS2812B strip        | 300 LEDs by default — change in **Admin → LEDs**             |
| Push button          | Wire between **D2** and **GND** (uses internal pull-up)      |
| HID gamepad          | Optional; auto-detected by the renderer                      |

The Arduino sketch:

- Receives LED frames over USB serial: `0xAA 0x55 <u16 N> <RGB·N> <xor>`.
- Sends `BTN\n` on each debounced button press; the service captures whichever
  camera currently has a sheet visible.

## 🕹️ Operator guide

| Input                | Action                                                |
| -------------------- | ----------------------------------------------------- |
| `F9`                 | Toggle admin overlay                                  |
| `1`–`5`              | Switch scene (Hub / Sky Jump / Tank / Race / Shape)    |
| Tablet at `:8765/tablet/` | Switch games + Shape Organizer formations         |
| Web `/playground/`   | Tune scan / BG-removal parameters live                |

### Capture triggers

- **Auto** — sheet visible and stable for N frames.
- **Thumbs-up** — confirmed for 3 consecutive frames (MediaPipe Hands).
- **Arduino button** — always works while a sheet is visible.

Combine modes in **Admin → Scanning & gestures**.

## 🎨 Mini-games

| Scene            | What you do                                                       |
| ---------------- | ----------------------------------------------------------------- |
| **World**         | Hub — your gallery floats; new drawings arrive through a portal.  |
| **Sky Jump**     | Vertical climber; auto-jumps; moving platforms (60+) and monsters (150+). |
| **Tank War**      | Top-down arena shooter — drawings are tanks; survive waves.       |
| **Speed Race**   | Endless dodger; throttle, brake, swerve.                          |
| **Shape Organizer** | Tablet picks a shape; drawings fly into formation.             |

## ⚙️ Configuration

All persistent: Electron settings live in `electron-store`, service settings
in `data/settings.json`. Highlights:

- **Theme** — dark / light, applies to admin and instructions screen.
- **Hub look** — background image, gradient colours, accent, bloom, vignette,
  particle density and speed, drawing motion toggles.
- **Music** — mood (calm / magical / adventure / mystic), volume, tempo.
- **Cameras** — device dropdowns from the OS, per-camera mirror flags,
  overlay options.
- **Scanning** — trigger mode, gesture sensitivity, BG-removal mode.
- **LEDs** — COM port, LED count.

Camera-mirror, BG-removal, and trigger settings push live to the service via
the WebSocket — no restart needed.

## 🔍 HTTP API

While the service runs:

| Endpoint                              | Description                                |
| ------------------------------------- | ------------------------------------------ |
| `ws://localhost:8765/ws`              | Event bus (drawings, gestures, button…)    |
| `GET /preview/<label>.mjpg`           | Live MJPEG with detection overlay          |
| `GET /preview/<label>.jpg`            | Single JPEG snapshot                       |
| `GET /cameras` · `/cameras/devices`   | Opened labels · OS device list             |
| `GET /template/sheet.png`             | Printable marker sheet                     |
| `GET /playground/`                    | Live parameter tuner                       |
| `GET /tablet/`                        | Tablet operator UI                         |
| `GET /drawings/<id>.png`              | Saved RGBA drawing                         |

## 📁 Repository layout

```
service/    Python: CV pipeline, FastAPI, websocket, sqlite, arduino bridge
app/        Electron + TypeScript + Vite + Babylon.js renderer
firmware/   Arduino sketch (FastLED) for the LED strip + capture button
data/       Runtime: settings.json, drawings.db, drawings/, thumbs/
```

## 🩹 Troubleshooting

| Symptom                                       | Likely cause / fix                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------------------- |
| Service exits with `port in use`              | A previous service is still running. Kill it; the launcher reuses an existing one. |
| Preview goes black after some time            | Already mitigated by a shared MJPEG broadcaster + heartbeat. Check `LOG_LEVEL=DEBUG`. |
| Drawing comes in mirrored                     | Toggle the camera's mirror flag in **Admin → Cameras**.                            |
| Drawing comes in upside-down                  | Orientation marker was obscured. Re-print or re-orient the sheet.                  |
| Sheet detected but capture never fires        | Trigger mode is `gesture` only? Show a thumbs-up, or wire the Arduino button.       |
| LEDs do an idle rainbow                       | Service can't see the COM port. Set the right port in **Admin → LEDs**.            |

Set `LOG_LEVEL=DEBUG` (default) for verbose service logs; `LOG_LEVEL=INFO` for
production-quiet output.

## 🛠️ Development

- TypeScript renderer hot-reloads via Vite.
- The Electron main process is also rebuilt on save (`tsc -w`).
- The Python service auto-spawns from Electron in dev; run it standalone with
  `python -m service.main` if you want explicit logs.
- Settings + DB live in `data/`. Delete `data/drawings.db` to start with an
  empty gallery.

### Adding a mini-game

Implement `IGameScene` in `app/renderer/scenes/<name>.ts`, register it in
`app/renderer/world.ts:switchTo()`, and (optionally) add a button in the
admin Games tab and the tablet UI.

## 🤝 Contributing

PRs welcome. Please:

1. Fork → branch → PR against `main`.
2. Keep changes scoped; one feature/bug per PR.
3. Run the app end-to-end before requesting review (camera + service +
   renderer interactions are tightly coupled).
4. For UI tweaks, attach a short screen recording or screenshot.

Issues for bug reports / feature requests are very welcome — please include
your OS, camera model, and `LOG_LEVEL=DEBUG` service logs around the
problem.

## 📜 License

MIT — see [LICENSE](LICENSE).

## 🙏 Acknowledgments

- **Babylon.js** — rendering & post-processing.
- **Rapier** — physics for Sky Jump.
- **OpenCV** & **MediaPipe** — the eyes and hands of the system.
- **FastLED** — the muscle behind the WS2812B strip.
- **rembg / U²-Net** — optional ML background remover.
- Everyone who has ever drawn something silly on a piece of paper. ✏️
