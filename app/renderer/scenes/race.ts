import { Scene } from "@babylonjs/core/scene";
import { Engine } from "@babylonjs/core/Engines/engine";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Vector3, Color3, Color4 } from "@babylonjs/core/Maths/math";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
import type { IGameScene } from "../core/sceneManager";
import { input } from "../core/input";
import { library } from "../core/drawings";
import { sfx } from "../core/sfx";
import { setHud, updateStats, hideHud } from "../core/hud";
import { attachBackground, detachBackground, BackgroundHandle } from "../core/background";

interface Enemy { mesh: Mesh; lane: number; speed: number; }

const ROAD_HALF = 5.5;            // road extends from -5.5 to +5.5
const ROAD_LEN  = 240;            // tile length used for stripes/road tiles
const TILE_COUNT = 4;
const STRIPE_SPACING = 6;

export class RaceScene implements IGameScene {
  scene: Scene;
  private cam: FreeCamera;
  private playerMesh!: Mesh;
  private playerZ = 8;       // world-z of the player
  private playerX = 0;
  private playerSpeed = 0;
  private enemies: Enemy[] = [];
  private stripes: Mesh[] = [];
  private roadTiles: Mesh[] = [];
  private spawnTimer = 0;
  private distance = 0;
  private hp = 3;
  private bg: BackgroundHandle | null = null;

  constructor(engine: Engine, _canvas: HTMLCanvasElement) {
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.02, 0.04, 0.12, 1);
    this.scene = scene;
    attachBackground(scene).then((h) => (this.bg = h));
    this.cam = new FreeCamera("cam", new Vector3(0, 6, -10), scene);
    new HemisphericLight("h", new Vector3(0, 1, 0), scene).intensity = 0.95;
    const post = new DefaultRenderingPipeline("post", true, scene, [this.cam]);
    post.bloomEnabled = true; post.bloomWeight = 0.55; post.fxaaEnabled = true;

    // road tiles, recycled — we move them forward when they fall behind
    for (let i = 0; i < TILE_COUNT; i++) {
      const t = MeshBuilder.CreateGround("rd", { width: ROAD_HALF * 2, height: ROAD_LEN }, scene);
      t.position.z = i * ROAD_LEN;
      const rmat = new StandardMaterial("rm", scene);
      rmat.diffuseColor = new Color3(0.06, 0.07, 0.1);
      rmat.emissiveColor = new Color3(0.02, 0.02, 0.04);
      t.material = rmat;
      this.roadTiles.push(t);
    }

    // central yellow lane stripes — recycled forward
    for (let i = 0; i < (ROAD_LEN * TILE_COUNT) / STRIPE_SPACING; i++) {
      const s = MeshBuilder.CreateBox("s", { width: 0.4, height: 0.04, depth: 1.6 }, scene);
      s.position.set(0, 0.03, i * STRIPE_SPACING);
      const sm = new StandardMaterial("sm", scene);
      sm.emissiveColor = new Color3(1, 0.9, 0.3);
      sm.disableLighting = true;
      s.material = sm;
      this.stripes.push(s);
    }

    // road shoulders (visual)
    for (const sx of [-ROAD_HALF - 0.2, ROAD_HALF + 0.2]) {
      const wall = MeshBuilder.CreateBox("w", { width: 0.4, height: 0.6, depth: ROAD_LEN * TILE_COUNT }, scene);
      wall.position.set(sx, 0.3, ROAD_LEN * TILE_COUNT * 0.5);
      const wm = new StandardMaterial("wm", scene);
      wm.emissiveColor = new Color3(0.4, 0.6, 1);
      wall.material = wm;
    }

    this.spawnPlayer();

    setHud({
      title: "Speed Race",
      lines: [
        "Steer: ←/→ or A/D",
        "Brake / Boost: ↓ / ↑",
        "Avoid the red cars",
        "3 hits and the run ends",
      ],
      stats: { Distance: 0, Speed: 0, HP: this.hp },
    });
  }

  private spawnPlayer() {
    const m = MeshBuilder.CreatePlane("r", { size: 2.2, sideOrientation: Mesh.DOUBLESIDE }, this.scene);
    m.position.set(this.playerX, 1.1, this.playerZ);
    const mat = new StandardMaterial("rm", this.scene);
    const d = library.latest();
    if (d) {
      const tex = new Texture(d.url, this.scene, true, true);
      tex.hasAlpha = true;
      mat.diffuseTexture = tex;
      mat.useAlphaFromDiffuseTexture = true;
    } else {
      mat.diffuseColor = new Color3(0.95, 0.7, 0.3);
    }
    mat.emissiveColor = new Color3(0.35, 0.35, 0.35);
    mat.backFaceCulling = false;
    m.material = mat;
    this.playerMesh = m;
  }

  private spawnEnemy(zAhead: number) {
    const m = MeshBuilder.CreatePlane("e", { size: 2, sideOrientation: Mesh.DOUBLESIDE }, this.scene);
    const lane = (Math.floor(Math.random() * 3) - 1) * 2.5; // -2.5 / 0 / +2.5
    m.position.set(lane, 1, this.playerZ + zAhead);
    const mat = new StandardMaterial("em", this.scene);
    const pool = library.list;
    if (pool.length) {
      const tex = new Texture(pool[Math.floor(Math.random() * pool.length)].url, this.scene, true, true);
      tex.hasAlpha = true;
      mat.diffuseTexture = tex;
      mat.useAlphaFromDiffuseTexture = true;
    } else {
      mat.diffuseColor = new Color3(0.9, 0.25, 0.25);
    }
    mat.emissiveColor = new Color3(0.45, 0.1, 0.1);
    mat.backFaceCulling = false;
    m.material = mat;
    this.enemies.push({ mesh: m, lane, speed: 8 + Math.random() * 6 });
  }

  update(dt: number) {
    const s = input.poll();

    // throttle / brake — base 22, ↑ boosts up to 36, ↓ slows to 14
    const throttle = s.axes.y < 0 ? 1 : s.axes.y > 0 ? -1 : 0;
    const target = throttle > 0 ? 36 : throttle < 0 ? 14 : 24;
    this.playerSpeed += (target - this.playerSpeed) * Math.min(1, dt * 1.4);

    // steering
    this.playerX = Math.max(-ROAD_HALF + 1, Math.min(ROAD_HALF - 1, this.playerX + s.axes.x * 14 * dt));

    // forward motion
    this.playerZ += this.playerSpeed * dt;
    this.distance += this.playerSpeed * dt;
    this.playerMesh.position.x = this.playerX;
    this.playerMesh.position.z = this.playerZ;

    // recycle road tiles forward as we move
    for (const t of this.roadTiles) {
      if (t.position.z + ROAD_LEN / 2 < this.playerZ - 20) {
        t.position.z += ROAD_LEN * TILE_COUNT;
      }
    }
    // recycle lane stripes forward
    for (const st of this.stripes) {
      if (st.position.z < this.playerZ - 20) {
        st.position.z += this.stripes.length * STRIPE_SPACING;
      }
    }

    // camera chase
    const camTargetZ = this.playerZ - 10;
    this.cam.position.x = this.playerX * 0.4;
    this.cam.position.y = 6;
    this.cam.position.z += (camTargetZ - this.cam.position.z) * Math.min(1, dt * 6);
    this.cam.setTarget(new Vector3(this.playerX * 0.2, 1.5, this.playerZ + 12));

    // enemy spawning — keep roughly N enemies ahead at all times
    this.spawnTimer -= dt;
    const want = 6;
    if (this.spawnTimer <= 0 && this.enemies.length < want) {
      this.spawnEnemy(50 + Math.random() * 80);
      this.spawnTimer = 0.5;
    }
    // enemies drift forward slowly so player can catch up; cull behind
    for (const e of this.enemies) {
      e.mesh.position.z += e.speed * dt;
      // collision
      const dx = e.mesh.position.x - this.playerX;
      const dz = e.mesh.position.z - this.playerZ;
      if (Math.abs(dx) < 1.2 && Math.abs(dz) < 1.4) {
        e.mesh.position.z = this.playerZ - 1000; // mark for cull
        this.hp = Math.max(0, this.hp - 1);
        sfx.hit();
        updateStats({ HP: this.hp });
        if (this.hp <= 0) {
          this.hp = 3; this.distance = 0; this.playerSpeed = 0;
          updateStats({ HP: 3, Distance: 0, Speed: 0 });
        }
      }
    }
    this.enemies = this.enemies.filter((e) => {
      if (e.mesh.position.z < this.playerZ - 30) { e.mesh.dispose(); return false; }
      return true;
    });

    updateStats({
      Distance: Math.floor(this.distance),
      Speed: Math.floor(this.playerSpeed * 3.6),  // pseudo-km/h
    });
  }

  dispose() {
    detachBackground(this.bg); this.bg = null;
    hideHud();
    this.scene.dispose();
  }
}
