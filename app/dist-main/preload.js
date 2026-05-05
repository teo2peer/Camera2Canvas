"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld("api", {
    getSettings: () => electron_1.ipcRenderer.invoke("settings:get"),
    updateSettings: (patch) => electron_1.ipcRenderer.invoke("settings:update", patch),
    onAdminToggle: (cb) => electron_1.ipcRenderer.on("admin:toggle", cb),
    restart: () => electron_1.ipcRenderer.invoke("app:restart"),
    openExternal: (url) => electron_1.ipcRenderer.invoke("shell:open", url),
    pickImage: () => electron_1.ipcRenderer.invoke("dialog:pickImage"),
    loadImageDataUrl: (filePath) => electron_1.ipcRenderer.invoke("file:imageDataUrl", filePath),
});
