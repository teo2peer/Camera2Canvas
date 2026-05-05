import Store from "electron-store";

export type ScanTrigger = "auto" | "gesture" | "auto+gesture";
export type CameraMode = "overhead" | "front" | "both";
export type BgRemoval = "threshold" | "ml";

export interface AppSettings {
  monitorMode: "single" | "dual";
  instructionsDisplayId: number | null;
  worldDisplayId: number | null;
  scanTrigger: ScanTrigger;
  cameraMode: CameraMode;
  overheadCameraIndex: number;
  frontCameraIndex: number;
  bgRemoval: BgRemoval;
  ledCount: number;
  ledSerialPort: string;
  gestureSensitivity: number;
  adminHotkey: string;
  serviceUrl: string;
  kiosk: boolean;
  mirrorOverhead: boolean;
  mirrorFront: boolean;
  cameraOverlay: boolean;
  cameraOverlaySource: "overhead" | "front";
  instructionsPreview: boolean;

  // Hub (world) look & feel
  hubBgTop: string;            // hex
  hubBgBottom: string;         // hex
  hubBgImage: string;          // absolute path to an image; empty = use gradient
  hubAccent: string;           // hex
  hubBloom: number;            // 0..1
  hubVignette: number;         // 0..2
  hubParticleCount: number;    // 0..2000
  hubParticleSpeed: number;    // 0..2
  hubFloatAmp: number;         // 0..2
  hubDrawingDrift: boolean;    // horizontal/depth drift across the canvas
  hubDrawingRotate: boolean;   // slow z-axis rotation
  hubDrawingFloat: boolean;    // gentle vertical bob
  theme: "dark" | "light";
  ambientSound: boolean;
  musicMood: "calm" | "magical" | "adventure" | "mystic";
  musicVolume: number;     // 0..1 master gain
  musicTempo: number;      // BPM
}

const defaults: AppSettings = {
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

export const store = new Store<AppSettings>({ defaults });
export const getSettings = (): AppSettings => store.store;
export const updateSettings = (patch: Partial<AppSettings>) => {
  for (const [k, v] of Object.entries(patch)) store.set(k, v as never);
};
