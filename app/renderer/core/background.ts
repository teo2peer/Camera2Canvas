/**
 * Shared scene background. Reads the hub-background settings (image or
 * gradient) from electron-store and applies them as a Babylon Layer behind
 * the 3D scene. Used by every minigame so the operator's chosen look is
 * persistent across sessions AND consistent across games.
 *
 * Reacts live to:
 *   - "settings:changed"  (saved from admin)
 *   - "settings:live"     (slider/colour-picker drag from admin)
 *
 * Each scene calls ``attachBackground(scene)`` once in its constructor and
 * ``detachBackground(handle)`` in its ``dispose()``.
 */
import { Scene } from "@babylonjs/core/scene";
import { Layer } from "@babylonjs/core/Layers/layer";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color4 } from "@babylonjs/core/Maths/math";

const RELEVANT_KEYS = new Set(["hubBgTop", "hubBgBottom", "hubBgImage"]);

export interface BackgroundHandle {
  scene: Scene;
  layer: Layer | null;
  onChanged: (e?: Event) => void;
}

function hexToRgb01(hex: string): { r: number; g: number; b: number } {
  const h = (hex ?? "#000000").replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
}

export async function attachBackground(scene: Scene): Promise<BackgroundHandle> {
  const handle: BackgroundHandle = { scene, layer: null, onChanged: () => {} };

  function ensureLayer() {
    if (!handle.layer || (handle.layer as any).isDisposed) {
      handle.layer = new Layer("scene-bg", null, scene, true);
    }
  }

  function setTextureFromUrl(url: string) {
    ensureLayer();
    handle.layer!.texture?.dispose();
    handle.layer!.texture = new Texture(url, scene, true, true);
  }

  function paintGradient(top: string, bottom: string) {
    const c = document.createElement("canvas");
    c.width = 4; c.height = 256;
    const ctx = c.getContext("2d")!;
    const g = ctx.createLinearGradient(0, 0, 0, c.height);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);
    setTextureFromUrl(c.toDataURL("image/png"));
    const b = hexToRgb01(bottom);
    scene.clearColor = new Color4(b.r, b.g, b.b, 1);
  }

  async function apply() {
    if (scene.isDisposed) return;
    const s = await (window as any).api?.getSettings?.();
    if (!s) {
      paintGradient("#05060f", "#0e1230");
      return;
    }
    if (s.hubBgImage) {
      try {
        const dataUrl = await (window as any).api?.loadImageDataUrl?.(s.hubBgImage);
        if (dataUrl && !scene.isDisposed) {
          setTextureFromUrl(dataUrl);
          scene.clearColor = new Color4(0, 0, 0, 1);
          return;
        }
      } catch { /* fall through to gradient */ }
    }
    paintGradient(s.hubBgTop ?? "#05060f", s.hubBgBottom ?? "#0e1230");
  }

  await apply();

  handle.onChanged = (e?: Event) => {
    const ev = e as CustomEvent | undefined;
    // settings:live carries a key; only re-apply for background-relevant ones.
    if (ev?.type === "settings:live") {
      const k = (ev.detail as any)?.key;
      if (k && !RELEVANT_KEYS.has(k)) return;
    }
    apply();
  };
  addEventListener("settings:changed", handle.onChanged);
  addEventListener("settings:live", handle.onChanged);

  return handle;
}

export function detachBackground(h: BackgroundHandle | null) {
  if (!h) return;
  removeEventListener("settings:changed", h.onChanged);
  removeEventListener("settings:live", h.onChanged);
  try { h.layer?.dispose(); } catch { /* ignore */ }
  h.layer = null;
}
