import { Scene } from "@babylonjs/core/scene";
import { Vector3, Color3, Color4 } from "@babylonjs/core/Maths/math";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { Mesh } from "@babylonjs/core/Meshes/mesh";

function hexToColor3(h: string): Color3 {
  const c = h.replace("#", "");
  return new Color3(
    parseInt(c.slice(0, 2), 16) / 255,
    parseInt(c.slice(2, 4), 16) / 255,
    parseInt(c.slice(4, 6), 16) / 255
  );
}

export interface PortalHandle {
  position: Vector3;
  done: Promise<void>;
}

export function spawnPortal(scene: Scene, position: Vector3, palette: string[], duration = 3.0): PortalHandle {
  const ring = MeshBuilder.CreateTorus("portal", { diameter: 3, thickness: 0.18, tessellation: 64 }, scene);
  ring.position = position.clone();
  ring.rotation.x = Math.PI / 2;
  const ringMat = new StandardMaterial("pmat", scene);
  const c1 = hexToColor3(palette[0] ?? "#88aaff");
  const c2 = hexToColor3(palette[1] ?? palette[0] ?? "#ff88cc");
  ringMat.emissiveColor = c1;
  ringMat.disableLighting = true;
  ring.material = ringMat;

  const ps = new ParticleSystem("ppart", 800, scene);
  ps.emitter = ring;
  ps.minEmitBox = new Vector3(-0.1, -0.1, -0.1);
  ps.maxEmitBox = new Vector3(0.1, 0.1, 0.1);
  ps.color1 = new Color4(c1.r, c1.g, c1.b, 1);
  ps.color2 = new Color4(c2.r, c2.g, c2.b, 0.7);
  ps.colorDead = new Color4(0, 0, 0, 0);
  ps.minSize = 0.06; ps.maxSize = 0.22;
  ps.minLifeTime = 0.6; ps.maxLifeTime = 1.2;
  ps.emitRate = 600;
  ps.gravity = Vector3.Zero();
  ps.direction1 = new Vector3(-1, -1, -1);
  ps.direction2 = new Vector3(1, 1, 1);
  ps.minEmitPower = 1.5; ps.maxEmitPower = 4;
  ps.start();

  const start = performance.now();
  let resolveDone: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  const obs = scene.onBeforeRenderObservable.add(() => {
    const t = (performance.now() - start) / 1000 / duration;
    if (t >= 1) {
      ps.stop();
      setTimeout(() => { ring.dispose(); ps.dispose(); }, 1000);
      scene.onBeforeRenderObservable.remove(obs);
      resolveDone();
      return;
    }
    const pulse = 1 + Math.sin(t * Math.PI * 6) * 0.15;
    ring.scaling.setAll(pulse);
    ringMat.emissiveColor = Color3.Lerp(c1, c2, (Math.sin(t * Math.PI * 4) + 1) / 2);
    ring.rotation.z += 0.08;
  });

  return { position: ring.position, done };
}
