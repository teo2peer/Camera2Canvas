import { send } from "./core/ws";
import { library } from "./core/drawings";

const api = (window as any).api;

type FieldDef =
  | { kind: "text"; key: string; label: string }
  | { kind: "number"; key: string; label: string; step?: number }
  | { kind: "bool"; key: string; label: string }
  | { kind: "select"; key: string; label: string; options: string[] }
  | { kind: "camera"; key: string; label: string }
  | { kind: "color"; key: string; label: string }
  | { kind: "image"; key: string; label: string }
  | {
      kind: "slider";
      key: string;
      label: string;
      min: number;
      max: number;
      step: number;
      format?: (v: number) => string;
    };

interface Section {
  id: string;
  title: string;
  fields: FieldDef[];
  custom?: (root: HTMLElement) => void;
}

let panel: HTMLDivElement | null = null;
let cachedDevices: { index: number; name: string }[] | null = null;
let serviceCameras: string[] = [];

async function getCameraDevices() {
  if (cachedDevices) return cachedDevices;
  try {
    const r = await fetch("http://127.0.0.1:8765/cameras/devices");
    const j = await r.json();
    cachedDevices = j.devices ?? [];
  } catch {
    cachedDevices = [];
  }
  return cachedDevices!;
}
async function getServiceCameras() {
  try {
    const r = await fetch("http://127.0.0.1:8765/cameras");
    const j = await r.json();
    serviceCameras = j.cameras ?? [];
  } catch {
    serviceCameras = [];
  }
  return serviceCameras;
}

const SERVICE_KEY_MAP: Record<string, string> = {
  scanTrigger: "scan_trigger",
  cameraMode: "camera_mode",
  overheadCameraIndex: "overhead_camera_index",
  frontCameraIndex: "front_camera_index",
  bgRemoval: "bg_removal",
  mirrorOverhead: "mirror_overhead",
  mirrorFront: "mirror_front",
  ledCount: "led_count",
  ledSerialPort: "led_serial_port",
  gestureSensitivity: "gesture_sensitivity",
  gridCols: "grid_cols",
  gridRows: "grid_rows",
};

const SECTIONS: Section[] = [
  {
    id: "general",
    title: "General",
    fields: [
      { kind: "select", key: "theme", label: "App theme", options: ["dark", "light"] },
      { kind: "select", key: "monitorMode", label: "Monitor mode", options: ["dual", "single"] },
      { kind: "bool", key: "kiosk", label: "Kiosk mode (locks the window)" },
      { kind: "text", key: "adminHotkey", label: "Admin hotkey" },
      { kind: "bool", key: "ambientSound", label: "Ambient soundscape" },
      { kind: "select", key: "musicMood", label: "Music mood", options: ["calm", "magical", "adventure", "mystic"] },
      { kind: "slider", key: "musicVolume", label: "Music volume", min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
      { kind: "slider", key: "musicTempo", label: "Music tempo (BPM)", min: 50, max: 160, step: 2, format: (v) => `${v}` },
    ],
  },
  {
    id: "cameras",
    title: "Cameras",
    fields: [
      { kind: "select", key: "cameraMode", label: "Camera mode", options: ["overhead", "front", "both"] },
      { kind: "camera", key: "overheadCameraIndex", label: "Overhead camera" },
      { kind: "bool", key: "mirrorOverhead", label: "Mirror overhead camera (flip horizontal)" },
      { kind: "camera", key: "frontCameraIndex", label: "Front camera" },
      { kind: "bool", key: "mirrorFront", label: "Mirror front camera (flip horizontal)" },
      { kind: "bool", key: "cameraOverlay", label: "Show camera overlay on world" },
      { kind: "select", key: "cameraOverlaySource", label: "Overlay source", options: ["overhead", "front"] },
      { kind: "bool", key: "instructionsPreview", label: "Show preview on instructions screen" },
    ],
  },
  {
    id: "scanning",
    title: "Scanning & gestures",
    fields: [
      { kind: "select", key: "scanTrigger", label: "Capture trigger", options: ["auto", "gesture", "auto+gesture"] },
      {
        kind: "slider", key: "gestureSensitivity", label: "Gesture sensitivity",
        min: 0.3, max: 0.95, step: 0.05, format: (v) => v.toFixed(2),
      },
      { kind: "select", key: "bgRemoval", label: "Background removal", options: ["threshold", "ml"] },
      { kind: "number", key: "gridCols", label: "Grid columns (long edge)", step: 1 },
      { kind: "number", key: "gridRows", label: "Grid rows (short edge)", step: 1 },
    ],
  },
  {
    id: "hub",
    title: "Hub look",
    fields: [
      { kind: "image", key: "hubBgImage", label: "Background image (overrides gradient)" },
      { kind: "color", key: "hubBgTop", label: "Background top" },
      { kind: "color", key: "hubBgBottom", label: "Background bottom" },
      { kind: "color", key: "hubAccent", label: "Accent / particles" },
      { kind: "slider", key: "hubBloom", label: "Bloom", min: 0, max: 1, step: 0.05, format: (v) => v.toFixed(2) },
      { kind: "slider", key: "hubVignette", label: "Vignette", min: 0, max: 2.5, step: 0.1, format: (v) => v.toFixed(1) },
      { kind: "slider", key: "hubParticleCount", label: "Particle count", min: 0, max: 2000, step: 50, format: (v) => String(v) },
      { kind: "slider", key: "hubParticleSpeed", label: "Particle speed", min: 0, max: 2, step: 0.05, format: (v) => v.toFixed(2) },
      { kind: "slider", key: "hubFloatAmp", label: "Drawing float amplitude", min: 0, max: 2, step: 0.05, format: (v) => v.toFixed(2) },
      { kind: "bool", key: "hubDrawingFloat", label: "Drawings: gentle float (vertical bob)" },
      { kind: "bool", key: "hubDrawingDrift", label: "Drawings: drift across canvas" },
      { kind: "bool", key: "hubDrawingRotate", label: "Drawings: slow rotation" },
    ],
  },
  {
    id: "leds",
    title: "LEDs",
    fields: [
      { kind: "text", key: "ledSerialPort", label: "Arduino serial port (e.g. COM4)" },
      { kind: "number", key: "ledCount", label: "LED count", step: 1 },
    ],
  },
];

// ---------------------------------------------------------------------------
// Field rendering helpers
// ---------------------------------------------------------------------------
function row(label: string, control: HTMLElement, valueEl?: HTMLElement) {
  const wrap = document.createElement("div");
  wrap.className = "ad-row";
  const lbl = document.createElement("label");
  lbl.className = "ad-label";
  lbl.textContent = label;
  if (valueEl) {
    valueEl.className = "ad-val";
    lbl.appendChild(valueEl);
  }
  wrap.appendChild(lbl);
  wrap.appendChild(control);
  return wrap;
}

async function renderField(f: FieldDef, current: any): Promise<HTMLElement> {
  switch (f.kind) {
    case "text": {
      const i = document.createElement("input");
      i.type = "text"; i.value = String(current[f.key] ?? "");
      i.dataset.key = f.key; i.dataset.kind = "text";
      return row(f.label, i);
    }
    case "number": {
      const i = document.createElement("input");
      i.type = "number"; i.value = String(current[f.key] ?? 0);
      if (f.step) i.step = String(f.step);
      i.dataset.key = f.key; i.dataset.kind = "number";
      return row(f.label, i);
    }
    case "bool": {
      const i = document.createElement("input");
      i.type = "checkbox"; i.checked = !!current[f.key];
      i.dataset.key = f.key; i.dataset.kind = "bool";
      return row(f.label, i);
    }
    case "select": {
      const sel = document.createElement("select");
      for (const o of f.options) {
        const opt = document.createElement("option");
        opt.value = o; opt.textContent = o;
        if (current[f.key] === o) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.dataset.key = f.key; sel.dataset.kind = "select";
      // Broadcast on change so live-aware modules (theme, music, hub) react.
      sel.addEventListener("change", () => liveBroadcast(f.key, sel.value));
      return row(f.label, sel);
    }
    case "camera": {
      const sel = document.createElement("select");
      const devs = await getCameraDevices();
      if (devs.length === 0) {
        const opt = document.createElement("option");
        opt.value = String(current[f.key] ?? 0);
        opt.textContent = `(no devices found — using ${current[f.key] ?? 0})`;
        sel.appendChild(opt);
      } else {
        for (const d of devs) {
          const opt = document.createElement("option");
          opt.value = String(d.index);
          opt.textContent = `${d.index}: ${d.name}`;
          if (Number(current[f.key]) === d.index) opt.selected = true;
          sel.appendChild(opt);
        }
      }
      sel.dataset.key = f.key; sel.dataset.kind = "camera";
      return row(f.label, sel);
    }
    case "color": {
      const i = document.createElement("input");
      i.type = "color"; i.value = String(current[f.key] ?? "#000000");
      i.dataset.key = f.key; i.dataset.kind = "color";
      i.style.height = "32px"; i.style.padding = "2px"; i.style.background = "transparent";
      return row(f.label, i);
    }
    case "image": {
      const wrap = document.createElement("div");
      wrap.style.display = "flex"; wrap.style.gap = "8px"; wrap.style.alignItems = "center";
      const hidden = document.createElement("input");
      hidden.type = "hidden"; hidden.dataset.key = f.key; hidden.dataset.kind = "text";
      hidden.value = String(current[f.key] ?? "");
      const pathLbl = document.createElement("span");
      pathLbl.style.flex = "1"; pathLbl.style.opacity = ".75";
      pathLbl.style.overflow = "hidden"; pathLbl.style.textOverflow = "ellipsis"; pathLbl.style.whiteSpace = "nowrap";
      pathLbl.style.fontSize = "12px";
      pathLbl.textContent = hidden.value || "(none — using gradient)";
      const pick = document.createElement("button");
      pick.className = "ad-btn"; pick.type = "button"; pick.textContent = "Pick…";
      pick.addEventListener("click", async () => {
        const p = await api?.pickImage?.();
        if (!p) return;
        hidden.value = p;
        pathLbl.textContent = p;
        liveBroadcast(f.key, p);
      });
      const clear = document.createElement("button");
      clear.className = "ad-btn"; clear.type = "button"; clear.textContent = "Clear";
      clear.addEventListener("click", () => {
        hidden.value = "";
        pathLbl.textContent = "(none — using gradient)";
        liveBroadcast(f.key, "");
      });
      wrap.appendChild(pathLbl); wrap.appendChild(pick); wrap.appendChild(clear); wrap.appendChild(hidden);
      return row(f.label, wrap);
    }
    case "slider": {
      const i = document.createElement("input");
      i.type = "range"; i.min = String(f.min); i.max = String(f.max); i.step = String(f.step);
      i.value = String(current[f.key] ?? f.min);
      i.dataset.key = f.key; i.dataset.kind = "slider";
      const v = document.createElement("span");
      v.textContent = (f.format ?? ((x: number) => String(x)))(Number(i.value));
      i.addEventListener("input", () => {
        v.textContent = (f.format ?? ((x: number) => String(x)))(Number(i.value));
        liveBroadcast(f.key, Number(i.value));
      });
      return row(f.label, i, v);
    }
  }
}

// Push a single field change to listeners (Hub scene reacts immediately to colour/slider tweaks)
function liveBroadcast(key: string, value: unknown) {
  dispatchEvent(new CustomEvent("settings:live", { detail: { key, value } }));
}

// ---------------------------------------------------------------------------
// Drawings grid
// ---------------------------------------------------------------------------
let drawingsHost: HTMLElement | null = null;

function renderDrawings(host: HTMLElement) {
  drawingsHost = host;
  host.innerHTML = `
    <div class="ad-row" style="grid-template-columns:1fr">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="ad-btn" id="del10">Delete oldest 10</button>
        <button class="ad-btn" id="del50">Delete oldest 50</button>
        <button class="ad-btn danger" id="delAll">Delete ALL</button>
        <span class="ad-pill" id="ad-thumb-count">${library.list.length} drawings</span>
      </div>
    </div>
    <div id="grid" class="ad-grid"></div>`;
  const refresh = () => {
    const grid = host.querySelector("#grid")!;
    const count = host.querySelector("#ad-thumb-count")!;
    count.textContent = `${library.list.length} drawings`;
    grid.innerHTML = library.list
      .map((d) => `
        <div class="ad-thumb" data-row="${d.id}">
          <img src="${d.url}"/>
          <button data-id="${d.id}" title="Delete">×</button>
        </div>`).join("");
    grid.querySelectorAll<HTMLButtonElement>("button[data-id]").forEach((b) =>
      b.addEventListener("click", () => {
        const id = b.dataset.id!;
        send({ type: "admin:delete", ids: [id] });
        // optimistic local removal so the operator sees the change immediately
        library.remove(id);
        dispatchEvent(new CustomEvent("library:removed", { detail: { ids: [id] } }));
        refresh();
      })
    );
  };
  host.querySelector("#del10")!.addEventListener("click", () => {
    send({ type: "admin:delete_oldest", n: 10 });
    const ids = library.list.slice(0, 10).map((d) => d.id);
    for (const id of ids) library.remove(id);
    dispatchEvent(new CustomEvent("library:removed", { detail: { ids } }));
    refresh();
  });
  host.querySelector("#del50")!.addEventListener("click", () => {
    send({ type: "admin:delete_oldest", n: 50 });
    const ids = library.list.slice(0, 50).map((d) => d.id);
    for (const id of ids) library.remove(id);
    dispatchEvent(new CustomEvent("library:removed", { detail: { ids } }));
    refresh();
  });
  host.querySelector("#delAll")!.addEventListener("click", () => {
    if (!confirm(`Delete all ${library.list.length} drawings? This cannot be undone in the UI.`)) return;
    send({ type: "admin:delete_oldest", n: 99999 });
    const ids = library.list.map((d) => d.id);
    for (const id of ids) library.remove(id);
    dispatchEvent(new CustomEvent("library:removed", { detail: { ids } }));
    refresh();
  });
  refresh();
}

// Re-render the grid whenever the WS confirms a deletion or whenever the
// world reports a library change (keeps admin in sync if anything else
// touches the library).
addEventListener("library:removed", () => { if (drawingsHost) renderDrawings(drawingsHost); });

// ---------------------------------------------------------------------------
// Games & playground sections (custom)
// ---------------------------------------------------------------------------
function renderGames(host: HTMLElement) {
  host.innerHTML = `
    <div class="ad-row" style="grid-template-columns:1fr">
      <div style="display:flex;gap:8px;flex-wrap:wrap" id="games"></div>
    </div>`;
  const wrap = host.querySelector("#games")!;
  for (const g of ["world", "platformer", "tank", "race", "shape", "invaders"]) {
    const b = document.createElement("button");
    b.className = "ad-btn"; b.textContent = g;
    b.addEventListener("click", () => send({ type: "admin:set_game", game: g }));
    wrap.appendChild(b);
  }
}

async function renderPreviewSection(host: HTMLElement) {
  const cams = await getServiceCameras();
  host.innerHTML = `
    <div class="ad-row" style="grid-template-columns:1fr">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="ad-btn" id="sheet-print">Print marker sheet</button>
        <button class="ad-btn" id="sheet-save">Save sheet PNG</button>
        <button class="ad-btn" id="grid-print">Print grid sheet</button>
        <button class="ad-btn" id="grid-save">Save grid PNG</button>
        <button class="ad-btn" id="open-pg">Open capture playground</button>
      </div>
    </div>
    <div id="cams" class="ad-cams">
      ${cams.length
        ? cams.map((c) => `
          <figure class="ad-cam">
            <figcaption>${c}</figcaption>
            <img src="http://127.0.0.1:8765/preview/${c}.mjpg" />
          </figure>`).join("")
        : `<div class="ad-empty">No camera open in service</div>`}
    </div>`;
  host.querySelector("#sheet-print")!.addEventListener("click", () =>
    api?.openExternal?.("http://127.0.0.1:8765/template/sheet.html"));
  host.querySelector("#sheet-save")!.addEventListener("click", async () => {
    const r = await fetch("http://127.0.0.1:8765/template/sheet.png");
    const blob = await r.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "marker_sheet_A4.png";
    document.body.appendChild(a); a.click(); a.remove();
  });
  host.querySelector("#grid-print")!.addEventListener("click", () =>
    api?.openExternal?.("http://127.0.0.1:8765/template/grid.html"));
  host.querySelector("#grid-save")!.addEventListener("click", async () => {
    const r = await fetch("http://127.0.0.1:8765/template/grid.png");
    const blob = await r.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "grid_sheet_A4.png";
    document.body.appendChild(a); a.click(); a.remove();
  });
  host.querySelector("#open-pg")!.addEventListener("click", () =>
    api?.openExternal?.("http://127.0.0.1:8765/playground/"));
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------
function injectStyles() {
  if (document.getElementById("ad-styles")) return;
  const s = document.createElement("style");
  s.id = "ad-styles";
  // All colours come from CSS variables defined by core/theme.ts so the panel
  // re-skins on theme change without re-rendering.
  s.textContent = `
    #admin { position:fixed; inset:0; background:color-mix(in srgb, var(--bg-0) 92%, transparent);
             color:var(--text); font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
             z-index:9999; display:none; }
    #admin.show { display:grid; grid-template-columns:240px 1fr; }
    #admin .ad-side { background:var(--bg-1); padding:18px 12px;
                     border-right:1px solid var(--border); overflow:auto; }
    #admin .ad-side h2 { font-size:15px; margin:0 0 14px; letter-spacing:.04em; opacity:.9; }
    #admin .ad-tab { display:block; width:100%; text-align:left; background:transparent;
                    border:0; color:var(--text-dim); padding:9px 12px; border-radius:6px;
                    font-size:14px; cursor:pointer; }
    #admin .ad-tab:hover { background:var(--input-bg); }
    #admin .ad-tab.active { background:var(--btn-pri); color:#fff; }
    #admin .ad-main { padding:22px 26px; overflow:auto; }
    #admin .ad-head { display:flex; align-items:center; gap:14px; margin-bottom:18px; }
    #admin .ad-head h1 { font-size:18px; margin:0; font-weight:600; }
    #admin .ad-head .ad-pill { background:var(--btn-bg); color:var(--text);
                              padding:3px 10px; border-radius:99px; font-size:12px; }
    #admin .ad-row { display:grid; grid-template-columns:240px 1fr; gap:12px;
                    align-items:center; padding:8px 0; border-bottom:1px solid var(--border); }
    #admin .ad-label { font-size:13px; opacity:.8; display:flex; justify-content:space-between; gap:10px; }
    #admin .ad-val { color:var(--accent); font-variant-numeric:tabular-nums; }
    #admin input[type=text], #admin input[type=number], #admin select {
      background:var(--input-bg); border:1px solid var(--input-bd); color:var(--text);
      padding:7px 9px; border-radius:5px; width:100%; font-size:13px;
    }
    #admin input[type=range] { width:100%; }
    #admin input[type=checkbox] { width:18px; height:18px; }
    #admin input[type=color] { width:60px; border:1px solid var(--input-bd); border-radius:5px; cursor:pointer; }
    #admin .ad-btn { background:var(--btn-bg); border:0; color:var(--text);
                    padding:8px 13px; border-radius:5px; cursor:pointer; font-size:13px; }
    #admin .ad-btn:hover { background:var(--btn-bg-h); }
    #admin .ad-btn.primary { background:var(--btn-pri); color:#fff; }
    #admin .ad-btn.danger  { background:var(--btn-dng); color:#fff; }
    #admin .ad-actions { position:sticky; bottom:0;
                       background:linear-gradient(180deg, transparent 0%, var(--bg-0) 60%);
                       padding:14px 0 4px; margin-top:14px; display:flex; gap:8px; }
    #admin .ad-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(110px,1fr));
                     gap:10px; margin-top:10px; }
    #admin .ad-thumb { position:relative; border:1px solid var(--border); border-radius:6px;
                      overflow:hidden;
                      background:repeating-conic-gradient(var(--bg-1) 0% 25%, var(--bg-0) 0% 50%) 0 0/14px 14px; }
    #admin .ad-thumb img { width:100%; display:block; }
    #admin .ad-thumb button { position:absolute; top:4px; right:4px; background:rgba(0,0,0,.6);
                            color:#fff; border:0; width:24px; height:24px; border-radius:99px; cursor:pointer; }
    #admin .ad-cams { display:grid; grid-template-columns:repeat(auto-fill,minmax(360px,1fr)); gap:12px; margin-top:12px; }
    #admin .ad-cam { margin:0; border:1px solid var(--border); border-radius:8px; padding:8px;
                    background:var(--bg-1); }
    #admin .ad-cam figcaption { font-size:12px; opacity:.7; margin-bottom:6px; }
    #admin .ad-cam img { width:100%; background:#000; border-radius:5px; }
    #admin .ad-empty { opacity:.6; padding:14px 0; }
    #admin .ad-status { font-size:12px; opacity:.75; margin-left:auto; }
  `;
  document.head.appendChild(s);
}

async function build(): Promise<HTMLDivElement> {
  injectStyles();
  const d = document.createElement("div");
  d.id = "admin";
  d.innerHTML = `
    <aside class="ad-side">
      <h2>Admin</h2>
      <nav id="ad-tabs"></nav>
    </aside>
    <main class="ad-main">
      <div class="ad-head">
        <h1 id="ad-title">…</h1>
        <span class="ad-pill" id="ad-count">${library.list.length} drawings</span>
        <span class="ad-status" id="ad-status"></span>
        <button class="ad-btn" id="ad-close">Close (F9)</button>
      </div>
      <div id="ad-content"></div>
    </main>`;
  document.body.appendChild(d);

  const tabs = d.querySelector("#ad-tabs")!;
  const allTabs: { id: string; title: string; render: (host: HTMLElement) => void | Promise<void> }[] = [
    { id: "preview", title: "Preview & Tools", render: renderPreviewSection },
    ...SECTIONS.map((s) => ({
      id: s.id, title: s.title,
      render: async (host: HTMLElement) => {
        const cur = await api.getSettings();
        host.innerHTML = "";
        for (const f of s.fields) host.appendChild(await renderField(f, cur));
      },
    })),
    { id: "drawings", title: "Drawings", render: renderDrawings },
    { id: "games", title: "Games", render: renderGames },
  ];

  for (const t of allTabs) {
    const b = document.createElement("button");
    b.className = "ad-tab"; b.dataset.id = t.id; b.textContent = t.title;
    b.addEventListener("click", () => activate(t.id));
    tabs.appendChild(b);
  }

  function activate(id: string) {
    const tab = allTabs.find((x) => x.id === id)!;
    d.querySelectorAll<HTMLButtonElement>(".ad-tab").forEach((x) =>
      x.classList.toggle("active", x.dataset.id === id));
    d.querySelector("#ad-title")!.textContent = tab.title;
    const host = d.querySelector("#ad-content") as HTMLElement;
    Promise.resolve(tab.render(host));
  }

  d.querySelector("#ad-close")!.addEventListener("click", () => toggle(false));

  const actions = document.createElement("div");
  actions.className = "ad-actions";
  actions.innerHTML = `
    <button class="ad-btn primary" id="ad-save">Save</button>
    <button class="ad-btn" id="ad-restart">Restart app</button>
  `;
  d.querySelector(".ad-main")!.appendChild(actions);
  actions.querySelector("#ad-save")!.addEventListener("click", () => saveAll(d));
  actions.querySelector("#ad-restart")!.addEventListener("click", () => api?.restart?.());

  activate("preview");
  return d;
}

// ---------------------------------------------------------------------------
// Save: collect form values, push to electron-store + service
// ---------------------------------------------------------------------------
async function saveAll(root: HTMLElement) {
  const status = root.querySelector("#ad-status") as HTMLElement;
  const inputs = root.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-key]");
  const patch: Record<string, unknown> = {};
  inputs.forEach((el) => {
    const k = (el as any).dataset.key;
    const kind = (el as any).dataset.kind;
    let v: unknown;
    if (kind === "bool") v = (el as HTMLInputElement).checked;
    else if (kind === "number" || kind === "camera" || kind === "slider") v = Number(el.value);
    else v = el.value;
    patch[k] = v;
  });
  await api.updateSettings(patch);
  dispatchEvent(new CustomEvent("settings:changed"));
  const servicePatch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch))
    if (SERVICE_KEY_MAP[k]) servicePatch[SERVICE_KEY_MAP[k]] = v;
  if (Object.keys(servicePatch).length) send({ type: "admin:set_settings", patch: servicePatch });
  status.textContent = "saved ✓";
  setTimeout(() => (status.textContent = ""), 2000);
}

// ---------------------------------------------------------------------------
export async function toggle(force?: boolean) {
  if (!panel) panel = await build();
  const show = force ?? !panel.classList.contains("show");
  panel.classList.toggle("show", show);
  if (!show) {
    panel.querySelectorAll<HTMLImageElement>(".ad-cam img").forEach((i) => (i.src = ""));
  } else {
    // reactivate currently selected tab so MJPEG re-opens
    const active = panel.querySelector<HTMLButtonElement>(".ad-tab.active");
    if (active) active.click();
  }
}

api?.onAdminToggle?.(() => toggle());
