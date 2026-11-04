/* Metrics for the analysis tests: the standard beat-tracking score (an estimate within 70 ms of a reference beat, each
   reference matched once) and a few helpers. Used by the tests only. */

export function beatScore(estimated: number[], reference: number[], tolerance = 0.07) {
  const used = new Set<number>();
  let hits = 0, error = 0;
  for (const e of estimated) {
    let best = -1, bestD = tolerance;
    for (let i = 0; i < reference.length; i++) {
      if (used.has(i)) continue;
      const d = Math.abs(reference[i] - e);
      if (d <= bestD) { best = i; bestD = d; }
    }
    if (best >= 0) { used.add(best); hits++; error += bestD; }
  }
  const precision = estimated.length ? hits / estimated.length : 0, recall = reference.length ? hits / reference.length : 0;
  return { precision, recall, f: precision + recall ? 2 * precision * recall / (precision + recall) : 0, maeMs: hits ? error / hits * 1000 : NaN };
}

/** Whether a tempo is right as is, at half time or at double time (the usual "octave-tolerant" accuracy). */
export function tempoMatch(estimated: number | null, truth: number, tolerance = 0.02) {
  if (estimated === null) return { exact: false, octave: false };
  const err = (m: number) => Math.abs(estimated * m - truth) / truth;
  return { exact: err(1) <= tolerance, octave: [0.5, 1, 2].some(m => err(m) <= tolerance) };
}

/** Share of reference times with an estimate within `tolerance` seconds, and how many estimates matched nothing. */
export function boundaryScore(estimated: number[], reference: number[], tolerance: number) {
  const hit = reference.filter(r => estimated.some(e => Math.abs(e - r) <= tolerance)).length;
  const extra = estimated.filter(e => !reference.some(r => Math.abs(e - r) <= tolerance)).length;
  return { recall: reference.length ? hit / reference.length : 1, extra };
}
