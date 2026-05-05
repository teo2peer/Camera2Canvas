import type { Engine } from "@babylonjs/core/Engines/engine";

export interface IGameScene {
  scene: import("@babylonjs/core/scene").Scene;
  dispose(): void;
  update?(dt: number): void;
}

export class SceneManager {
  private current: IGameScene | null = null;
  constructor(private engine: Engine, private canvas: HTMLCanvasElement) {}
  set(s: IGameScene) {
    this.current?.dispose();
    this.current = s;
  }
  render() {
    if (!this.current) return;
    const dt = this.engine.getDeltaTime() / 1000;
    this.current.update?.(dt);
    this.current.scene.render();
  }
}
