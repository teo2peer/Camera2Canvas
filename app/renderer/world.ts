import { Engine } from "@babylonjs/core/Engines/engine";
import { SceneManager, IGameScene } from "./core/sceneManager";
import { WorldScene } from "./scenes/world";
import { PlatformerScene } from "./scenes/platformer";
import { TankScene } from "./scenes/tank";
import { RaceScene } from "./scenes/race";
import { ShapeOrganizerScene } from "./scenes/shapeOrganizer";
import { connect, send, ServiceEvent } from "./core/ws";
import { library } from "./core/drawings";
import { input } from "./core/input";
import { initRapier } from "./core/physics";
import "./admin";
import { sfx } from "./core/sfx";
import { hideHud } from "./core/hud";
import { music } from "./core/music";
import { watchThemeSetting } from "./core/theme";

watchThemeSetting();

const canvas = document.getElementById("c") as HTMLCanvasElement;
const engine = new Engine(canvas, true, { stencil: true });
const mgr = new SceneManager(engine, canvas);

let current: { name: string; scene: IGameScene } | null = null;

function switchTo(name: string) {
  let s: IGameScene;
  if (name === "world" || name === "shape") hideHud();
  switch (name) {
    case "platformer": s = new PlatformerScene(engine, canvas, library.latest()); break;
    case "tank": s = new TankScene(engine, canvas); break;
    case "race": s = new RaceScene(engine, canvas); break;
    case "shape": s = new ShapeOrganizerScene(engine, canvas); break;
    default: {
      const w = new WorldScene(engine, canvas);
      for (const d of library.list) w.addDrawing(d.url, d.palette, 1, false, d.id);
      s = w;
    }
  }
  current = { name, scene: s };
  mgr.set(s);
}

initRapier();
switchTo("world");
// First user gesture unlocks AudioContext; we then read settings and start
// the procedural music engine. Re-applies on every settings:changed / live event.
async function applyMusicFromSettings() {
  const s = await (window as any).api?.getSettings?.();
  music.applyFromSettings(s);
}
addEventListener("pointerdown", () => { applyMusicFromSettings(); }, { once: true });
addEventListener("keydown",     () => { applyMusicFromSettings(); }, { once: true });
addEventListener("settings:changed", () => { applyMusicFromSettings(); });
addEventListener("settings:live", (e: any) => {
  const k = e.detail?.key;
  if (k === "ambientSound" || k === "musicMood" || k === "musicVolume" || k === "musicTempo") {
    applyMusicFromSettings();
  }
});

let camOverlayCam: string | null = null;
let camOverlayBaseSrc: string | null = null;

function reloadOverlay(reason: string) {
  const img = document.getElementById("cam-overlay") as HTMLImageElement | null;
  if (!img || !camOverlayBaseSrc) return;
  console.warn("[cam-overlay] reload:", reason);
  // Cache-bust to force the <img> to re-open the MJPEG connection.
  img.src = `${camOverlayBaseSrc}?t=${Date.now()}`;
}

async function applyCamOverlay() {
  const img = document.getElementById("cam-overlay") as HTMLImageElement | null;
  if (!img) return;
  const s = await (window as any).api?.getSettings?.();
  if (!s) return;
  if (!s.cameraOverlay) {
    img.src = "";
    camOverlayBaseSrc = null;
    img.style.display = "none";
    return;
  }
  let cam = s.cameraOverlaySource ?? "overhead";
  try {
    const r = await fetch("http://127.0.0.1:8765/cameras");
    const { cameras } = await r.json();
    if (!cameras.includes(cam)) cam = cameras[0];
    if (!cam) { img.src = ""; camOverlayBaseSrc = null; img.style.display = "none"; return; }
  } catch {
    img.src = ""; camOverlayBaseSrc = null; img.style.display = "none"; return;
  }
  camOverlayCam = cam;
  const newBase = `http://127.0.0.1:8765/preview/${cam}.mjpg`;
  img.style.display = "block";
  if (newBase === camOverlayBaseSrc && img.src.startsWith(newBase)) return;
  camOverlayBaseSrc = newBase;
  img.src = newBase;
}

applyCamOverlay();
addEventListener("settings:changed", applyCamOverlay as any);

connect((ev: ServiceEvent) => {
  if (ev.type === "drawing_captured") {
    library.add({ id: ev.id, url: ev.url, palette: ev.palette, w: ev.w, h: ev.h });
    if (current?.name === "world") (current.scene as WorldScene).addDrawing(ev.url, ev.palette, ev.w / Math.max(1, ev.h), true, ev.id);
  } else if (ev.type === "drawings_list") {
    for (const d of ev.items) library.add(d);
    if (current?.name === "world") for (const d of ev.items) (current.scene as WorldScene).addDrawing(d.url, d.palette, 1, false, d.id);
  } else if ((ev as any).type === "set_game") {
    switchTo((ev as any).game);
  } else if ((ev as any).type === "admin:deleted") {
    const ids: string[] = (ev as any).ids ?? [];
    for (const id of ids) {
      library.remove(id);
      if (current?.name === "world") (current.scene as WorldScene).removeDrawing(id);
    }
  } else if ((ev as any).type === "grid_scanning") {
    showGridToast("Scanning pattern…");
  } else if ((ev as any).type === "grid_scanned") {
    showGridToast("Pattern travelling…", 3000);
    // Wait for LED travel animation (~3 s) so the on-screen mosaic
    // appears as the lights "arrive" at the canvas.
    const ev2 = ev as any;
    window.setTimeout(() => {
      showGridToast("Pattern captured", 1800);
      if (current?.name === "world") (current.scene as WorldScene).handleEvent(ev2);
    }, 3000);
  } else if (ev.type === "hand_gesture") {
    // map landmark[8] x to horizontal axis; thumbs_up = jump
    const tip = ev.landmarks?.[8];
    if (tip) input.setGestureAxis((tip[0] - 0.5) * 2, 0);
    input.setGestureButton("jump", ev.gesture === "thumbs_up");
    input.setGestureButton("shoot", ev.gesture === "fist");
  }
});

addEventListener("keydown", (e) => {
  if (e.code === "Digit1") switchTo("world");
  if (e.code === "Digit2") switchTo("platformer");
  if (e.code === "Digit3") switchTo("tank");
  if (e.code === "Digit4") switchTo("race");
  if (e.code === "Digit5") switchTo("shape");
});

// Optimistic removal from the admin panel — drop matching world meshes
// before the WS round-trip confirms.
addEventListener("library:removed", (e: any) => {
  const ids: string[] = e.detail?.ids ?? [];
  for (const id of ids) if (current?.name === "world") (current.scene as WorldScene).removeDrawing(id);
});

window.addEventListener("resize", () => engine.resize());
engine.runRenderLoop(() => mgr.render());

// ---- Grid scan toast ----
let gridToastEl: HTMLDivElement | null = null;
let gridToastTimer: number | null = null;
function showGridToast(text: string, hideAfterMs: number | null = null) {
  if (!gridToastEl) {
    gridToastEl = document.createElement("div");
    gridToastEl.style.cssText =
      "position:fixed;top:24px;left:50%;transform:translateX(-50%);" +
      "padding:10px 20px;color:var(--text,#fff);" +
      "background:color-mix(in srgb, var(--bg-0,#000) 75%, transparent);" +
      "border:1px solid var(--border,transparent);" +
      "font:600 18px/1.2 system-ui,sans-serif;letter-spacing:.04em;" +
      "border-radius:999px;backdrop-filter:blur(6px);z-index:9999;" +
      "transition:opacity .25s;pointer-events:none;";
    document.body.appendChild(gridToastEl);
  }
  gridToastEl.textContent = text;
  gridToastEl.style.opacity = "1";
  if (gridToastTimer !== null) { clearTimeout(gridToastTimer); gridToastTimer = null; }
  if (hideAfterMs !== null) {
    gridToastTimer = window.setTimeout(() => {
      if (gridToastEl) gridToastEl.style.opacity = "0";
    }, hideAfterMs);
  }
}
