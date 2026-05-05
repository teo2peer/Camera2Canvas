export interface InputState {
  axes: { x: number; y: number };
  buttons: Record<string, boolean>;
}

export class InputManager {
  state: InputState = { axes: { x: 0, y: 0 }, buttons: {} };
  private keys = new Set<string>();
  private gestureAxis = { x: 0, y: 0 };
  private gestureBtn: Record<string, boolean> = {};

  constructor() {
    addEventListener("keydown", (e) => this.keys.add(e.code));
    addEventListener("keyup", (e) => this.keys.delete(e.code));
  }

  setGestureAxis(x: number, y: number) {
    this.gestureAxis.x = x;
    this.gestureAxis.y = y;
  }
  setGestureButton(name: string, v: boolean) {
    this.gestureBtn[name] = v;
  }

  poll(): InputState {
    let x = 0, y = 0;
    if (this.keys.has("ArrowLeft") || this.keys.has("KeyA")) x -= 1;
    if (this.keys.has("ArrowRight") || this.keys.has("KeyD")) x += 1;
    if (this.keys.has("ArrowUp") || this.keys.has("KeyW")) y -= 1;
    if (this.keys.has("ArrowDown") || this.keys.has("KeyS")) y += 1;
    const gp = navigator.getGamepads?.()[0];
    if (gp) {
      x += Math.abs(gp.axes[0]) > 0.15 ? gp.axes[0] : 0;
      y += Math.abs(gp.axes[1]) > 0.15 ? gp.axes[1] : 0;
    }
    if (Math.abs(this.gestureAxis.x) > 0.05 || Math.abs(this.gestureAxis.y) > 0.05) {
      x += this.gestureAxis.x;
      y += this.gestureAxis.y;
    }
    this.state.axes.x = Math.max(-1, Math.min(1, x));
    this.state.axes.y = Math.max(-1, Math.min(1, y));
    this.state.buttons = {
      jump: this.keys.has("Space") || !!gp?.buttons[0]?.pressed || !!this.gestureBtn["jump"],
      shoot: this.keys.has("KeyJ") || !!gp?.buttons[2]?.pressed || !!this.gestureBtn["shoot"],
      action: this.keys.has("KeyK") || !!gp?.buttons[1]?.pressed,
    };
    return this.state;
  }
}

export const input = new InputManager();
