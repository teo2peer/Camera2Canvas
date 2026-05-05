"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const windows_1 = require("./windows");
const settings_1 = require("./settings");
const python_1 = require("./python");
const ROOT = path_1.default.resolve(__dirname, "..", "..");
electron_1.app.whenReady().then(async () => {
    if (process.env.START_SERVICE !== "0")
        await (0, python_1.startService)(ROOT);
    electron_1.ipcMain.handle("settings:get", () => (0, settings_1.getSettings)());
    electron_1.ipcMain.handle("settings:update", (_e, patch) => {
        (0, settings_1.updateSettings)(patch);
        return (0, settings_1.getSettings)();
    });
    electron_1.ipcMain.handle("app:restart", () => {
        electron_1.app.relaunch();
        electron_1.app.exit(0);
    });
    electron_1.ipcMain.handle("shell:open", (_e, url) => electron_1.shell.openExternal(url));
    electron_1.ipcMain.handle("dialog:pickImage", async (e) => {
        // Find the parent window so the dialog can't get hidden behind a
        // fullscreen / kiosk Electron window. Falls back to the first open window.
        const senderWin = electron_1.BrowserWindow.fromWebContents(e.sender);
        const parent = senderWin ?? electron_1.BrowserWindow.getFocusedWindow() ?? electron_1.BrowserWindow.getAllWindows()[0];
        if (parent) {
            // Drop kiosk/fullscreen briefly so OS can render the modal on top.
            const wasKiosk = parent.isKiosk();
            const wasFs = parent.isFullScreen();
            if (wasKiosk)
                parent.setKiosk(false);
            if (wasFs)
                parent.setFullScreen(false);
            try {
                const r = await electron_1.dialog.showOpenDialog(parent, {
                    title: "Pick a hub background image",
                    properties: ["openFile"],
                    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
                });
                return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
            }
            finally {
                if (wasFs)
                    parent.setFullScreen(true);
                if (wasKiosk)
                    parent.setKiosk(true);
                parent.focus();
            }
        }
        const r = await electron_1.dialog.showOpenDialog({
            title: "Pick a hub background image",
            properties: ["openFile"],
            filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
        });
        return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
    });
    electron_1.ipcMain.handle("file:imageDataUrl", async (_e, filePath) => {
        if (!filePath)
            return null;
        try {
            const buf = await fs_1.default.promises.readFile(filePath);
            const ext = (path_1.default.extname(filePath).slice(1) || "png").toLowerCase();
            const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
            return `data:${mime};base64,${buf.toString("base64")}`;
        }
        catch {
            return null;
        }
    });
    const wins = (0, windows_1.createWindows)();
    const hotkey = (0, settings_1.getSettings)().adminHotkey;
    electron_1.globalShortcut.register(hotkey, () => {
        for (const w of electron_1.BrowserWindow.getAllWindows())
            w.webContents.send("admin:toggle");
    });
});
electron_1.app.on("will-quit", () => {
    electron_1.globalShortcut.unregisterAll();
    (0, python_1.stopService)();
});
electron_1.app.on("before-quit", () => (0, python_1.stopService)());
process.on("SIGINT", () => { (0, python_1.stopService)(); electron_1.app.quit(); });
process.on("SIGTERM", () => { (0, python_1.stopService)(); electron_1.app.quit(); });
process.on("exit", () => (0, python_1.stopService)());
electron_1.app.on("window-all-closed", () => electron_1.app.quit());
