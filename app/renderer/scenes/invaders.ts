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

interface Bullet { mesh: Mesh; vz: number; life: number; from: "player" | "enemy"; }
interface Invader { mesh: Mesh; alive: boolean; }

const ARENA_X = 28;
const ARENA_Z = 18;
const PLAYER_Z = ARENA_Z - 2;
const ENEMY_TOP_Z = -ARENA_Z + 3;
const COLS = 9;
const ROWS = 4;
const COL_GAP = 3.0;
const ROW_GAP = 2.4;
const PLAYER_MAX_HP = 3;

export class InvadersScene implements IGameScene {
  scene: Scene;
  private cam: FreeCamera;
  private player!: Mesh;
  private bullets: Bullet[] = [];
  private invaders: Invader[] = [];
  private dir = 1;             // current march direction
  private marchTimer = 0;
  private marchInterval = 0.6;
  private enemyFireTimer = 1.5;
  private fireTimer = 0;
  private wave = 1;
  private score = 0;
  private hp = PLAYER_MAX_HP;
  private elapsed = 0;
  private bg: BackgroundHandle | null = null;

  constructor(engine: Engine, _canvas: HTMLCanvasElement) {
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.02, 0.03, 0.07, 1);
    this.scene = scene;
    attachBackground(scene).then((h) => (this.bg = h));
    this.cam = new FreeCamera("cam", new Vector3(0, 32, 0.01), scene);
    this.cam.setTarget(Vector3.Zero());
    new HemisphericLight("h", new Vector3(0, 1, 0), scene).intensity = 1.0;

    const post = new DefaultRenderingPipeline("post", true, scene, [this.cam]);
    post.bloomEnabled = true; post.bloomWeight = 0.5; post.fxaaEnabled = true;

    const ground = MeshBuilder.CreateGround("g", { width: ARENA_X * 2, height: ARENA_Z * 2 }, scene);
    const gm = new StandardMaterial("gm", scene);
    gm.diffuseColor = new Color3(0.06, 0.08, 0.14);
    gm.emissiveColor = new Color3(0.02, 0.02, 0.05);
    ground.material = gm;

    for (const [x, z, w, d] of [
      [-ARENA_X, 0, 0.4, ARENA_Z * 2],
      [ ARENA_X, 0, 0.4, ARENA_Z * 2],
      [0, -ARENA_Z, ARENA_X * 2, 0.4],
      [0,  ARENA_Z, ARENA_X * 2, 0.4],
    ]) {
      const m = MeshBuilder.CreateBox("b", { width: w, height: 0.4, depth: d }, scene);
      m.position.set(x as number, 0.2, z as number);
      const bm = new StandardMaterial("bm", scene);
      bm.emissiveColor = new Color3(0.3, 0.5, 1);
      m.material = bm;
    }

    this.spawnPlayer();
    this.spawnWave();

    setHud({
      title: "Space Invaders",
      lines: [
        "Move:   A/D · ←/→ · joystick",
        "Shoot:  Space / J / button A",
        "Stop the descending fleet!",
      ],
      stats: { Wave: 1, Score: 0, HP: this.hp },
    });
  }

  private texFor(d: { url?: string } | null) {
    if (!d?.url) return null;
    const tex = new Texture(d.url, this.scene, true, true);
    tex.hasAlpha = true;
    return tex;
  }

  private spawnPlayer() {
    const m = MeshBuilder.CreatePlane("p", { size: 2.5, sideOrientation: Mesh.DOUBLESIDE }, this.scene);
    m.rotation.x = Math.PI / 2;
    m.position.set(0, 0.1, PLAYER_Z);
    const mat = new StandardMaterial("pm", this.scene);
    const tex = this.texFor(library.latest());
    if (tex) { mat.diffuseTexture = tex; mat.useAlphaFromDiffuseTexture = true; }
    else mat.diffuseColor = new Color3(0.4, 0.9, 0.5);
    mat.emissiveColor = new Color3(0.3, 0.4, 0.3);
    mat.backFaceCulling = false;
    m.material = mat;
    this.player = m;
  }

  private spawnWave() {
    const pool = library.list;
    const totalW = (COLS - 1) * COL_GAP;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const m = MeshBuilder.CreatePlane("inv", { size: 1.8, sideOrientation: Mesh.DOUBLESIDE }, this.scene);
        m.rotation.x = Math.PI / 2;
        m.position.set(-totalW / 2 + c * COL_GAP, 0.1, ENEMY_TOP_Z + r * ROW_GAP);
        const mat = new StandardMaterial("im", this.scene);
        if (pool.length) {
          const tex = this.texFor(pool[(r * COLS + c) % pool.length]);
          if (tex) { mat.diffuseTexture = tex; mat.useAlphaFromDiffuseTexture = true; }
          else mat.diffuseColor = new Color3(0.9, 0.3, 0.3);
        } else {
          mat.diffuseColor = new Color3(0.9, 0.3, 0.3);
        }
        mat.emissiveColor = new Color3(0.4, 0.1, 0.1);
        mat.backFaceCulling = false;
        m.material = mat;
        this.invaders.push({ mesh: m, alive: true });
      }
    }
  }

  private fire(from: "player" | "enemy", x: number, z: number) {
    const m = MeshBuilder.CreateSphere("b", { diameter: 0.4 }, this.scene);
    m.position.set(x, 0.5, z);
    const mat = new StandardMaterial("bm", this.scene);
    mat.emissiveColor = from === "player"
      ? new Color3(1, 0.95, 0.4)
      : new Color3(1, 0.3, 0.3);
    mat.disableLighting = true;
    m.material = mat;
    this.bullets.push({ mesh: m, vz: from === "player" ? -28 : 18, life: 2.0, from });
    sfx.shoot();
  }

  private resetRun() {
    this.hp = PLAYER_MAX_HP; this.wave = 1; this.score = 0; this.elapsed = 0;
    this.marchInterval = 0.6;
    for (const b of this.bullets) b.mesh.dispose();
    this.bullets = [];
    for (const e of this.invaders) e.mesh.dispose();
    this.invaders = [];
    this.player.position.set(0, 0.1, PLAYER_Z);
    this.spawnWave();
    updateStats({ HP: this.hp, Wave: this.wave, Score: this.score });
  }

  private nextWave() {
    this.wave += 1;
    this.marchInterval = Math.max(0.12, 0.6 - this.wave * 0.06);
    for (const e of this.invaders) e.mesh.dispose();
    this.invaders = [];
    this.spawnWave();
    updateStats({ Wave: this.wave });
  }

  update(dt: number) {
    this.elapsed += dt;
    const s = input.poll();
    // Top-down camera at +Y looking down: world +X reads as visual LEFT, invert.
    const ax = -s.axes.x;
    const speed = 14;
    this.player.position.x = Math.max(-ARENA_X + 1.2, Math.min(ARENA_X - 1.2, this.player.position.x + ax * speed * dt));

    this.fireTimer -= dt;
    if (s.buttons.shoot && this.fireTimer <= 0) {
      this.fire("player", this.player.position.x, this.player.position.z - 1.2);
      this.fireTimer = 0.32;
    }

    // March: tick on interval, step horizontally; on wall hit, drop one row + flip.
    this.marchTimer -= dt;
    if (this.marchTimer <= 0) {
      this.marchTimer = this.marchInterval;
      const alive = this.invaders.filter((e) => e.alive);
      if (alive.length) {
        let minX = Infinity, maxX = -Infinity, maxZ = -Infinity;
        for (const e of alive) {
          if (e.mesh.position.x < minX) minX = e.mesh.position.x;
          if (e.mesh.position.x > maxX) maxX = e.mesh.position.x;
          if (e.mesh.position.z > maxZ) maxZ = e.mesh.position.z;
        }
        const step = 0.6;
        const wallHit =
          (this.dir > 0 && maxX + step > ARENA_X - 1.2) ||
          (this.dir < 0 && minX - step < -ARENA_X + 1.2);
        if (wallHit) {
          this.dir *= -1;
          for (const e of alive) e.mesh.position.z += 0.9;
        } else {
          for (const e of alive) e.mesh.position.x += this.dir * step;
        }
        // Touch the player line → instant death.
        if (maxZ + 0.9 >= PLAYER_Z - 1) {
          this.resetRun();
          return;
        }
      } else {
        this.nextWave();
      }
    }

    // Enemy fire — random alive in front column shoots downward.
    this.enemyFireTimer -= dt;
    if (this.enemyFireTimer <= 0) {
      const alive = this.invaders.filter((e) => e.alive);
      if (alive.length) {
        const shooter = alive[Math.floor(Math.random() * alive.length)];
        this.fire("enemy", shooter.mesh.position.x, shooter.mesh.position.z + 1);
      }
      this.enemyFireTimer = Math.max(0.35, 1.6 - this.wave * 0.15);
    }

    // Bullets
    for (const b of this.bullets) {
      b.mesh.position.z += b.vz * dt;
      b.life -= dt;
      if (b.from === "player") {
        for (const e of this.invaders) {
          if (!e.alive) continue;
          if (Math.abs(b.mesh.position.x - e.mesh.position.x) < 1.0 &&
              Math.abs(b.mesh.position.z - e.mesh.position.z) < 1.0) {
            e.alive = false;
            b.life = 0;
            this.score += 10;
            sfx.hit();
            updateStats({ Score: this.score });
          }
        }
      } else {
        if (Math.abs(b.mesh.position.x - this.player.position.x) < 1.1 &&
            Math.abs(b.mesh.position.z - this.player.position.z) < 1.1) {
          b.life = 0;
          this.hp = Math.max(0, this.hp - 1);
          sfx.hit();
          updateStats({ HP: this.hp });
          if (this.hp <= 0) { this.resetRun(); return; }
        }
      }
      if (b.mesh.position.z < -ARENA_Z || b.mesh.position.z > ARENA_Z) b.life = 0;
    }
    this.bullets = this.bullets.filter((b) => { if (b.life <= 0) { b.mesh.dispose(); return false; } return true; });
    this.invaders = this.invaders.filter((e) => {
      if (!e.alive) { e.mesh.dispose(); return false; }
      return true;
    });

    if (this.invaders.length === 0) this.nextWave();
  }

  dispose() {
    detachBackground(this.bg); this.bg = null;
    hideHud();
    this.scene.dispose();
  }
}
