/**
 * Top-left HUD overlay shared by every minigame.
 *
 * Usage:
 *   setHud({ title: "Sky Jump", lines: [...], stats: { Score: 0, Best: 0 } });
 *   updateStats({ Score: 42 });
 */
let hud: HTMLDivElement | null = null;
let cached: { title: string; lines: string[]; stats: Record<string, string | number> } = {
  title: "",
  lines: [],
  stats: {},
};

function ensure(): HTMLDivElement {
  if (hud) return hud;
  hud = document.createElement("div");
  hud.id = "hud";
  hud.style.cssText = `
    position: fixed; top: 18px; left: 18px; z-index: 50;
    color: #fff; font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    background: rgba(8,10,20,.55); backdrop-filter: blur(8px);
    border: 1px solid rgba(255,255,255,.08); border-radius: 10px;
    padding: 10px 14px; min-width: 200px; max-width: 320px;
    font-size: 13px; line-height: 1.45;
    pointer-events: none;
    box-shadow: 0 4px 24px rgba(0,0,0,.4);
  `;
  document.body.appendChild(hud);
  return hud;
}

function render() {
  const el = ensure();
  const { title, lines, stats } = cached;
  el.innerHTML = `
    <div style="font-weight:600;font-size:14px;letter-spacing:.02em;margin-bottom:6px;color:#7fb0ff">${title}</div>
    <div style="opacity:.85">${lines.map((l) => `• ${l}`).join("<br/>")}</div>
    ${Object.keys(stats).length ? `<hr style="border:0;border-top:1px solid rgba(255,255,255,.08);margin:8px 0"/>` : ""}
    ${Object.entries(stats).map(([k, v]) =>
      `<div style="display:flex;justify-content:space-between"><span style="opacity:.6">${k}</span><span style="font-variant-numeric:tabular-nums">${v}</span></div>`
    ).join("")}
  `;
  el.style.display = "block";
}

export function setHud(opts: { title: string; lines: string[]; stats?: Record<string, string | number> }) {
  cached = { title: opts.title, lines: opts.lines, stats: opts.stats ?? {} };
  render();
}

export function updateStats(stats: Record<string, string | number>) {
  cached.stats = { ...cached.stats, ...stats };
  render();
}

export function hideHud() {
  if (hud) hud.style.display = "none";
}
