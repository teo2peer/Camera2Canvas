import { Scene } from "@babylonjs/core/scene";
import { Engine } from "@babylonjs/core/Engines/engine";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Vector3, Color3, Color4 } from "@babylonjs/core/Maths/math";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { Layer } from "@babylonjs/core/Layers/layer";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { IGameScene } from "../core/sceneManager";
import type { ServiceEvent } from "../core/ws";
import { spawnPortal } from "../fx/portal";
import { sfx } from "../core/sfx";
import { attachBackground, detachBackground, BackgroundHandle } from "../core/background";

interface FloatingDrawing {
  id?: string;          // optional library id, used to drop the mesh on delete
  mesh: Mesh;
  vx: number;
  vy: number;
  vz: number;
  rot: number;
  baseY: number;
  phase: number;
}

function hexToColor3(h: string): Color3 {
  const c = (h ?? "#888888").replace("#", "");
  return new Color3(
    parseInt(c.slice(0, 2), 16) / 255,
    parseInt(c.slice(2, 4), 16) / 255,
    parseInt(c.slice(4, 6), 16) / 255,
  );
}

export class WorldScene implements IGameScene {
  scene: Scene;
  private camera: ArcRotateCamera;
  private drawings: FloatingDrawing[] = [];
  private particles?: ParticleSystem;
  private bg: BackgroundHandle | null = null;
  private pipeline: DefaultRenderingPipeline;
  private settings: any = null;
  private floatAmp = 0.4;
  private particleSpeed = 0.8;
  private gridMeshes: Mesh[] = [];
  private gridActive = false;
  private gridTimer: number | null = null;

  constructor(engine: Engine, canvas: HTMLCanvasElement) {
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.02, 0.02, 0.07, 1);
    this.scene = scene;

    this.camera = new ArcRotateCamera("cam", Math.PI / 2, Math.PI / 2.2, 18, Vector3.Zero(), scene);
    this.camera.minZ = 0.1;
    this.camera.attachControl(canvas, false);
    this.camera.inputs.clear();

    const light = new HemisphericLight("h", new Vector3(0, 1, 0), scene);
    light.intensity = 0.85;
    light.groundColor = new Color3(0.1, 0.1, 0.3);

    this.pipeline = new DefaultRenderingPipeline("post", true, scene, [this.camera]);
    this.pipeline.bloomEnabled = true;
    this.pipeline.bloomThreshold = 0.6;
    this.pipeline.bloomScale = 0.6;
    this.pipeline.fxaaEnabled = true;
    this.pipeline.imageProcessing.vignetteEnabled = true;

    attachBackground(scene).then((h) => (this.bg = h));
    this.applySettings();
    addEventListener("settings:changed", () => this.applySettings());
    addEventListener("settings:live", (e: any) => this.applyLive(e.detail.key, e.detail.value));
  }

  // ---- Hub look (extras on top of the shared background) ----------------
  private async applySettings() {
    const s = await (window as any).api?.getSettings?.();
    if (!s) return;
    this.settings = s;
    this.applyLive("hubAccent", s.hubAccent);
    this.applyLive("hubBloom", s.hubBloom);
    this.applyLive("hubVignette", s.hubVignette);
    this.applyLive("hubParticleCount", s.hubParticleCount);
    this.applyLive("hubParticleSpeed", s.hubParticleSpeed);
    this.applyLive("hubFloatAmp", s.hubFloatAmp);
  }

  private applyLive(key: string, value: any) {
    if (!this.settings) this.settings = {};
    this.settings[key] = value;
    switch (key) {
      case "hubAccent":
        if (this.particles) {
          const c = hexToColor3(value);
          this.particles.color1 = new Color4(c.r, c.g, c.b, 0.6);
          this.particles.color2 = new Color4(c.r * 0.6, c.g * 0.8, 1, 0.4);
        }
        break;
      case "hubBloom":
        this.pipeline.bloomWeight = Number(value);
        break;
      case "hubVignette":
        this.pipeline.imageProcessing.vignetteWeight = Number(value);
        break;
      case "hubParticleCount":
        this.rebuildParticles(Number(value));
        break;
      case "hubParticleSpeed":
        this.particleSpeed = Number(value);
        if (this.particles) {
          this.particles.minEmitPower = 0.2 * this.particleSpeed;
          this.particles.maxEmitPower = 1.2 * this.particleSpeed;
        }
        break;
      case "hubFloatAmp":
        this.floatAmp = Number(value);
        break;
    }
  }

  private rebuildParticles(count: number) {
    this.particles?.dispose();
    this.particles = undefined;
    if (count <= 0) return;
    const ps = new ParticleSystem("amb", count, this.scene);
    ps.emitter = Vector3.Zero();
    ps.minEmitBox = new Vector3(-15, -10, -8);
    ps.maxEmitBox = new Vector3(15, 10, 8);
    const accent = hexToColor3(this.settings?.hubAccent ?? "#7fb0ff");
    ps.color1 = new Color4(accent.r, accent.g, accent.b, 0.6);
    ps.color2 = new Color4(accent.r * 0.6, accent.g * 0.8, 1, 0.4);
    ps.colorDead = new Color4(0, 0, 0, 0);
    ps.minSize = 0.04; ps.maxSize = 0.12;
    ps.minLifeTime = 4; ps.maxLifeTime = 9;
    ps.emitRate = Math.min(200, count / 3);
    ps.gravity = Vector3.Zero();
    ps.direction1 = new Vector3(-0.1, 0.05, 0);
    ps.direction2 = new Vector3(0.1, 0.15, 0);
    ps.minEmitPower = 0.2 * this.particleSpeed;
    ps.maxEmitPower = 1.2 * this.particleSpeed;
    ps.start();
    this.particles = ps;
  }

  // ---- Drawings ----------------------------------------------------------
  removeDrawing(id: string) {
    this.drawings = this.drawings.filter((d) => {
      if (d.id === id) { d.mesh.dispose(); return false; }
      return true;
    });
  }

  addDrawing(url: string, palette: string[], aspect: number, withPortal = false, id?: string) {
    const w = 2.5;
    const h = w / Math.max(0.2, aspect);
    const plane = MeshBuilder.CreatePlane("d", { width: w, height: h, sideOrientation: Mesh.DOUBLESIDE }, this.scene);
    // Always face the camera squarely (no random tilt) so orientation is preserved.
    const pos = new Vector3((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 4);
    plane.position = pos;
    plane.rotation.y = 0;
    if (withPortal) {
      spawnPortal(this.scene, pos.clone(), palette, 3.0);
      sfx.portal();
      plane.scaling.setAll(0.01);
      const start = performance.now();
      const obs = this.scene.onBeforeRenderObservable.add(() => {
        const t = Math.min(1, (performance.now() - start) / 2500);
        const k = t < 0.5 ? 0 : (t - 0.5) * 2;
        plane.scaling.setAll(k);
        if (t >= 1) this.scene.onBeforeRenderObservable.remove(obs);
      });
    }

    const mat = new StandardMaterial("dm", this.scene);
    const tex = new Texture(url, this.scene, true, true);
    tex.hasAlpha = true;
    mat.diffuseTexture = tex;
    mat.useAlphaFromDiffuseTexture = true;
    mat.emissiveColor = new Color3(0.4, 0.4, 0.5);
    mat.backFaceCulling = false;
    plane.material = mat;

    this.drawings.push({
      id,
      mesh: plane,
      // Velocities/rotation are stored unconditionally; whether they actually
      // get *applied* each frame is gated by hubDrawingDrift / hubDrawingRotate
      // / hubDrawingFloat in update(), so toggling them in admin starts/stops
      // motion without re-spawning anything.
      vx: (Math.random() - 0.5) * 0.4,
      vy: (Math.random() - 0.5) * 0.2,
      vz: (Math.random() - 0.5) * 0.2,
      rot: (Math.random() - 0.5) * 0.3,
      baseY: plane.position.y,
      phase: Math.random() * Math.PI * 2,
    });
  }

  update(dt: number) {
    if (this.gridActive) return;
    const t = performance.now() / 1000;
    const drift  = this.settings?.hubDrawingDrift  === true;
    const rotate = this.settings?.hubDrawingRotate === true;
    const float  = this.settings?.hubDrawingFloat !== false; // default ON
    for (const d of this.drawings) {
      if (drift) {
        d.mesh.position.x += d.vx * dt;
        d.mesh.position.z += d.vz * dt;
        if (Math.abs(d.mesh.position.x) > 12) d.vx *= -1;
        if (Math.abs(d.mesh.position.z) > 7)  d.vz *= -1;
      }
      d.mesh.position.y = float
        ? d.baseY + Math.sin(t * 0.6 + d.phase) * this.floatAmp
        : d.baseY;
      if (rotate) {
        d.mesh.rotation.z += d.rot * dt * 0.1;
      } else {
        d.mesh.rotation.z = 0;
      }
    }
  }

  // ---- Grid mosaic mode --------------------------------------------------
  private startGridMode(cells: { filled: boolean; hex: string }[][], rows: number, cols: number) {
    this.endGridMode();
    if (this.drawings.length === 0) return;
    this.gridActive = true;

    sfx.drop();

    for (const d of this.drawings) d.mesh.setEnabled(false);

    const planeW = 26;
    const planeH = planeW * (rows / cols);
    const cellW = planeW / cols;
    const cellH = planeH / rows;
    const baseW = 2.5;
    const targetScale = Math.min(cellW, cellH) / baseW;

    // Build the list of target cells.
    const targets: { x: number; y: number }[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!cells[r]?.[c]?.filled) continue;
        targets.push({
          x: -planeW / 2 + cellW * (c + 0.5),
          y: planeH / 2 - cellH * (r + 0.5),
        });
      }
    }
    if (targets.length === 0) return;

    // Spawn one mesh per target. Cycle through existing drawings to fill;
    // each clone starts at a random off-screen-ish position and tweens in.
    type Anim = { mesh: Mesh; sx: number; sy: number; ssc: number; tx: number; ty: number; tsc: number; t0: number };
    const anims: Anim[] = [];
    const stagger = 600 / Math.max(1, targets.length); // total ramp-up ~600ms

    targets.forEach((tgt, i) => {
      const src = this.drawings[i % this.drawings.length].mesh;
      const m = src.clone(`gc_${i}`)!;
      m.setEnabled(true);
      m.rotation.set(0, 0, 0);
      // Random start position scattered across a large area around the camera.
      const sx = (Math.random() - 0.5) * planeW * 1.6;
      const sy = (Math.random() - 0.5) * planeH * 1.8;
      m.position.x = sx;
      m.position.y = sy;
      m.position.z = (Math.random() - 0.5) * 4;
      const ssc = src.scaling.x || 1;
      m.scaling.setAll(ssc);
      this.gridMeshes.push(m);
      anims.push({
        mesh: m,
        sx, sy, ssc,
        tx: tgt.x, ty: tgt.y, tsc: targetScale,
        t0: performance.now() + i * stagger,
      });
    });

    const duration = 900; // ms per mesh travel
    const obs = this.scene.onBeforeRenderObservable.add(() => {
      const now = performance.now();
      let alive = 0;
      for (const a of anims) {
        const t = (now - a.t0) / duration;
        if (t <= 0) { alive++; continue; }
        if (t >= 1) {
          a.mesh.position.x = a.tx;
          a.mesh.position.y = a.ty;
          a.mesh.position.z = 0;
          a.mesh.scaling.setAll(a.tsc);
          continue;
        }
        alive++;
        // ease-out cubic
        const k = 1 - Math.pow(1 - t, 3);
        a.mesh.position.x = a.sx + (a.tx - a.sx) * k;
        a.mesh.position.y = a.sy + (a.ty - a.sy) * k;
        a.mesh.position.z = (1 - k) * a.mesh.position.z;
        a.mesh.scaling.setAll(a.ssc + (a.tsc - a.ssc) * k);
      }
      if (alive === 0) this.scene.onBeforeRenderObservable.remove(obs);
    });

    if (this.gridTimer !== null) clearTimeout(this.gridTimer);
    this.gridTimer = window.setTimeout(() => this.endGridMode(), 30000);
  }

  private endGridMode() {
    if (this.gridTimer !== null) { clearTimeout(this.gridTimer); this.gridTimer = null; }
    if (!this.gridActive) return;
    this.gridActive = false;
    for (const m of this.gridMeshes) m.dispose();
    this.gridMeshes = [];
    for (const d of this.drawings) d.mesh.setEnabled(true);
  }

  handleEvent(ev: ServiceEvent) {
    if (ev.type === "drawing_captured") {
      if (this.gridActive) this.endGridMode();
      this.addDrawing(ev.url, ev.palette, ev.w / Math.max(1, ev.h), true);
    } else if (ev.type === "drawings_list") {
      for (const d of ev.items) this.addDrawing(d.url, d.palette, 1);
    } else if ((ev as any).type === "grid_scanned") {
      const g = ev as any;
      this.startGridMode(g.cells, g.rows, g.cols);
    }
  }

  dispose() {
    this.endGridMode();
    this.particles?.dispose();
    detachBackground(this.bg); this.bg = null;
    this.scene.dispose();
  }
}
