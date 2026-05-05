class SFX {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private padOn = false;

  private ensure() {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
    addEventListener("pointerdown", () => this.ctx?.resume(), { once: true });
    addEventListener("keydown", () => this.ctx?.resume(), { once: true });
  }

  private blip(freq: number, dur = 0.15, type: OscillatorType = "sine", gain = 0.4, slide = 0) {
    this.ensure();
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur);
  }

  capture() { this.blip(880, 0.12, "triangle", 0.35); setTimeout(() => this.blip(1320, 0.18, "triangle", 0.3), 80); }
  portal()  { this.blip(220, 0.6, "sawtooth", 0.25, 600); setTimeout(() => this.blip(440, 0.5, "sine", 0.2, 400), 200); }
  jump()    { this.blip(420, 0.12, "square", 0.2, 240); }
  shoot()   { this.blip(700, 0.07, "square", 0.15, -300); }
  hit()     { this.blip(140, 0.18, "sawtooth", 0.3, -80); }
  drop()    { this.blip(900, 0.08, "sine", 0.35, -700); setTimeout(() => this.blip(180, 0.25, "sine", 0.3, -60), 60); }

  ambientPad(on: boolean) {
    this.ensure();
    if (!this.ctx || !this.master) return;
    if (on === this.padOn) return;
    this.padOn = on;
    if (!on) return;
    const t = this.ctx.currentTime;
    [110, 165, 220].forEach((f, i) => {
      const o = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.value = 0.04 + i * 0.01;
      o.connect(g).connect(this.master!);
      const lfo = this.ctx!.createOscillator();
      const lfoG = this.ctx!.createGain();
      lfo.frequency.value = 0.1 + i * 0.05;
      lfoG.gain.value = 0.5;
      lfo.connect(lfoG).connect(o.frequency);
      o.start(t); lfo.start(t);
    });
  }
}

export const sfx = new SFX();
