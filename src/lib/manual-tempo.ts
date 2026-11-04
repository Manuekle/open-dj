import { RHYTHM_VERSION, type Rhythm } from "@/lib/analysis-types";

/* A tempo the DJ sets by hand, for a track the analysis gave none (a loose live take, an orchestra) or the wrong one
   (half or double time). It becomes a constant grid, so sync, bar extrapolation and the planner treat it like a steady
   track the analysis had found. */

export const MIN_BPM = 40;
export const MAX_BPM = 240;

/** A typed tempo as bpm rounded to 0.01, or null when it is not a number in MIN_BPM..MAX_BPM. */
export function parseBpm(text: string): number | null {
  const n = Number(text.trim().replace(",", "."));
  return Number.isFinite(n) && n >= MIN_BPM && n <= MAX_BPM ? Math.round(n * 100) / 100 : null;
}

/** The beat grid of one constant tempo: a beat every 60/bpm seconds from the first beat, over the whole track. The first
    beat is folded into the first beat length, so the grid starts at the top of the track. */
export function gridFromTempo(bpm: number, firstBeat: number, duration: number): Rhythm {
  const period = 60 / bpm;
  const start = Number.isFinite(firstBeat) && firstBeat > 0 ? firstBeat % period : 0;
  const beats: number[] = [];
  for (let t = start; t < duration; t += period) beats.push(Math.round(t * 1000) / 1000);
  return {
    version: RHYTHM_VERSION, beats, strength: beats.map(() => 1), bpm, beatConfidence: 1,
    tempo: { confidence: 1, drift: 0, wander: 0, octaveAmbiguous: false },
    // The DJ gave the beat, not the bar: the first beat is taken as the bar's first.
    downbeat: { phase: 0, confidence: 1, assumed: true },
    grid: "steady",
  };
}

/** Tempo from tap times in seconds: the median gap of the taps since the last pause (over two seconds), or null with
    fewer than three taps. Taps are kept apart from time itself so this stays plain math. */
export function tapBpm(taps: number[]): number | null {
  let from = taps.length - 1;
  while (from > 0 && taps[from] - taps[from - 1] <= 2) from--;
  const run = taps.slice(from);
  if (run.length < 3) return null;
  const gaps = run.slice(1).map((t, i) => t - run[i]).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  const bpm = Math.round(60 / median * 100) / 100;
  return bpm >= MIN_BPM && bpm <= MAX_BPM ? bpm : null;
}
