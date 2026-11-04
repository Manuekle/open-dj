import type { Track } from "@/lib/types";

/* Fixtures shared by the tests: a Track with only what the planner reads, and synthetic audio with a known answer. */

export function track(patch: Partial<Track> = {}): Track {
  return {
    id: patch.title ?? "t", title: "Track", artist: "Test", blob: new Blob([]), fileName: "t.wav", duration: 240,
    bpm: 128, peaks: [], addedAt: 0, url: "", firstBeat: 0, ...patch,
  };
}

/** A small deterministic noise source, so a fixture is the same on every run. */
export function noise(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 31 - 1; };
}

/** A kick drum on every beat (a 55 Hz sine with a 60 ms decay) over a faint noise floor, mono at `rate`. */
export function kicks(bpm: number, seconds: number, rate: number, offset = 0) {
  const x = new Float32Array(Math.round(seconds * rate));
  const random = noise(7);
  for (let i = 0; i < x.length; i++) x[i] = 0.002 * random();
  const beat = 60 / bpm, length = Math.round(0.25 * rate);
  for (let t = offset; t < seconds; t += beat) {
    const start = Math.round(t * rate);
    for (let i = 0; i < length && start + i < x.length; i++) {
      const u = i / rate;
      x[start + i] += 0.8 * Math.sin(2 * Math.PI * 55 * u) * Math.exp(-u / 0.06);
    }
  }
  return x;
}

/** Sine tones summed, each [frequency Hz, amplitude], mono at `rate`. */
export function tones(parts: [number, number][], seconds: number, rate: number) {
  const x = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < x.length; i++) for (const [f, a] of parts) x[i] += a * Math.sin(2 * Math.PI * f * i / rate);
  return x;
}

/** A 16-bit PCM WAV file of mono samples, written to every channel. */
export function wav(x: Float32Array, rate: number, channels = 2) {
  const bytes = new DataView(new ArrayBuffer(44 + x.length * channels * 2));
  const text = (at: number, s: string) => [...s].forEach((c, i) => bytes.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF"); bytes.setUint32(4, 36 + x.length * channels * 2, true); text(8, "WAVE");
  text(12, "fmt "); bytes.setUint32(16, 16, true); bytes.setUint16(20, 1, true); bytes.setUint16(22, channels, true);
  bytes.setUint32(24, rate, true); bytes.setUint32(28, rate * channels * 2, true); bytes.setUint16(32, channels * 2, true); bytes.setUint16(34, 16, true);
  text(36, "data"); bytes.setUint32(40, x.length * channels * 2, true);
  for (let i = 0; i < x.length; i++) for (let c = 0; c < channels; c++) {
    bytes.setInt16(44 + (i * channels + c) * 2, Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), true);
  }
  return new Blob([bytes.buffer], { type: "audio/wav" });
}

/* ---- Synthetic songs with a known answer -------------------------------------------------------------------------
   Every song is built here from sines and noise, so its beats, bars and sections are known exactly and there is no
   audio whose licence needs checking. They are far simpler than a recording (no vocals, no reverb, no mastering), so
   a pass here shows the algorithm works, not how it will do on a mix. */

export type Layer = "kick" | "snare" | "hat" | "bass" | "pad" | "lead";
export type SongSection = { name: string; bars: number; layers: Layer[]; gain?: number; ramp?: [number, number] };
export type SongOptions = {
  /** Constant bpm, or the bpm at each beat index (a ramp, a step). */
  bpm: number | ((beat: number) => number);
  sections: SongSection[];
  rate?: number;
  /** Seconds before the first beat. */
  offset?: number;
  /** Louder kick, a held bass note and a chord change on beat one. False plays every beat alike. */
  accent?: boolean;
  /** Random timing error per beat, seconds (a human player). */
  jitter?: number;
  seed?: number;
};
export type Song = {
  x: Float32Array; rate: number;
  /** Where each beat sounds, seconds. */
  beats: number[];
  /** Beat indices that start a bar. */
  downbeats: number[];
  sections: { name: string; start: number; end: number; bars: number }[];
};

const CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // Am F C G
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

export function song(options: SongOptions): Song {
  const rate = options.rate ?? 11025, accent = options.accent ?? true;
  const random = noise(options.seed ?? 11), jitter = options.jitter ?? 0;
  const bpmAt = typeof options.bpm === "function" ? options.bpm : () => options.bpm as number;
  const totalBars = options.sections.reduce((s, c) => s + c.bars, 0);
  const grid: number[] = [];
  let t = options.offset ?? 0;
  for (let b = 0; b < totalBars * 4; b++) { grid.push(t); t += 60 / bpmAt(b); }
  const end = t + 1;
  const x = new Float32Array(Math.round(end * rate));
  for (let i = 0; i < x.length; i++) x[i] = 0.002 * random();
  const played = grid.map(g => g + (jitter ? jitter * random() : 0));

  const add = (at: number, length: number, f: (u: number) => number) => {
    const start = Math.round(at * rate);
    for (let i = 0; i < length * rate && start + i < x.length; i++) if (start + i >= 0) x[start + i] += f(i / rate);
  };
  const sections: Song["sections"] = [];
  let bar = 0;
  for (const section of options.sections) {
    const startBeat = bar * 4;
    sections.push({ name: section.name, start: played[startBeat], end: played[Math.min(played.length - 1, (bar + section.bars) * 4)] ?? end, bars: section.bars });
    for (let k = 0; k < section.bars; k++, bar++) {
      const chord = CHORDS[Math.floor(bar / 2) % 4];
      const level = (section.gain ?? 1) * (section.ramp ? section.ramp[0] + (section.ramp[1] - section.ramp[0]) * (k / Math.max(1, section.bars - 1)) : 1);
      const has = (l: Layer) => section.layers.includes(l);
      const barStart = played[bar * 4], barEnd = played[Math.min(played.length - 1, bar * 4 + 4)];
      if (has("pad")) {
        const len = Math.max(0.2, (barEnd > barStart ? barEnd - barStart : 2));
        for (const note of chord) add(barStart, len, u => 0.05 * level * Math.sin(2 * Math.PI * hz(note) * u) * Math.min(1, u / 0.05));
      }
      for (let p = 0; p < 4; p++) {
        const b = bar * 4 + p, at = played[b], beat = grid[Math.min(grid.length - 1, b + 1)] - grid[b] || 0.5;
        if (has("kick")) {
          // A 55 Hz thump with the beater click a real kick has: a few milliseconds of broadband noise.
          const amp = (accent && p === 0 ? 0.9 : 0.65) * level;
          add(at, 0.25, u => amp * Math.sin(2 * Math.PI * 55 * u) * Math.exp(-u / 0.06));
          add(at, 0.012, u => amp * 0.5 * (random() - 0.5) * 2 * Math.exp(-u / 0.003));
        }
        if (has("snare") && (p === 1 || p === 3)) add(at, 0.15, u => level * (0.3 * random() + 0.2 * Math.sin(2 * Math.PI * 210 * u)) * Math.exp(-u / 0.04));
        if (has("hat")) for (const h of [0.5]) add(at + h * beat, 0.05, u => 0.1 * level * (random() - 0.5) * 2 * Math.exp(-u / 0.012));
        if (has("bass")) {
          const note = chord[0] - 24;
          add(at + 0.5 * beat, 0.5 * beat, u => 0.3 * level * Math.sin(2 * Math.PI * hz(note) * u) * Math.exp(-u / 0.12));
          if (accent && p === 0) add(at, beat * 1.6, u => 0.3 * level * Math.sin(2 * Math.PI * hz(note) * u) * Math.exp(-u / 0.5));
        }
        if (has("lead")) for (let s = 0; s < 4; s++) {
          const note = chord[(s + p) % 3] + 12;
          add(at + s * beat / 4, beat / 4, u => 0.07 * level * Math.sin(2 * Math.PI * hz(note) * u) * Math.exp(-u / 0.08));
        }
      }
    }
  }
  return { x, rate, beats: played, downbeats: Array.from({ length: totalBars }, (_, k) => k * 4), sections };
}

/** A club arrangement, 72 bars: intro, build, drop, breakdown, drop, outro. */
export const CLUB: SongSection[] = [
  { name: "intro", bars: 8, layers: ["hat", "pad"], gain: 0.5 },
  { name: "build", bars: 8, layers: ["kick", "hat", "pad", "snare"], ramp: [0.5, 0.9] },
  { name: "drop", bars: 16, layers: ["kick", "snare", "hat", "bass", "lead", "pad"] },
  { name: "breakdown", bars: 8, layers: ["pad", "lead"], gain: 0.6 },
  { name: "drop", bars: 16, layers: ["kick", "snare", "hat", "bass", "lead", "pad"] },
  { name: "outro", bars: 16, layers: ["kick", "hat", "pad"], ramp: [0.8, 0.3] },
];
