import type { Track } from "@/lib/types";

/* What the planner may rely on from a track's beat analysis. Tracks stored before the beat tracker (no `rhythm`) keep
   the old behaviour: the legacy bpm and first beat, extrapolated. Tracks with a rhythm result use real beats, and a
   track whose beats prove the tempo moves is never extrapolated or stretched to a constant rate. */

/** Tempo for matching decks at a constant rate, or null when there is none worth matching (no pulse, or a tempo that
    drifts: a constant stretch would be off the beat within a few bars). */
export function gridBpm(track: Track): number | null {
  if (!track.bpm) return null;
  return track.rhythm?.grid === "variable" ? null : track.bpm;
}

const cache = new WeakMap<object, number[]>();
/** Start times of every bar from real, trusted beats (the steady or variable grid with the downbeat phase applied), or
    null when the track has no such beats (old analysis, weak or no pulse). Not a bpm extrapolation. */
export function barStarts(track: Track): number[] | null {
  const r = track.rhythm;
  if (!r || (r.grid !== "steady" && r.grid !== "variable") || r.beats.length < 16) return null;
  let bars = cache.get(r);
  if (!bars) {
    bars = [];
    for (let i = r.downbeat.phase; i < r.beats.length; i += 4) bars.push(r.beats[i]);
    cache.set(r, bars);
  }
  return bars;
}

/** Times of every tracked beat, or null on the same terms as barStarts (a steady or variable grid with enough beats). */
export function beatTimes(track: Track): number[] | null {
  const r = track.rhythm;
  return r && (r.grid === "steady" || r.grid === "variable") && r.beats.length >= 16 ? r.beats : null;
}

/** The index of the last bar start at or before `t` (-1 before the first), by binary search. */
export function barIndexAt(bars: number[], t: number): number {
  let lo = 0, hi = bars.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid] <= t + 1e-6) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/** Median bar length of the real bars, seconds, or null without them. */
export function medianBar(track: Track): number | null {
  const bars = barStarts(track);
  if (!bars || bars.length < 3) return null;
  const gaps = bars.slice(1).map((b, i) => b - bars[i]).sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}
