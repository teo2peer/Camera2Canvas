import { app, BrowserWindow, screen } from "electron";
import { getSettings, updateSettings } from "./settings";
import path from "path";

const devUrl = process.env.VITE_DEV_SERVER_URL || "http://localhost:5173";

function loadPage(win: BrowserWindow, page: "world" | "instructions") {
  if (!app.isPackaged) win.loadURL(`${devUrl}/${page}.html`);
  else win.loadFile(path.join(__dirname, `../dist-renderer/${page}.html`));
}

export function createWindows(): BrowserWindow[] {
  const s = getSettings();
  const displays = screen.getAllDisplays();
  const wins: BrowserWindow[] = [];

  const pickDisplay = (id: number | null, fallbackIdx: number) =>
    displays.find((d) => d.id === id) ?? displays[fallbackIdx] ?? displays[0];

  const worldDisplay = pickDisplay(s.worldDisplayId, 0);
  const worldWin = new BrowserWindow({
    x: worldDisplay.bounds.x,
    y: worldDisplay.bounds.y,
    width: worldDisplay.bounds.width,
    height: worldDisplay.bounds.height,
    fullscreen: true,
    kiosk: s.kiosk,
    autoHideMenuBar: true,
    backgroundColor: "#000",
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, "preload.js") },
  });
  loadPage(worldWin, "world");
  wins.push(worldWin);
  if (s.worldDisplayId == null) updateSettings({ worldDisplayId: worldDisplay.id });

  if (s.monitorMode === "dual" && displays.length > 1) {
    const instrDisplay =
      pickDisplay(s.instructionsDisplayId, 1) === worldDisplay
        ? displays[1] ?? displays[0]
        : pickDisplay(s.instructionsDisplayId, 1);
    const instrWin = new BrowserWindow({
      x: instrDisplay.bounds.x,
      y: instrDisplay.bounds.y,
      width: instrDisplay.bounds.width,
      height: instrDisplay.bounds.height,
      fullscreen: true,
      backgroundColor: "#000",
      webPreferences: { contextIsolation: true, preload: path.join(__dirname, "preload.js") },
    });
    loadPage(instrWin, "instructions");
    wins.push(instrWin);
    if (s.instructionsDisplayId == null) updateSettings({ instructionsDisplayId: instrDisplay.id });
  }

  return wins;
}
