/**
 * Procedural ambient music engine.
 *
 * Uses pure Web Audio (no asset files) so it ships with the app and never
 * misses a beat. A simple scheduler drives:
 *   - a soft sustained pad (chord tones)
 *   - an arpeggio at 1/8 notes
 *   - an occasional bell-pluck melody on scale degrees
 *
 * Mood presets pick which voices play, the wave shapes, and the tempo
 * envelope feel. Volume and tempo are tunable from the admin panel.
 *
 * Public API:
 *   music.start()                  — kick the engine if it isn't running
 *   music.stop()                   — fade out + halt
 *   music.setMood(name)            — switch progression / instrumentation
 *   music.setVolume(0..1)          — master gain
 *   music.setTempo(bpmFloat)       — beats per minute (60..160)
 *   music.applyFromSettings(s)     — read ambientSound / musicMood / musicVolume / musicTempo
 */

type Mood = "calm" | "magical" | "adventure" | "mystic";

const SCALES: Record<Mood, number[]> = {
  // semitone offsets from the root, used to pick melody notes
  calm:      [0, 2, 4, 7, 9, 11, 12, 14, 16],            // major-ish
  magical:   [0, 2, 3, 5, 7, 8, 10, 12, 14, 15],         // dorian → fairy
  adventure: [0, 2, 4, 5, 7, 9, 11, 12],                 // major
  mystic:    [0, 2, 3, 5, 7, 8, 11, 12],                 // harmonic minor
};

// Chord progression as semitone-offset triples (root third fifth). Loops.
const PROGRESSIONS: Record<Mood, number[][]> = {
  calm:      [[0, 4, 7], [-3, 0, 4], [-5, 0, 5], [-7, -3, 0]],     // I  vi  IV  V
  magical:   [[0, 3, 7], [5, 8, 12], [-2, 2, 5], [-5, 0, 3]],
  adventure: [[0, 4, 7], [7, 11, 14], [-3, 0, 4], [-5, 0, 4]],     // I  V  vi  IV
  mystic:    [[0, 3, 7], [-2, 2, 5], [3, 7, 10], [5, 8, 12]],
};

const PAD_WAVES: Record<Mood, OscillatorType> = {
  calm: "sine",
  magical: "triangle",
  adventure: "sawtooth",
  mystic: "triangle",
};

const ARP_WAVES: Record<Mood, OscillatorType> = {
  calm: "sine",
  magical: "triangle",
  adventure: "square",
  mystic: "triangle",
};

class MusicEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private padBus: GainNode | null = null;
  private arpBus: GainNode | null = null;
  private bellBus: GainNode | null = null;
  private convolver: ConvolverNode | null = null;
  private wetBus: GainNode | null = null;
  private dryBus: GainNode | null = null;

  private timer: number | null = null;
  private nextBeat = 0;        // ctx.time of next 1/4 note
  private beatIdx = 0;         // running beat counter
  private chordIdx = 0;
  private rootHz = 220;        // A3 — base for transposition

  private mood: Mood = "magical";
  private volume = 0.6;
  private tempo = 80;          // BPM
  private playing = false;

  // ----- audio graph --------------------------------------------------
  private ensureCtx() {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);

    // Per-voice busses so we can balance them.
    this.padBus = this.ctx.createGain();   this.padBus.gain.value = 0.4;
    this.arpBus = this.ctx.createGain();   this.arpBus.gain.value = 0.2;
    this.bellBus = this.ctx.createGain();  this.bellBus.gain.value = 0.35;

    // A short procedural reverb so it sounds spacious.
    const ir = this.makeImpulseResponse(2.4, 2.0);
    this.convolver = this.ctx.createConvolver();
    this.convolver.buffer = ir;
    this.wetBus = this.ctx.createGain(); this.wetBus.gain.value = 0.55;
    this.dryBus = this.ctx.createGain(); this.dryBus.gain.value = 0.85;

    for (const bus of [this.padBus, this.arpBus, this.bellBus]) {
      bus.connect(this.dryBus);
      bus.connect(this.convolver);
    }
    this.convolver.connect(this.wetBus);
    this.dryBus.connect(this.master);
    this.wetBus.connect(this.master);

    // Browser policy: AudioContext may start suspended; resume on first input.
    addEventListener("pointerdown", () => this.ctx?.resume(), { once: true });
    addEventListener("keydown",     () => this.ctx?.resume(), { once: true });
  }

  private makeImpulseResponse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const rate = ctx.sampleRate;
    const len = rate * seconds;
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  // ----- voices -------------------------------------------------------
  private playPad(freqs: number[], durSec: number) {
    if (!this.ctx || !this.padBus) return;
    const t = this.ctx.currentTime;
    const wave = PAD_WAVES[this.mood];
    for (const f of freqs) {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      const lp = this.ctx.createBiquadFilter();
      lp.type = "lowpass"; lp.frequency.value = 1200; lp.Q.value = 0.7;
      o.type = wave;
      o.frequency.value = f;
      o.detune.value = (Math.random() - 0.5) * 8;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.18, t + 0.6);
      g.gain.setValueAtTime(0.18, t + durSec - 0.6);
      g.gain.linearRampToValueAtTime(0, t + durSec);
      o.connect(lp).connect(g).connect(this.padBus);
      o.start(t);
      o.stop(t + durSec + 0.02);
    }
  }

  private playArpNote(freq: number, atTime: number, durSec: number) {
    if (!this.ctx || !this.arpBus) return;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = ARP_WAVES[this.mood];
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, atTime);
    g.gain.linearRampToValueAtTime(0.16, atTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, atTime + durSec);
    o.connect(g).connect(this.arpBus);
    o.start(atTime);
    o.stop(atTime + durSec + 0.02);
  }

  private playBell(freq: number, atTime: number) {
    if (!this.ctx || !this.bellBus) return;
    // bell = two sines (1× and 2.01×) with fast attack and long decay.
    for (const mul of [1, 2.01]) {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = "sine";
      o.frequency.value = freq * mul;
      g.gain.setValueAtTime(0, atTime);
      g.gain.linearRampToValueAtTime(mul === 1 ? 0.22 : 0.08, atTime + 0.005);
      g.gain.exponentialRampToValueAtTime(0.001, atTime + 1.4);
      o.connect(g).connect(this.bellBus);
      o.start(atTime);
      o.stop(atTime + 1.5);
    }
  }

  // ----- scheduler ----------------------------------------------------
  private scheduleNext() {
    if (!this.ctx || !this.playing) return;
    const beatSec = 60 / this.tempo;
    const lookaheadSec = 0.2;
    while (this.nextBeat < this.ctx.currentTime + lookaheadSec) {
      this.fireBeat(this.beatIdx, this.nextBeat, beatSec);
      this.nextBeat += beatSec;
      this.beatIdx++;
    }
  }

  private fireBeat(idx: number, time: number, beatSec: number) {
    const prog = PROGRESSIONS[this.mood];
    const beatsPerChord = 8;     // each chord lasts 8 beats
    const localBeat = idx % beatsPerChord;

    if (localBeat === 0) {
      // New chord — restart pad
      const chord = prog[this.chordIdx % prog.length];
      this.chordIdx = (this.chordIdx + 1) % prog.length;
      const freqs = chord.map((semi) => this.rootHz * Math.pow(2, semi / 12));
      this.playPad(freqs, beatSec * beatsPerChord);
    }

    // Arpeggio every 1/8 (twice per beat)
    const arpEnabled = this.mood !== "calm";
    if (arpEnabled) {
      const chord = prog[(this.chordIdx - 1 + prog.length) % prog.length];
      const tones = chord.concat(chord.map((s) => s + 12));
      const tone = tones[idx % tones.length];
      const f = this.rootHz * Math.pow(2, tone / 12);
      this.playArpNote(f, time, beatSec * 0.45);
      this.playArpNote(f, time + beatSec * 0.5, beatSec * 0.45);
    }

    // Bell melody on every 4 beats, picks a scale tone above the chord
    if (idx % 4 === 0 && Math.random() < 0.7) {
      const scale = SCALES[this.mood];
      const semi = scale[Math.floor(Math.random() * scale.length)] + 12;
      const f = this.rootHz * Math.pow(2, semi / 12);
      this.playBell(f, time + beatSec * 0.5);
    }
  }

  // ----- public -------------------------------------------------------
  setMood(m: Mood) {
    if (this.mood === m) return;
    this.mood = m;
    // restart progression cleanly
    this.chordIdx = 0;
  }
  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master && this.ctx) {
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.linearRampToValueAtTime(this.volume, t + 0.2);
    }
  }
  setTempo(bpm: number) {
    this.tempo = Math.max(40, Math.min(180, bpm));
  }

  start() {
    if (this.playing) return;
    this.ensureCtx();
    if (!this.ctx) return;
    this.playing = true;
    this.nextBeat = this.ctx.currentTime + 0.1;
    this.beatIdx = 0;
    this.chordIdx = 0;
    this.timer = window.setInterval(() => this.scheduleNext(), 50);
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.master && this.ctx) {
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.linearRampToValueAtTime(0, t + 0.6);
      // restore later when we start again
      window.setTimeout(() => this.master && (this.master.gain.value = this.volume), 1000);
    }
  }

  applyFromSettings(s: any) {
    if (!s) return;
    if (typeof s.musicMood === "string") this.setMood(s.musicMood as Mood);
    if (typeof s.musicVolume === "number") this.setVolume(s.musicVolume);
    if (typeof s.musicTempo === "number") this.setTempo(s.musicTempo);
    if (s.ambientSound !== false) this.start();
    else this.stop();
  }
}

export const music = new MusicEngine();
export type { Mood };
