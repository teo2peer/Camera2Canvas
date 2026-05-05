import { connect } from "./core/ws";
import { watchThemeSetting } from "./core/theme";

watchThemeSetting();
document.body.classList.add("theme-aware");

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const ring = $("ring");
const cam = $("cam") as HTMLImageElement;
const drop = $("drop");
const heart = $("heart");
const title = $("title");
const sub = $("sub");
const steps = Array.from(document.querySelectorAll<HTMLElement>(".step"));

type Stage = "idle" | "detecting" | "captured" | "givingLife" | "alive";
let stage: Stage = "idle";
let lastDetect = 0;
let lastProgress = 0;
let liveCamSrc: string | null = null; // remembered MJPEG URL to restore after a capture

// ---- helpers --------------------------------------------------------------
function setStep(id: string, state: "active" | "done" | "off") {
  const el = steps.find((s) => s.dataset.id === id);
  if (!el) return;
  el.classList.remove("active", "done");
  if (state === "active") el.classList.add("active");
  if (state === "done") el.classList.add("done");
}
function setDrop(progress: number) {
  const p = Math.max(0, Math.min(1, progress));
  drop.classList.toggle("show", p > 0.05);
  drop.style.transform = `translate(-50%, -50%) scale(${p})`;
}
function showHeart(on: boolean) {
  heart.classList.toggle("show", on);
}
function showLiveCam() {
  ring.classList.remove("captured");
  if (liveCamSrc && !cam.src.startsWith(liveCamSrc)) cam.src = liveCamSrc;
}
function showCapturedImage(url: string) {
  ring.classList.add("captured");
  cam.src = url;
}

// ---- stage transitions ----------------------------------------------------
function setStage(s: Stage, opts: { progress?: number; capturedUrl?: string } = {}) {
  if (stage === s) return;
  stage = s;

  if (s === "idle") {
    title.textContent = "Draw something";
    title.classList.add("pulse");
    sub.textContent = "Use the corner-marker sheet. Hold it up — thumbs-up to send.";
    setStep("show", "active"); setStep("capture", "off"); setStep("travel", "off"); setStep("live", "off");
    setDrop(0); showHeart(false); showLiveCam();
  } else if (s === "detecting") {
    title.textContent = "Hold steady…";
    title.classList.remove("pulse");
    sub.textContent = "Filling up the drop. Hold still or thumbs-up to capture.";
    setStep("show", "done"); setStep("capture", "active");
    showHeart(false); setDrop(opts.progress ?? lastProgress);
  } else if (s === "captured") {
    title.textContent = "Captured!";
    title.classList.remove("pulse");
    sub.textContent = "Holding your creation…";
    setStep("show", "done"); setStep("capture", "done"); setStep("travel", "active");
    setDrop(0); showHeart(false);
    if (opts.capturedUrl) showCapturedImage(opts.capturedUrl);
  } else if (s === "givingLife") {
    title.textContent = "Giving life to your creation";
    title.classList.add("pulse");
    sub.textContent = "Your drawing is becoming real…";
    showHeart(true); setDrop(0);
  } else if (s === "alive") {
    title.textContent = "It's alive!";
    title.classList.remove("pulse");
    sub.textContent = "Find your drawing on the big screen.";
    setStep("travel", "done"); setStep("live", "active");
    showHeart(false);
  }
}

setStage("idle");

// ---- live MJPEG inside the ring ------------------------------------------
//
// On boot the Python service may still be starting when this runs, so we
// keep trying every second until /cameras returns at least one camera. We
// also auto-reload if the <img> errors out or stops decoding (covers the
// case where the MJPEG socket dies under sustained load).
(async () => {
  const settings = await (window as any).api?.getSettings?.();
  if (settings && settings.instructionsPreview === false) {
    cam.style.display = "none";
    return;
  }

  const want = settings?.cameraOverlaySource ?? "overhead";
  let attempts = 0;

  async function tryConnect(): Promise<boolean> {
    try {
      const r = await fetch("http://127.0.0.1:8765/cameras", { cache: "no-store" });
      if (!r.ok) return false;
      const { cameras } = await r.json();
      if (!cameras || cameras.length === 0) return false;
      const which = cameras.includes(want) ? want : cameras[0];
      liveCamSrc = `http://127.0.0.1:8765/preview/${which}.mjpg`;
      cam.src = liveCamSrc;
      console.info(`[instructions] camera attached: ${which} (after ${attempts} attempts)`);
      return true;
    } catch {
      return false;
    }
  }

  // Initial poll loop — service is likely still starting up.
  while (!(await tryConnect())) {
    attempts++;
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Auto-reload if the MJPEG decoder stalls (don't fight a captured-image swap).
  cam.addEventListener("error", () => {
    if (ring.classList.contains("captured") || !liveCamSrc) return;
    setTimeout(() => (cam.src = `${liveCamSrc}?t=${Date.now()}`), 600);
  });
  let zero = 0;
  setInterval(() => {
    if (ring.classList.contains("captured") || !liveCamSrc) { zero = 0; return; }
    if (cam.naturalWidth === 0) {
      if (++zero >= 5) { zero = 0; cam.src = `${liveCamSrc}?t=${Date.now()}`; }
    } else {
      zero = 0;
    }
  }, 1000);
})();

// ---- service event handler ------------------------------------------------
connect((ev) => {
  if (ev.type === "drawing_detected") {
    lastDetect = performance.now();
    lastProgress = (ev as any).progress ?? lastProgress;
    if (stage === "idle") setStage("detecting", { progress: lastProgress });
    if (stage === "detecting") setDrop(lastProgress);
  } else if (ev.type === "drawing_captured") {
    // Sequence:
    //   captured (image + glow)  →  1.2 s
    //   givingLife (heart, 5 s)  →  5.0 s
    //   alive                    →  1.5 s
    //   idle (live cam restored)
    setStage("captured", { capturedUrl: (ev as any).url });
    window.setTimeout(() => setStage("givingLife"), 1200);
    window.setTimeout(() => setStage("alive"),     1200 + 5000);
    window.setTimeout(() => setStage("idle"),      1200 + 5000 + 1500);
  } else if ((ev as any).type === "grid_scanned") {
    const g = ev as any;
    // Wait for LED travel animation (~3 s) before painting the mosaic.
    window.setTimeout(() => showFullScreenGrid(g.cells, g.rows, g.cols, 4500), 3000);
  }
});

let gridOverlay: HTMLDivElement | null = null;
let gridHideTimer: number | null = null;
function showFullScreenGrid(
  cells: { filled: boolean; hex: string }[][],
  rows: number,
  cols: number,
  durationMs = 4000,
) {
  if (!gridOverlay) {
    gridOverlay = document.createElement("div");
    // Use the theme's page background so the empty cells of the mosaic
    // match the rest of the app instead of always being black.
    gridOverlay.style.cssText =
      "position:fixed;inset:0;z-index:9998;" +
      "background:var(--page-bg, #000);" +
      "display:flex;align-items:center;justify-content:center;" +
      "opacity:0;transition:opacity .25s;pointer-events:none;";
    document.body.appendChild(gridOverlay);
  }
  gridOverlay.innerHTML = "";

  // Backing canvas is sized at the grid's native pixel ratio (one block per cell)
  // and CSS-stretched to fill the viewport so every pixel of the screen is used.
  const cellPx = 16;
  const canvas = document.createElement("canvas");
  canvas.width = cellPx * cols;
  canvas.height = cellPx * rows;
  canvas.style.cssText =
    "image-rendering:pixelated;display:block;" +
    "position:fixed;inset:0;width:100vw;height:100vh;";

  const ctx = canvas.getContext("2d")!;
  // Resolve --bg-1 (or fallback) to a real colour for the canvas fill.
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg-1").trim() || "#0a0a0e";
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = cells[r]?.[c];
      if (!cell?.filled) continue;
      ctx.fillStyle = cell.hex;
      ctx.fillRect(c * cellPx, r * cellPx, cellPx, cellPx);
    }
  }
  gridOverlay.appendChild(canvas);
  requestAnimationFrame(() => { if (gridOverlay) gridOverlay.style.opacity = "1"; });

  if (gridHideTimer !== null) clearTimeout(gridHideTimer);
  gridHideTimer = window.setTimeout(() => {
    if (!gridOverlay) return;
    gridOverlay.style.opacity = "0";
    setTimeout(() => {
      if (gridOverlay && gridOverlay.style.opacity === "0") {
        gridOverlay.innerHTML = "";
      }
    }, 300);
  }, durationMs);
}

// drain the drop if the sheet leaves the frame mid-detection
setInterval(() => {
  if (stage === "detecting" && performance.now() - lastDetect > 600) {
    lastProgress = Math.max(0, lastProgress - 0.08);
    setDrop(lastProgress);
    if (lastProgress <= 0.02) setStage("idle");
  }
}, 80);
