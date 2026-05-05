import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (patch: unknown) => ipcRenderer.invoke("settings:update", patch),
  onAdminToggle: (cb: () => void) => ipcRenderer.on("admin:toggle", cb),
  restart: () => ipcRenderer.invoke("app:restart"),
  openExternal: (url: string) => ipcRenderer.invoke("shell:open", url),
  pickImage: () => ipcRenderer.invoke("dialog:pickImage"),
  loadImageDataUrl: (filePath: string) => ipcRenderer.invoke("file:imageDataUrl", filePath),
});
