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

interface Bullet { mesh: Mesh; vx: number; vz: number; life: number; }
interface Enemy  {
  mesh: Mesh;
  hp: number;
  maxHp: number;
  speed: number;
  hpBg: Mesh;
  hpFg: Mesh;        // green fill, shrinks from the right edge
}
const PLAYER_MAX_HP = 5;
const HP_BAR_W = 2.0;
const HP_BAR_H = 0.28;

const ARENA_X = 28;
const ARENA_Z = 18;

export class TankScene implements IGameScene {
  scene: Scene;
  private cam: FreeCamera;
  private player!: Mesh;
  private cannon!: Mesh;     // green cylinder pointing at the heading
  private aim!: Mesh;        // small disc that shows where we will fire
  private hearts: Mesh[] = []; // 3D hearts above the tank, visible = HP units
  private heading = 0;
  private bullets: Bullet[] = [];
  private enemies: Enemy[] = [];
  private spawnTimer = 0;
  private fireTimer = 0;
  private wave = 1;
  private score = 0;
  private hp = 5;
  private elapsed = 0;       // seconds since this run started — drives enemy HP scaling
  private bg: BackgroundHandle | null = null;

  constructor(engine: Engine, _canvas: HTMLCanvasElement) {
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.02, 0.04, 0.08, 1);
    this.scene = scene;
    attachBackground(scene).then((h) => (this.bg = h));
    this.cam = new FreeCamera("cam", new Vector3(0, 32, 0.01), scene);
    this.cam.setTarget(Vector3.Zero());
    new HemisphericLight("h", new Vector3(0, 1, 0), scene).intensity = 1.0;

    const post = new DefaultRenderingPipeline("post", true, scene, [this.cam]);
    post.bloomEnabled = true; post.bloomWeight = 0.45; post.fxaaEnabled = true;

    const ground = MeshBuilder.CreateGround("g", { width: ARENA_X * 2, height: ARENA_Z * 2 }, scene);
    const gm = new StandardMaterial("gm", scene);
    gm.diffuseColor = new Color3(0.10, 0.13, 0.20);
    gm.emissiveColor = new Color3(0.02, 0.03, 0.06);
    ground.material = gm;

    // arena border (visual only)
    for (const [x, z, w, d] of [
      [-ARENA_X, 0, 0.4, ARENA_Z * 2],
      [ ARENA_X, 0, 0.4, ARENA_Z * 2],
      [0, -ARENA_Z, ARENA_X * 2, 0.4],
      [0,  ARENA_Z, ARENA_X * 2, 0.4],
    ]) {
      const m = MeshBuilder.CreateBox("b", { width: w, height: 0.4, depth: d }, scene);
      m.position.set(x as number, 0.2, z as number);
      const bm = new StandardMaterial("bm", scene);
      bm.emissiveColor = new Color3(0.4, 0.6, 1);
      m.material = bm;
    }

    this.spawnPlayer();
    this.spawnAim();
    this.spawnCannon();
    this.spawnHearts();
    this.updateHearts();

    setHud({
      title: "Tank War",
      lines: [
        "Move:   WASD / joystick",
        "Aim:    same direction you move",
        "Shoot:  Space / J / button A",
        "Survive waves of enemies!",
      ],
      stats: { Wave: 1, Score: 0, HP: this.hp, Time: "0:00" },
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
    m.position.y = 0.1;
    const mat = new StandardMaterial("pm", this.scene);
    const tex = this.texFor(library.latest());
    if (tex) { mat.diffuseTexture = tex; mat.useAlphaFromDiffuseTexture = true; }
    else mat.diffuseColor = new Color3(0.95, 0.7, 0.3);
    mat.emissiveColor = new Color3(0.35, 0.35, 0.35);
    mat.backFaceCulling = false;
    m.material = mat;
    this.player = m;
  }

  private spawnCannon() {
    // Green barrel lying flat on the ground plane. We do NOT parent it to the
    // player (which is a flat plane rotated 90° for the top-down camera) —
    // instead we reposition + rotate the cannon manually each frame.
    // Cylinder default axis = Y; rotate around Z so the long axis sits in the
    // XZ plane (i.e. parallel to the ground).
    const c = MeshBuilder.CreateCylinder("cannon", { diameter: 0.45, height: 1.8, tessellation: 24 }, this.scene);
    c.rotation.z = Math.PI / 2;     // long axis → world +X by default
    c.position.y = 0.25;
    const mat = new StandardMaterial("cm", this.scene);
    mat.diffuseColor = new Color3(0.15, 0.55, 0.25);
    mat.emissiveColor = new Color3(0.05, 0.35, 0.12);
    mat.specularColor = new Color3(0.4, 0.9, 0.5);
    c.material = mat;
    this.cannon = c;
  }

  private spawnHearts() {
    const tex = this.heartTexture();
    for (let i = 0; i < PLAYER_MAX_HP; i++) {
      const h = MeshBuilder.CreatePlane("heart", { size: 0.7, sideOrientation: Mesh.DOUBLESIDE }, this.scene);
      h.rotation.x = Math.PI / 2; // lie flat (top-down camera sees them face-up)
      const mat = new StandardMaterial("hm", this.scene);
      mat.diffuseTexture = tex;
      mat.useAlphaFromDiffuseTexture = true;
      mat.emissiveColor = new Color3(0.6, 0.1, 0.15);
      mat.disableLighting = true;
      mat.backFaceCulling = false;
      h.material = mat;
      this.hearts.push(h);
    }
  }

  private heartTexture(): Texture {
    // Build a tiny SVG-like heart on a canvas → Texture; reused across hearts.
    const c = document.createElement("canvas");
    c.width = 64; c.height = 64;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#ff4a63";
    ctx.beginPath();
    const x = 32, y = 50, sz = 22;
    // simple two-arc heart
    ctx.moveTo(x, y);
    ctx.bezierCurveTo(x + sz, y - sz * 0.6, x + sz, y - sz * 1.4, x, y - sz * 0.4);
    ctx.bezierCurveTo(x - sz, y - sz * 1.4, x - sz, y - sz * 0.6, x, y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#ffd0d8"; ctx.lineWidth = 3; ctx.stroke();
    const t = new Texture("data:image/png;base64," + c.toDataURL("image/png").split(",")[1], this.scene, true, true);
    t.hasAlpha = true;
    return t;
  }

  private updateHearts() {
    for (let i = 0; i < this.hearts.length; i++) {
      this.hearts[i].setEnabled(i < this.hp);
    }
  }

  private makeHpBar(): { bg: Mesh; fg: Mesh } {
    // Dark background plate (always full width).
    const bg = MeshBuilder.CreatePlane("hpb", { width: HP_BAR_W, height: HP_BAR_H, sideOrientation: Mesh.DOUBLESIDE }, this.scene);
    bg.rotation.x = Math.PI / 2;
    const bgMat = new StandardMaterial("hpbm", this.scene);
    bgMat.emissiveColor = new Color3(0.02, 0.02, 0.02);
    bgMat.disableLighting = true;
    bg.material = bgMat;
    bg.renderingGroupId = 1;  // draw on top of the ground

    // Green fill — independent mesh so we can pivot its left edge against the
    // bg's left edge: each frame we set fg.scaling.x = ratio AND
    // fg.position.x = bg.position.x - (HP_BAR_W * (1 - ratio)) / 2 so it
    // visually shrinks from the right-hand side instead of from the centre.
    const fg = MeshBuilder.CreatePlane("hpf", { width: HP_BAR_W, height: HP_BAR_H * 0.75, sideOrientation: Mesh.DOUBLESIDE }, this.scene);
    fg.rotation.x = Math.PI / 2;
    const fgMat = new StandardMaterial("hpfm", this.scene);
    fgMat.emissiveColor = new Color3(0.15, 1.0, 0.25);   // strong green
    fgMat.disableLighting = true;
    fg.material = fgMat;
    fg.renderingGroupId = 1;
    return { bg, fg };
  }

  private spawnAim() {
    const m = MeshBuilder.CreateDisc("aim", { radius: 0.35, tessellation: 24 }, this.scene);
    m.rotation.x = Math.PI / 2;
    m.position.y = 0.05;
    const mat = new StandardMaterial("am", this.scene);
    mat.emissiveColor = new Color3(1, 0.85, 0.4);
    mat.disableLighting = true;
    m.material = mat;
    this.aim = m;
  }

  private spawnEnemy() {
    const m = MeshBuilder.CreatePlane("e", { size: 2, sideOrientation: Mesh.DOUBLESIDE }, this.scene);
    m.rotation.x = Math.PI / 2;
    // spawn from a random side, just inside the arena
    const side = Math.floor(Math.random() * 4);
    const ex = side < 2 ? (side === 0 ? -ARENA_X + 1 : ARENA_X - 1) : (Math.random() - 0.5) * (ARENA_X * 1.6);
    const ez = side < 2 ? (Math.random() - 0.5) * (ARENA_Z * 1.6) : (side === 2 ? -ARENA_Z + 1 : ARENA_Z - 1);
    m.position.set(ex, 0.1, ez);
    const mat = new StandardMaterial("em", this.scene);
    const pool = library.list;
    if (pool.length) {
      const tex = this.texFor(pool[Math.floor(Math.random() * pool.length)]);
      if (tex) { mat.diffuseTexture = tex; mat.useAlphaFromDiffuseTexture = true; }
      else mat.diffuseColor = new Color3(0.8, 0.2, 0.2);
    } else {
      mat.diffuseColor = new Color3(0.8, 0.2, 0.2);
    }
    mat.emissiveColor = new Color3(0.5, 0.1, 0.1);
    mat.backFaceCulling = false;
    m.material = mat;
    // Enemy HP scales with wallclock time AND wave: starts at 2, gains +1 every
    // 12 s, plus +1 every 3 waves. Caps at 14 so they're always killable.
    const timeBonus = Math.floor(this.elapsed / 12);
    const waveBonus = Math.floor(this.wave / 3);
    const maxHp = Math.min(14, 2 + timeBonus + waveBonus);
    const { bg, fg } = this.makeHpBar();
    this.enemies.push({
      mesh: m, hp: maxHp, maxHp,
      speed: 1.6 + this.wave * 0.25,
      hpBg: bg, hpFg: fg,
    });
  }

  private fire() {
    const m = MeshBuilder.CreateSphere("b", { diameter: 0.45 }, this.scene);
    m.position = this.player.position.clone(); m.position.y = 0.5;
    const mat = new StandardMaterial("bm", this.scene);
    mat.emissiveColor = new Color3(1, 0.95, 0.4);
    mat.disableLighting = true;
    m.material = mat;
    const sp = 26;
    this.bullets.push({ mesh: m, vx: Math.cos(this.heading) * sp, vz: Math.sin(this.heading) * sp, life: 1.4 });
    sfx.shoot();
  }

  update(dt: number) {
    this.elapsed += dt;
    const s = input.poll();
    // Top-down camera at +Y looking down: world +X reads as visual LEFT for the
    // player, so invert the X axis here.
    const ax = -s.axes.x;
    const az = s.axes.y;
    const speed = 9;
    this.player.position.x = Math.max(-ARENA_X + 1, Math.min(ARENA_X - 1, this.player.position.x + ax * speed * dt));
    this.player.position.z = Math.max(-ARENA_Z + 1, Math.min(ARENA_Z - 1, this.player.position.z + az * speed * dt));
    if (Math.abs(ax) + Math.abs(az) > 0.15) {
      this.heading = Math.atan2(az, ax);
      this.player.rotation.y = -this.heading;
    }

    // aim reticle 4 m ahead of the tank
    this.aim.position.x = this.player.position.x + Math.cos(this.heading) * 4;
    this.aim.position.z = this.player.position.z + Math.sin(this.heading) * 4;

    // cannon: sit at tank, point along heading. Cylinder lies along world +X
    // by construction — rotate it around world +Y so its tip points the right
    // way; offset its centre half a barrel-length in the heading direction so
    // the back of the barrel sits at the tank.
    const half = 0.9;
    this.cannon.position.x = this.player.position.x + Math.cos(this.heading) * half;
    this.cannon.position.z = this.player.position.z + Math.sin(this.heading) * half;
    this.cannon.position.y = 0.3;
    this.cannon.rotation.y = -this.heading;

    // hearts: float above the tank in a small row, north of the mesh.
    for (let i = 0; i < this.hearts.length; i++) {
      const h = this.hearts[i];
      h.position.x = this.player.position.x + (i - (PLAYER_MAX_HP - 1) / 2) * 0.85;
      h.position.y = 0.3;
      h.position.z = this.player.position.z - 1.8;
    }

    this.fireTimer -= dt;
    if (s.buttons.shoot && this.fireTimer <= 0) { this.fire(); this.fireTimer = 0.22; }

    // enemy spawning — guarantee a steady supply, scale with wave
    this.spawnTimer -= dt;
    const target = Math.min(20, 4 + this.wave * 2);
    if (this.spawnTimer <= 0 && this.enemies.length < target) {
      this.spawnEnemy();
      this.spawnTimer = Math.max(0.4, 1.2 - this.wave * 0.08);
    }

    // enemies seek the player; on contact they damage HP
    for (const e of this.enemies) {
      const dx = this.player.position.x - e.mesh.position.x;
      const dz = this.player.position.z - e.mesh.position.z;
      const d = Math.hypot(dx, dz) || 1;
      e.mesh.position.x += (dx / d) * e.speed * dt;
      e.mesh.position.z += (dz / d) * e.speed * dt;

      // HP bar — bg always full, green fill shrinks from the RIGHT edge.
      const ratio = Math.max(0, Math.min(1, e.hp / e.maxHp));
      const barX = e.mesh.position.x;
      const barZ = e.mesh.position.z - 1.5;
      const barY = 0.4;
      e.hpBg.position.set(barX, barY, barZ);
      e.hpFg.scaling.x = ratio;
      // anchor left edge to bg's left edge by sliding centre as we shrink
      e.hpFg.position.set(barX - (HP_BAR_W * (1 - ratio)) / 2, barY + 0.01, barZ);

      if (d < 1.2) {
        e.hp = 0;
        this.hp = Math.max(0, this.hp - 1);
        sfx.hit();
        this.updateHearts();
        updateStats({ HP: this.hp });
        if (this.hp <= 0) {
          this.hp = PLAYER_MAX_HP; this.wave = 1; this.score = 0; this.elapsed = 0;
          this.updateHearts();
          updateStats({ HP: PLAYER_MAX_HP, Wave: 1, Score: 0 });
          for (const ee of this.enemies) { ee.mesh.dispose(); ee.hpBg.dispose(); ee.hpFg.dispose(); }
          this.enemies = [];
          this.player.position.set(0, 0.1, 0);
          return;
        }
      }
    }

    // bullets
    for (const b of this.bullets) {
      b.mesh.position.x += b.vx * dt;
      b.mesh.position.z += b.vz * dt;
      b.life -= dt;
      for (const e of this.enemies) {
        if (Vector3.Distance(b.mesh.position, e.mesh.position) < 1.2) {
          e.hp -= 1;
          b.life = 0;
          if (e.hp <= 0) {
            this.score += 10;
            updateStats({ Score: this.score });
          }
          sfx.hit();
        }
      }
    }
    this.bullets = this.bullets.filter((b) => { if (b.life <= 0) { b.mesh.dispose(); return false; } return true; });
    this.enemies = this.enemies.filter((e) => {
      if (e.hp <= 0) { e.mesh.dispose(); e.hpBg.dispose(); e.hpFg.dispose(); return false; }
      return true;
    });

    // wave progression every 100 score
    const newWave = Math.floor(this.score / 100) + 1;
    if (newWave !== this.wave) {
      this.wave = newWave;
      updateStats({ Wave: this.wave });
    }
    // tick HUD time once per second to avoid noisy re-renders
    const tInt = Math.floor(this.elapsed);
    if (tInt !== this._lastTimeShown) {
      this._lastTimeShown = tInt;
      const mm = Math.floor(tInt / 60); const ss = tInt % 60;
      updateStats({ Time: `${mm}:${ss.toString().padStart(2, "0")}` });
    }
  }
  private _lastTimeShown = -1;

  dispose() {
    detachBackground(this.bg); this.bg = null;
    hideHud();
    this.scene.dispose();
  }
}
