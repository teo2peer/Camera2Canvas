"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateSettings = exports.getSettings = exports.store = void 0;
const electron_store_1 = __importDefault(require("electron-store"));
const defaults = {
    monitorMode: "dual",
    instructionsDisplayId: null,
    worldDisplayId: null,
    scanTrigger: "auto+gesture",
    cameraMode: "overhead",
    overheadCameraIndex: 0,
    frontCameraIndex: 1,
    bgRemoval: "threshold",
    ledCount: 300,
    ledSerialPort: "",
    gestureSensitivity: 0.7,
    adminHotkey: "F9",
    serviceUrl: "ws://127.0.0.1:8765/ws",
    kiosk: false,
    mirrorOverhead: false,
    mirrorFront: true,
    cameraOverlay: false,
    cameraOverlaySource: "overhead",
    instructionsPreview: true,
    hubBgTop: "#05060f",
    hubBgBottom: "#0e1230",
    hubBgImage: "",
    hubAccent: "#7fb0ff",
    hubBloom: 0.5,
    hubVignette: 1.3,
    hubParticleCount: 600,
    hubParticleSpeed: 0.8,
    hubFloatAmp: 0.4,
    hubDrawingDrift: false,
    hubDrawingRotate: false,
    hubDrawingFloat: true,
    theme: "dark",
    ambientSound: true,
    musicMood: "magical",
    musicVolume: 0.55,
    musicTempo: 80,
};
exports.store = new electron_store_1.default({ defaults });
const getSettings = () => exports.store.store;
exports.getSettings = getSettings;
const updateSettings = (patch) => {
    for (const [k, v] of Object.entries(patch))
        exports.store.set(k, v);
};
exports.updateSettings = updateSettings;
