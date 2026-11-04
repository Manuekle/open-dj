import type { Chart } from "@/lib/rhythm-game/chart";
import { Judge, type Judgement, type Stats } from "@/lib/rhythm-game/judge";

/* One run of one chart: the song on the audio clock, the notes falling to a line on a canvas, the keys and touches that
   hit them. The audio context's own clock is the only clock, so a hiccup in drawing never moves the notes off the
   music. It owns no React state; the page is told when the run ends. */

/** Key per lane, by lane count. Index = lane. */
export const KEY_CODES: Record<number, string[]> = {
  4: ["KeyD", "KeyF", "KeyJ", "KeyK"],
  6: ["KeyS", "KeyD", "KeyF", "KeyJ", "KeyK", "KeyL"],
  7: ["KeyS", "KeyD", "KeyF", "Space", "KeyJ", "KeyK", "KeyL"],
};
const keyLabel = (code: string) => code === "Space" ? "␣" : code.replace("Key", "");

/** Seconds of silence before the song starts, so the first notes are on screen before they are due. */
const LEAD_IN = 2.5;
const JUDGE_COLOR: Record<Judgement, string> = { perfect: "ok", great: "accent", good: "warn", miss: "fail" };
const JUDGE_TEXT: Record<Judgement, string> = { perfect: "PERFECT", great: "GREAT", good: "GOOD", miss: "MISS" };

export type RunOptions = {
  canvas: HTMLCanvasElement;
  context: AudioContext;
  audio: AudioBuffer;
  chart: Chart;
  /** Fall speed multiplier, 0.5..2.5. */
  speed: number;
  /** Seconds added to the clock for a slow output (Bluetooth); positive when notes feel early. */
  offset: number;
  onEnd: (stats: Stats) => void;
};

export class Run {
  private readonly o: RunOptions;
  private readonly judge: Judge;
  private readonly keys: string[];
  private source: AudioBufferSourceNode | null = null;
  private startAt = 0;
  private raf = 0;
  private from = 0;
  private ended = false;
  private paused = false;
  private speed: number;
  private pressedAt: number[];
  private last: { judgement: Judgement; at: number; offset: number } | null = null;
  private readonly colors: Record<string, string>;
  private readonly font: string;

  constructor(options: RunOptions) {
    this.o = options;
    this.speed = options.speed;
    this.judge = new Judge(options.chart);
    this.keys = KEY_CODES[options.chart.lanes];
    this.pressedAt = options.chart.lanes ? Array(options.chart.lanes).fill(-9) : [];
    const style = getComputedStyle(options.canvas);
    const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    this.colors = {
      page: read("--page", "#111"), panel: read("--panel", "#1b1b1a"), line: read("--line", "#3a3a38"), lineFaint: read("--line-faint", "#262625"),
      text1: read("--text-1", "#f2f2ee"), text3: read("--text-3", "#888"),
      accent: read("--accent-text", "#f5d90a"), ok: read("--ok-text", "#5fd38d"), warn: read("--warn-text", "#e8b04a"), fail: read("--fail-text", "#ff6b6b"),
    };
    this.font = style.getPropertyValue("--font-mono").trim() || "ui-monospace, monospace";
  }

  /** Song time, seconds: negative during the lead-in. */
  get time() {
    const c = this.o.context;
    return c.currentTime - this.startAt - (c.outputLatency || 0) + this.o.offset;
  }

  start() {
    const c = this.o.context;
    this.startAt = c.currentTime + LEAD_IN;
    const source = c.createBufferSource();
    source.buffer = this.o.audio;
    source.connect(c.destination);
    source.start(this.startAt);
    this.source = source;
    window.addEventListener("keydown", this.onKey);
    this.o.canvas.addEventListener("pointerdown", this.onPointer);
    this.o.canvas.style.touchAction = "none";
    const loop = () => { this.frame(); this.raf = requestAnimationFrame(loop); };
    loop();
  }

  get isPaused() { return this.paused; }
  async pause() { if (this.paused || this.ended) return; this.paused = true; await this.o.context.suspend(); }
  async resume() { if (!this.paused) return; this.paused = false; await this.o.context.resume(); }
  setSpeed(v: number) { this.speed = Math.max(0.5, Math.min(2.5, v)); return this.speed; }

  destroy() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener("keydown", this.onKey);
    this.o.canvas.removeEventListener("pointerdown", this.onPointer);
    try { this.source?.stop(); } catch { /* already stopped */ }
    this.source?.disconnect();
    this.source = null;
    // A suspended context would swallow the next run's clock.
    if (this.o.context.state === "suspended") void this.o.context.resume();
  }

  private hit(lane: number) {
    if (this.paused || this.ended) return;
    const t = this.time;
    this.pressedAt[lane] = t;
    const outcome = this.judge.press(lane, t);
    if (outcome) this.last = { judgement: outcome.judgement, at: t, offset: outcome.offset };
  }

  private readonly onKey = (e: KeyboardEvent) => {
    if (e.code === "ArrowUp" || e.code === "ArrowDown") { e.preventDefault(); this.setSpeed(this.speed + (e.code === "ArrowUp" ? 0.1 : -0.1)); return; }
    if (e.repeat) return;
    const lane = this.keys.indexOf(e.code);
    if (lane < 0) return;
    e.preventDefault();
    this.hit(lane);
  };
  private readonly onPointer = (e: PointerEvent) => {
    const rect = this.o.canvas.getBoundingClientRect();
    this.hit(Math.max(0, Math.min(this.o.chart.lanes - 1, Math.floor((e.clientX - rect.left) / rect.width * this.o.chart.lanes))));
  };

  private frame() {
    if (this.paused) { this.draw(this.time); return; }
    const t = this.time;
    for (const out of this.judge.advance(t)) this.last = { judgement: out.judgement, at: t, offset: 0 };
    this.draw(t);
    const end = (this.judge.notes[this.judge.notes.length - 1]?.t ?? 0) + 1.2;
    if (!this.ended && this.judge.finished && t > end) {
      this.ended = true;
      this.o.onEnd(this.judge.stats);
    } else if (!this.ended && t > this.o.audio.duration + 1) {
      for (const out of this.judge.advance(1e9)) this.last = { judgement: out.judgement, at: t, offset: 0 };
      this.ended = true;
      this.o.onEnd(this.judge.stats);
    }
  }

  private draw(t: number) {
    const { canvas, chart } = this.o, c = this.colors;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    // Opaque: every frame paints the page colour first, so the compositor need not blend the canvas with what is under it.
    const g = canvas.getContext("2d", { alpha: false });
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = c.page; g.fillRect(0, 0, w, h);

    const lanes = chart.lanes, lw = w / lanes, hitY = h * 0.84, scale = h / 760;
    const pxPerSecond = 520 * this.speed * scale, noteH = Math.max(14, 26 * scale);

    // Lanes, with a wash where a key was just pressed.
    for (let l = 0; l < lanes; l++) {
      const x = l * lw;
      const since = t - this.pressedAt[l];
      if (since >= 0 && since < 0.18) { g.globalAlpha = (1 - since / 0.18) * 0.22; g.fillStyle = c.accent; g.fillRect(x, 0, lw, hitY); g.globalAlpha = 1; }
      g.strokeStyle = c.lineFaint; g.lineWidth = 1;
      g.beginPath(); g.moveTo(Math.round(x) + 0.5, 0); g.lineTo(Math.round(x) + 0.5, h); g.stroke();
    }
    g.fillStyle = c.panel; g.fillRect(0, hitY, w, h - hitY);
    g.fillStyle = c.accent; g.fillRect(0, hitY - 1, w, 2);

    // Notes: the list is by time, so draw from the first one still on screen until one is above it.
    const notes = this.judge.notes;
    while (this.from < notes.length && notes[this.from].done && notes[this.from].t < t - 1) this.from++;
    for (let i = this.from; i < notes.length; i++) {
      const n = notes[i], y = hitY - (n.t - t) * pxPerSecond;
      if (y < -noteH) break;
      if (n.done || y > h + noteH) continue;
      const late = y > hitY + noteH;
      g.fillStyle = late ? c.line : c.text1;
      g.fillRect(n.lane * lw + 3, y - noteH / 2, lw - 6, noteH);
    }

    // Keys.
    g.textAlign = "center"; g.textBaseline = "middle";
    g.font = `600 ${Math.round(Math.max(13, 18 * scale))}px ${this.font}`;
    for (let l = 0; l < lanes; l++) {
      g.fillStyle = t - this.pressedAt[l] < 0.12 ? c.accent : c.text3;
      g.fillText(keyLabel(this.keys[l]), (l + 0.5) * lw, hitY + (h - hitY) / 2);
    }

    // Score, combo, the last judgement.
    const s = this.judge.stats;
    g.textAlign = "left"; g.textBaseline = "top";
    g.fillStyle = c.text3; g.font = `600 ${Math.round(11 * Math.max(1, scale))}px ${this.font}`;
    g.fillText("SCORE", 14, 14);
    g.fillStyle = c.text1; g.font = `700 ${Math.round(30 * Math.max(0.8, scale))}px ${this.font}`;
    g.fillText(String(s.score), 14, 30);
    g.textAlign = "right";
    g.fillStyle = c.text3; g.font = `600 ${Math.round(11 * Math.max(1, scale))}px ${this.font}`;
    g.fillText(`${(s.accuracy * 100).toFixed(1)}%  ·  ${this.speed.toFixed(1)}×`, w - 14, 14);

    g.textAlign = "center";
    if (t < 0) {
      g.fillStyle = c.text1; g.font = `700 ${Math.round(34 * Math.max(0.8, scale))}px ${this.font}`;
      g.fillText(String(Math.ceil(-t)), w / 2, h * 0.38);
    } else {
      if (s.combo >= 2) {
        g.fillStyle = c.text1; g.font = `700 ${Math.round(40 * Math.max(0.8, scale))}px ${this.font}`;
        g.fillText(String(s.combo), w / 2, h * 0.3);
        g.fillStyle = c.text3; g.font = `600 ${Math.round(11 * Math.max(1, scale))}px ${this.font}`;
        g.fillText("COMBO", w / 2, h * 0.3 + 44 * Math.max(0.8, scale));
      }
      if (this.last) {
        const age = t - this.last.at;
        if (age >= 0 && age < 0.6) {
          g.globalAlpha = 1 - age / 0.6;
          g.fillStyle = c[JUDGE_COLOR[this.last.judgement]];
          g.font = `700 ${Math.round(24 * Math.max(0.8, scale))}px ${this.font}`;
          g.fillText(JUDGE_TEXT[this.last.judgement], w / 2, h * 0.55 - age * 24);
          if (this.last.judgement !== "miss" && Math.abs(this.last.offset) > 0.02) {
            g.font = `600 ${Math.round(11 * Math.max(1, scale))}px ${this.font}`; g.fillStyle = c.text3;
            g.fillText(this.last.offset < 0 ? "EARLY" : "LATE", w / 2, h * 0.55 + 22 - age * 24);
          }
          g.globalAlpha = 1;
        }
      }
    }
    // A thin progress rule along the top.
    const total = this.o.audio.duration;
    g.fillStyle = c.accent; g.fillRect(0, 0, Math.max(0, Math.min(1, t / total)) * w, 2);
  }
}
