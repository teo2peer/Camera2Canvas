import { Scene } from "@babylonjs/core/scene";
import { Engine } from "@babylonjs/core/Engines/engine";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Vector3, Color3, Color4 } from "@babylonjs/core/Maths/math";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { IGameScene } from "../core/sceneManager";
import { connect, ServiceEvent } from "../core/ws";
import { library, DrawingRecord } from "../core/drawings";
import { attachBackground, detachBackground, BackgroundHandle } from "../core/background";

interface Slot { x: number; y: number; }
interface Item { mesh: Mesh; target: Slot; }

const SHAPES: Record<string, Slot[]> = {
  grid: gridSlots(8, 5, 1.6),
  heart: heartSlots(40),
  star: starSlots(32),
  circle: circleSlots(36),
};

function gridSlots(cols: number, rows: number, step: number): Slot[] {
  const out: Slot[] = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++)
    out.push({ x: (x - (cols - 1) / 2) * step, y: (y - (rows - 1) / 2) * step });
  return out;
}
function circleSlots(n: number, r = 6): Slot[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  });
}
function heartSlots(n: number): Slot[] {
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return { x: 0.5 * 16 * Math.sin(t) ** 3, y: 0.5 * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) };
  });
}
function starSlots(n: number): Slot[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    const r = i % 2 === 0 ? 7 : 3;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  });
}

export class ShapeOrganizerScene implements IGameScene {
  scene: Scene;
  private items: Item[] = [];
  private shape: Slot[] = SHAPES.grid;
  private bg: BackgroundHandle | null = null;

  constructor(engine: Engine, _canvas: HTMLCanvasElement) {
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.03, 0.03, 0.1, 1);
    this.scene = scene;
    attachBackground(scene).then((h) => (this.bg = h));
    const cam = new ArcRotateCamera("c", Math.PI / 2, Math.PI / 2.3, 22, Vector3.Zero(), scene);
    cam.attachControl(_canvas, false);
    cam.inputs.clear();
    new HemisphericLight("h", new Vector3(0, 1, 0), scene).intensity = 1;
    this.applyShape();

    connect((ev: ServiceEvent) => {
      if ((ev as any).type === "shape_command") {
        const name = (ev as any).shape as string;
        if (SHAPES[name]) { this.shape = SHAPES[name]; this.applyShape(); }
      }
    });
  }

  private makeItem(d: DrawingRecord | null): Mesh {
    const m = MeshBuilder.CreatePlane("i", { size: 1.3, sideOrientation: Mesh.DOUBLESIDE }, this.scene);
    const mat = new StandardMaterial("im", this.scene);
    if (d) {
      const tex = new Texture(d.url, this.scene, true, true);
      tex.hasAlpha = true;
      mat.diffuseTexture = tex;
      mat.useAlphaFromDiffuseTexture = true;
    } else {
      mat.diffuseColor = new Color3(0.6, 0.6, 0.9);
    }
    mat.emissiveColor = new Color3(0.4, 0.4, 0.4);
    mat.backFaceCulling = false;
    m.material = mat;
    m.position.set((Math.random() - 0.5) * 16, (Math.random() - 0.5) * 10, 0);
    return m;
  }

  applyShape() {
    for (const it of this.items) it.mesh.dispose();
    this.items = [];
    const slots = this.shape;
    const pool = library.list;
    for (let i = 0; i < slots.length; i++) {
      const d = pool[i % Math.max(1, pool.length)] || null;
      const mesh = this.makeItem(d);
      this.items.push({ mesh, target: slots[i] });
    }
  }

  update(dt: number) {
    const k = Math.min(1, dt * 3);
    for (const it of this.items) {
      it.mesh.position.x += (it.target.x - it.mesh.position.x) * k;
      it.mesh.position.y += (it.target.y - it.mesh.position.y) * k;
    }
  }
  dispose() { detachBackground(this.bg); this.bg = null; this.scene.dispose(); }
}
