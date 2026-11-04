import { extractFeatures, type Features } from "@/lib/features";
import { analyzeRhythm } from "@/lib/rhythm";
import type { Rhythm } from "@/lib/analysis-types";

/* Charts for the rhythm game, made from the audio alone. The onset envelopes of lib/features.ts say where something
   happens; the beat grid of lib/rhythm.ts says where a player would feel it. A difficulty is a rule for which onsets to
   keep (how strong, how far apart) and how tightly to pull them onto the grid. Lanes follow the sound: low sounds go to
   the left lanes and bright ones to the right, ranked within the track so every lane is used. */

export type Difficulty = "easy" | "normal" | "hard" | "expert";
export type Note = { t: number; lane: number };
export type Chart = { difficulty: Difficulty; lanes: number; notes: Note[] };
export type ChartSet = { bpm: number | null; duration: number; charts: Record<Difficulty, Chart> };

type Rule = {
  id: Difficulty; label: string; lanes: 4 | 6 | 7;
  /** Fraction of the onsets kept, strongest first. */
  keep: number;
  /** Shortest time between two notes, seconds. */
  gap: number;
  /** Grid subdivisions per beat that notes snap to. */
  div: number;
  /** Fraction of the strongest notes that also get a second, simultaneous note. */
  chords: number;
};
export const DIFFICULTIES: Rule[] = [
  { id: "easy", label: "Easy", lanes: 4, keep: 0.4, gap: 0.46, div: 2, chords: 0 },
  { id: "normal", label: "Normal", lanes: 4, keep: 0.6, gap: 0.28, div: 2, chords: 0 },
  { id: "hard", label: "Hard", lanes: 6, keep: 0.85, gap: 0.17, div: 4, chords: 0.04 },
  { id: "expert", label: "Expert", lanes: 7, keep: 1, gap: 0.115, div: 4, chords: 0.12 },
];

/** Seconds from the start of a fast frame to the onset its rise stands for (see LATENCY in lib/rhythm.ts). */
const LATENCY = 0.04;
/** Nothing is asked of the player before this, so the first note never lands on the start. */
const LEAD = 1.2;
const TAIL = 0.4;

type Peak = { t: number; strength: number; centroid: number; frame: number };

/** Local maxima of the combined onset envelope, with the spectral centroid (0 low .. 1 bright) at each. */
function peaks(f: Features): Peak[] {
  const n = f.onset.length;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = f.onset[i] + 0.6 * f.lowOnset[i];
  const sorted = Float32Array.from(s).sort();
  const floor = 0.08 * (sorted[Math.floor(n * 0.95)] ?? 0);
  const radius = 3;
  const out: Peak[] = [];
  for (let i = radius; i < n - radius; i++) {
    const v = s[i];
    if (v <= floor || v <= 0) continue;
    let top = true;
    for (let k = 1; k <= radius && top; k++) if (s[i - k] > v || s[i + k] >= v) top = false;
    if (!top) continue;
    let weight = 0, sum = 0;
    for (let g = i; g < Math.min(n, i + 3); g++) {
      for (let b = 0; b < f.bandCount; b++) {
        const w = Math.max(0, f.bands[g * f.bandCount + b] + 60);
        weight += w; sum += w * b;
      }
    }
    out.push({ t: i / f.fps + LATENCY, strength: v, centroid: weight > 0 ? sum / weight / Math.max(1, f.bandCount - 1) : 0.5, frame: i });
  }
  return out;
}

/** The grid point nearest t among `div` subdivisions of the tracked beats, or t when none is close enough. */
function snap(t: number, beats: number[], div: number): number {
  let lo = 0, hi = beats.length - 1;
  if (t < beats[0] - 0.5 || t > beats[hi] + 0.5) return t;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (beats[mid] <= t) lo = mid; else hi = mid - 1; }
  const a = beats[lo], b = beats[Math.min(beats.length - 1, lo + 1)];
  const period = b > a ? b - a : (a - beats[Math.max(0, lo - 1)]) || 0.5;
  const step = period / div;
  const k = Math.round((t - a) / step);
  const g = a + k * step;
  return Math.abs(g - t) <= step * 0.45 ? g : t;
}

export function chartFromFeatures(f: Features, rhythm: Rhythm, duration: number, rule: Rule, all: Peak[] = peaks(f)): Chart {
  const byStrength = [...all].sort((a, b) => b.strength - a.strength);
  const kept = byStrength.slice(0, Math.ceil(byStrength.length * rule.keep));
  // Strongest first, each onset takes the time around it: the weaker ones inside the gap drop out.
  const taken: Peak[] = [];
  for (const p of kept) {
    if (p.t < LEAD || p.t > duration - TAIL) continue;
    if (taken.every(q => Math.abs(q.t - p.t) >= rule.gap)) taken.push(p);
  }
  taken.sort((a, b) => a.t - b.t);

  const gridded = rhythm.grid !== "none" && rhythm.grid !== "weak" && rhythm.beats.length >= 8;
  const timed: Peak[] = [];
  for (const p of taken) {
    const t = gridded ? snap(p.t, rhythm.beats, rule.div) : p.t;
    const last = timed[timed.length - 1];
    if (last && t - last.t < rule.gap * 0.9) continue;
    timed.push({ ...p, t });
  }

  // A rank per note rather than the raw centroid, so a dull or a bright track still uses every lane.
  const order = timed.map((p, i) => ({ i, c: p.centroid })).sort((a, b) => a.c - b.c);
  const rank = new Float32Array(timed.length);
  order.forEach((o, r) => { rank[o.i] = timed.length > 1 ? r / (timed.length - 1) : 0.5; });

  const notes: Note[] = [];
  let prev = -1, prevT = -9, nudge = 1;
  timed.forEach((p, i) => {
    let lane = Math.min(rule.lanes - 1, Math.floor(rank[i] * rule.lanes));
    // The same lane twice in a quick run is a stream the hand cannot follow; step to a neighbour instead.
    if (lane === prev && p.t - prevT < 0.4) {
      lane += lane + nudge < 0 || lane + nudge >= rule.lanes ? -nudge : nudge;
      nudge = -nudge;
    }
    notes.push({ t: p.t, lane });
    prev = lane; prevT = p.t;
  });

  if (rule.chords > 0 && timed.length) {
    const cut = [...timed].sort((a, b) => b.strength - a.strength)[Math.max(0, Math.floor(timed.length * rule.chords) - 1)].strength;
    const count = notes.length;
    for (let i = 0; i < count; i++) {
      if (timed[i].strength < cut) continue;
      const other = (notes[i].lane + Math.ceil(rule.lanes / 2)) % rule.lanes;
      notes.push({ t: notes[i].t, lane: other });
    }
    notes.sort((a, b) => a.t - b.t || a.lane - b.lane);
  }
  return { difficulty: rule.id, lanes: rule.lanes, notes };
}

/** Every difficulty from one mono copy of the track (any rate; the analysis was tuned on 11025 Hz). */
export function buildCharts(samples: Float32Array, rate: number, bpmHint: number | null = null): ChartSet {
  const duration = samples.length / rate;
  const features = extractFeatures(samples, rate);
  const rhythm = analyzeRhythm(features, { bpm: bpmHint }, duration);
  const all = peaks(features);
  const charts = {} as Record<Difficulty, Chart>;
  for (const rule of DIFFICULTIES) charts[rule.id] = chartFromFeatures(features, rhythm, duration, rule, all);
  return { bpm: rhythm.bpm, duration, charts };
}
