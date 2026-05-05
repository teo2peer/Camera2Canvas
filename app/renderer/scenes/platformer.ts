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
import { library, DrawingRecord } from "../core/drawings";
import { sfx } from "../core/sfx";
import { setHud, updateStats, hideHud } from "../core/hud";
import { attachBackground, detachBackground, BackgroundHandle } from "../core/background";

interface Platform {
  mesh: Mesh;
  x: number;          // world centre x
  y: number;          // world centre y
  w: number;          // width
  vx?: number;        // horizontal velocity for moving platforms (>= 60 score)
}

interface Monster {
  mesh: Mesh;
  x: number;
  y: number;
  vx: number;         // slow horizontal speed, bounces off world edges
  r: number;          // collision radius
}

const WORLD_W = 14;        // playfield width (-7 to +7)
const PLAYER_R = 0.7;
const GRAVITY = -36;
const JUMP_V  = 18;        // auto-jump impulse on platform contact

export class PlatformerScene implements IGameScene {
  scene: Scene;
  private cam: FreeCamera;
  private player: Mesh;
  private vx = 0;
  private vy = 0;
  private platforms: Platform[] = [];
  private monsters: Monster[] = [];
  private nextMonsterY = 150;     // spawn the next monster above this y
  private highest = 0;        // highest y so far (camera target)
  private spawnedY = 0;       // last y we spawned a platform at
  private score = 0;
  private best = parseInt(localStorage.getItem("skyjump.best") ?? "0", 10) || 0;
  private dead = false;
  private spawnGuardUntil = 0;     // perf.now() until which death checks are skipped after a respawn
  private bg: BackgroundHandle | null = null;

  constructor(engine: Engine, _canvas: HTMLCanvasElement, drawing: DrawingRecord | null) {
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.04, 0.06, 0.16, 1);
    this.scene = scene;
    attachBackground(scene).then((h) => (this.bg = h));
    this.cam = new FreeCamera("cam", new Vector3(0, 6, -16), scene);
    this.cam.setTarget(new Vector3(0, 6, 0));
    new HemisphericLight("h", new Vector3(0, 1, 0), scene).intensity = 0.95;

    const post = new DefaultRenderingPipeline("post", true, scene, [this.cam]);
    post.bloomEnabled = true; post.bloomWeight = 0.4; post.fxaaEnabled = true;

    // ground / starter platform
    this.addPlatform(0, 0, WORLD_W);
    for (let i = 1; i < 8; i++) {
      const y = i * 2.4;
      const x = (Math.random() - 0.5) * (WORLD_W - 4);
      this.addPlatform(x, y, 3);
      this.spawnedY = y;
    }

    const player = MeshBuilder.CreatePlane("p", { size: 1.4, sideOrientation: Mesh.DOUBLESIDE }, scene);
    player.position.set(0, 3, 0);
    const mat = new StandardMaterial("pm", scene);
    const d = drawing ?? library.latest();
    if (d) {
      const tex = new Texture(d.url, scene, true, true);
      tex.hasAlpha = true;
      mat.diffuseTexture = tex;
      mat.useAlphaFromDiffuseTexture = true;
    } else {
      mat.diffuseColor = new Color3(1, 0.6, 0.2);
    }
    mat.emissiveColor = new Color3(0.4, 0.4, 0.4);
    mat.backFaceCulling = false;
    player.material = mat;
    this.player = player;

    setHud({
      title: "Sky Jump",
      lines: [
        "Auto-jumps on every platform",
        "Move:  ←/→ or A/D or joystick",
        "Wrap:  off the side = appear other side",
        "Don't fall past the bottom!",
      ],
      stats: { Score: 0, Best: this.best },
    });
  }

  private addPlatform(x: number, y: number, w: number, moving = false) {
    const m = MeshBuilder.CreateBox("pl", { width: w, height: 0.4, depth: 1.4 }, this.scene);
    m.position.set(x, y, 0);
    const mat = new StandardMaterial("plm", this.scene);
    if (moving) {
      // slightly warmer/orange tint so the player notices these
      mat.diffuseColor   = new Color3(0.95, 0.55, 0.30);
      mat.emissiveColor  = new Color3(0.40, 0.18, 0.05);
    } else {
      mat.diffuseColor   = new Color3(0.4, 0.6, 0.95);
      mat.emissiveColor  = new Color3(0.05, 0.18, 0.4);
    }
    m.material = mat;
    const vx = moving ? (Math.random() < 0.5 ? -1 : 1) * (1.6 + Math.random() * 1.4) : undefined;
    this.platforms.push({ mesh: m, x, y, w, vx });
  }

  private spawnMonster(y: number) {
    const r = 0.8;
    const m = MeshBuilder.CreateSphere("mn", { diameter: r * 2, segments: 12 }, this.scene);
    const x = (Math.random() - 0.5) * (WORLD_W - 4);
    m.position.set(x, y, 0);
    const mat = new StandardMaterial("mnm", this.scene);
    mat.diffuseColor  = new Color3(0.85, 0.20, 0.30);
    mat.emissiveColor = new Color3(0.55, 0.05, 0.10);
    m.material = mat;
    const vx = (Math.random() < 0.5 ? -1 : 1) * (1.0 + Math.random() * 0.8);
    this.monsters.push({ mesh: m, x, y, vx, r });
  }

  private maybeSpawnPlatforms() {
    while (this.spawnedY < this.highest + 30) {
      this.spawnedY += 1.6 + Math.random() * 1.4;
      const w = 2.2 + Math.random() * 1.8;
      const x = (Math.random() - 0.5) * (WORLD_W - w);
      // Above 60 score, ~30% of platforms slide horizontally; chance grows
      // with height up to ~55%.
      const movingChance = this.highest >= 60
        ? Math.min(0.55, 0.30 + (this.highest - 60) / 400)
        : 0;
      const moving = Math.random() < movingChance;
      this.addPlatform(x, this.spawnedY, w, moving);

      // Spawn monsters at increasing density once we pass 150.
      if (this.spawnedY > this.nextMonsterY && this.highest >= 150) {
        this.spawnMonster(this.spawnedY + 1.2);
        // Distance to next monster shrinks as score grows, but never closer
        // than every 14 vertical units so it stays survivable.
        const gap = Math.max(14, 40 - (this.highest - 150) / 8);
        this.nextMonsterY = this.spawnedY + gap;
      }
    }
  }

  private cullPlatforms() {
    const cutoff = this.highest - 14;
    this.platforms = this.platforms.filter((p) => {
      if (p.y < cutoff) { p.mesh.dispose(); return false; }
      return true;
    });
    this.monsters = this.monsters.filter((m) => {
      if (m.y < cutoff) { m.mesh.dispose(); return false; }
      return true;
    });
  }

  private respawn() {
    if (this.scene.isDisposed) return;   // user switched scenes mid-pause
    this.dead = false;
    this.score = 0;
    this.vx = 0; this.vy = 0;
    this.highest = 0; this.spawnedY = 0;
    for (const p of this.platforms) p.mesh.dispose();
    this.platforms = [];
    for (const m of this.monsters) m.mesh.dispose();
    this.monsters = [];
    this.nextMonsterY = 150;
    this.addPlatform(0, 0, WORLD_W);
    for (let i = 1; i < 8; i++) {
      const y = i * 2.4;
      const x = (Math.random() - 0.5) * (WORLD_W - 4);
      this.addPlatform(x, y, 3);
      this.spawnedY = y;
    }
    this.player.position.set(0, 3, 0);
    // Snap the camera back to the start otherwise the death check
    // (ny < cam.y - 10) immediately fires again the next frame.
    this.cam.position.set(0, 6, -16);
    this.cam.setTarget(new Vector3(0, 6, 0));
    // Brief grace window so even a stray frame of camera lerp can't re-trigger death.
    this.spawnGuardUntil = performance.now() + 500;
    updateStats({ Score: 0, Best: this.best });
  }

  update(dt: number) {
    if (this.dead) return;
    const s = input.poll();

    // horizontal
    const targetVx = s.axes.x * 9;
    this.vx += (targetVx - this.vx) * Math.min(1, dt * 14);

    // gravity
    this.vy += GRAVITY * dt;

    // Move horizontal platforms first so collision uses their current x.
    for (const p of this.platforms) {
      if (!p.vx) continue;
      p.x += p.vx * dt;
      const halfW = p.w / 2;
      if (p.x - halfW < -WORLD_W / 2) { p.x = -WORLD_W / 2 + halfW; p.vx = -p.vx; }
      if (p.x + halfW >  WORLD_W / 2) { p.x =  WORLD_W / 2 - halfW; p.vx = -p.vx; }
      p.mesh.position.x = p.x;
    }

    // Move monsters horizontally — slow, bounce off the world edges.
    for (const m of this.monsters) {
      m.x += m.vx * dt;
      const half = WORLD_W / 2 - m.r;
      if (m.x >  half) { m.x =  half; m.vx = -m.vx; }
      if (m.x < -half) { m.x = -half; m.vx = -m.vx; }
      m.mesh.position.x = m.x;
    }

    let nx = this.player.position.x + this.vx * dt;
    let ny = this.player.position.y + this.vy * dt;

    // wrap horizontally (Doodle Jump style)
    if (nx > WORLD_W / 2 + 0.4) nx = -WORLD_W / 2 - 0.4;
    if (nx < -WORLD_W / 2 - 0.4) nx =  WORLD_W / 2 + 0.4;

    // landing detection (only when falling)
    if (this.vy <= 0) {
      for (const p of this.platforms) {
        const top = p.y + 0.2;
        const overlapsX = nx + PLAYER_R > p.x - p.w / 2 && nx - PLAYER_R < p.x + p.w / 2;
        const wasAbove = this.player.position.y - PLAYER_R >= top - 0.05;
        if (overlapsX && wasAbove && ny - PLAYER_R <= top) {
          ny = top + PLAYER_R;
          this.vy = JUMP_V;
          sfx.jump();
          break;
        }
      }
    }

    this.player.position.x = nx;
    this.player.position.y = ny;
    this.player.scaling.x = this.vx > 0.2 ? 1 : this.vx < -0.2 ? -1 : this.player.scaling.x;

    if (ny > this.highest) {
      this.highest = ny;
      const newScore = Math.floor(this.highest);
      if (newScore !== this.score) {
        this.score = newScore;
        updateStats({ Score: this.score });
      }
      this.maybeSpawnPlatforms();
      this.cullPlatforms();
    }

    // camera trails the player vertically; only goes up
    const camTargetY = Math.max(6, this.highest - 1);
    this.cam.position.y += (camTargetY - this.cam.position.y) * Math.min(1, dt * 4);
    this.cam.setTarget(new Vector3(0, this.cam.position.y, 0));

    // monster collision — circular hitbox, kills regardless of velocity
    if (performance.now() > this.spawnGuardUntil) {
      for (const m of this.monsters) {
        const dx = nx - m.x;
        const dy = ny - m.y;
        if (dx * dx + dy * dy < (m.r + PLAYER_R) * (m.r + PLAYER_R)) {
          this.die();
          return;
        }
      }
    }

    // fall death: below current camera bottom (skip during grace window after a respawn)
    if (performance.now() > this.spawnGuardUntil && ny < this.cam.position.y - 10) {
      this.die();
    }
  }

  private die() {
    if (this.dead) return;
    sfx.hit();
    if (this.score > this.best) {
      this.best = this.score;
      localStorage.setItem("skyjump.best", String(this.best));
    }
    this.dead = true;
    updateStats({ Score: this.score, Best: this.best });
    // Auto-restart after a short pause so the kiosk never stalls.
    setTimeout(() => this.respawn(), 1200);
  }

  dispose() {
    detachBackground(this.bg); this.bg = null;
    hideHud();
    this.scene.dispose();
  }
}
