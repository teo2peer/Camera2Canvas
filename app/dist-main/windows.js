"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createWindows = createWindows;
const electron_1 = require("electron");
const settings_1 = require("./settings");
const path_1 = __importDefault(require("path"));
const devUrl = process.env.VITE_DEV_SERVER_URL || "http://localhost:5173";
function loadPage(win, page) {
    if (!electron_1.app.isPackaged)
        win.loadURL(`${devUrl}/${page}.html`);
    else
        win.loadFile(path_1.default.join(__dirname, `../dist-renderer/${page}.html`));
}
function createWindows() {
    const s = (0, settings_1.getSettings)();
    const displays = electron_1.screen.getAllDisplays();
    const wins = [];
    const pickDisplay = (id, fallbackIdx) => displays.find((d) => d.id === id) ?? displays[fallbackIdx] ?? displays[0];
    const worldDisplay = pickDisplay(s.worldDisplayId, 0);
    const worldWin = new electron_1.BrowserWindow({
        x: worldDisplay.bounds.x,
        y: worldDisplay.bounds.y,
        width: worldDisplay.bounds.width,
        height: worldDisplay.bounds.height,
        fullscreen: true,
        kiosk: s.kiosk,
        autoHideMenuBar: true,
        backgroundColor: "#000",
        webPreferences: { contextIsolation: true, preload: path_1.default.join(__dirname, "preload.js") },
    });
    loadPage(worldWin, "world");
    wins.push(worldWin);
    if (s.worldDisplayId == null)
        (0, settings_1.updateSettings)({ worldDisplayId: worldDisplay.id });
    if (s.monitorMode === "dual" && displays.length > 1) {
        const instrDisplay = pickDisplay(s.instructionsDisplayId, 1) === worldDisplay
            ? displays[1] ?? displays[0]
            : pickDisplay(s.instructionsDisplayId, 1);
        const instrWin = new electron_1.BrowserWindow({
            x: instrDisplay.bounds.x,
            y: instrDisplay.bounds.y,
            width: instrDisplay.bounds.width,
            height: instrDisplay.bounds.height,
            fullscreen: true,
            backgroundColor: "#000",
            webPreferences: { contextIsolation: true, preload: path_1.default.join(__dirname, "preload.js") },
        });
        loadPage(instrWin, "instructions");
        wins.push(instrWin);
        if (s.instructionsDisplayId == null)
            (0, settings_1.updateSettings)({ instructionsDisplayId: instrDisplay.id });
    }
    return wins;
}
