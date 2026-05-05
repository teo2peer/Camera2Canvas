import { app, ipcMain, globalShortcut, shell, dialog, BrowserWindow } from "electron";
import path from "path";
import fs from "fs";
import { createWindows } from "./windows";
import { getSettings, updateSettings } from "./settings";
import { startService, stopService } from "./python";

const ROOT = path.resolve(__dirname, "..", "..");

app.whenReady().then(async () => {
  if (process.env.START_SERVICE !== "0") await startService(ROOT);

  ipcMain.handle("settings:get", () => getSettings());
  ipcMain.handle("settings:update", (_e, patch) => {
    updateSettings(patch);
    return getSettings();
  });
  ipcMain.handle("app:restart", () => {
    app.relaunch();
    app.exit(0);
  });
  ipcMain.handle("shell:open", (_e, url: string) => shell.openExternal(url));
  ipcMain.handle("dialog:pickImage", async (e) => {
    // Find the parent window so the dialog can't get hidden behind a
    // fullscreen / kiosk Electron window. Falls back to the first open window.
    const senderWin = BrowserWindow.fromWebContents(e.sender);
    const parent = senderWin ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (parent) {
      // Drop kiosk/fullscreen briefly so OS can render the modal on top.
      const wasKiosk = parent.isKiosk();
      const wasFs = parent.isFullScreen();
      if (wasKiosk) parent.setKiosk(false);
      if (wasFs) parent.setFullScreen(false);
      try {
        const r = await dialog.showOpenDialog(parent, {
          title: "Pick a hub background image",
          properties: ["openFile"],
          filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
        });
        return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
      } finally {
        if (wasFs) parent.setFullScreen(true);
        if (wasKiosk) parent.setKiosk(true);
        parent.focus();
      }
    }
    const r = await dialog.showOpenDialog({
      title: "Pick a hub background image",
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
    });
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });
  ipcMain.handle("file:imageDataUrl", async (_e, filePath: string) => {
    if (!filePath) return null;
    try {
      const buf = await fs.promises.readFile(filePath);
      const ext = (path.extname(filePath).slice(1) || "png").toLowerCase();
      const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      return `data:${mime};base64,${buf.toString("base64")}`;
    } catch {
      return null;
    }
  });

  const wins = createWindows();

  const hotkey = getSettings().adminHotkey;
  globalShortcut.register(hotkey, () => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send("admin:toggle");
  });
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  stopService();
});
app.on("before-quit", () => stopService());
process.on("SIGINT", () => { stopService(); app.quit(); });
process.on("SIGTERM", () => { stopService(); app.quit(); });
process.on("exit", () => stopService());

app.on("window-all-closed", () => app.quit());
