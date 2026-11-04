import { RHYTHM_VERSION, type GridKind, type Rhythm } from "@/lib/analysis-types";
import { FAST_HOP, type Features } from "@/lib/features";

/* Beat tracking, tempo confidence and downbeats, from the onset envelopes of lib/features.ts.
   - Beats: dynamic programming over the onset envelope (Ellis 2007): the path that lands on the most onset while
     keeping each interval near the local beat period. Pass one assumes the seed tempo; if the beats drift from it
     (a live band, a ramp) pass two follows the local period, so beats are individual positions, not a bpm grid.
   - Confidence: how much stronger the envelope is on the beats than half a beat away from them, and the share of
     beats that land on a real onset. Noise, a held tone or silence score near 0, and then no beats are returned.
   - Downbeats: four phases scored by cues (kick, bass level, harmony change, loudness step), with confidence from how
     consistently each stretch of the track picks the same phase. Assumes 4/4; with no cue the phase is flagged assumed. */

/** Seconds from the start of a fast frame to the onset that its rise stands for: a 512-sample Hann window sees an
    attack in its tail, ~85% of the way along. Measured on kick, snare and hat trains in rhythm.test.ts. */
const LATENCY = 0.0395;
const MIN_SECONDS = 8;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

/** Tempo seed from the envelope's autocorrelation, for a track the legacy analysis found no tempo in. */
function seedTempo(env: Float32Array, fps: number) {
  const n = env.length;
  const ac = (lag: number) => { const l = Math.round(lag); let s = 0; for (let t = 0; t + l < n; t += 1) s += env[t] * env[t + l]; return s / Math.max(1, n - l); };
  let best = 120, top = -1;
  for (let b = 70; b <= 180; b += 1) {
    const lag = fps * 60 / b;
    let s = 0;
    for (let k = 1; k <= 3; k++) s += ac(lag * k) / k;
    s *= Math.exp(-0.5 * Math.pow(Math.log2(b / 122) / 0.6, 2));
    if (s > top) { top = s; best = b; }
  }
  return best;
}

/** The best path of beat frames. `period(t)` is the beat period in frames at frame t. */
function dpBeats(env: Float32Array, period: (t: number) => number, lambda: number): number[] {
  const n = env.length;
  const score = new Float64Array(n), prev = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    const p = period(t), lo = Math.max(1, Math.round(p * 0.55)), hi = Math.round(p * 1.8);
    let best = 0, from = -1;
    for (let tau = lo; tau <= hi && t - tau >= 0; tau++) {
      const r = Math.log(tau / p);
      const cand = score[t - tau] - lambda * r * r;
      if (cand > best) { best = cand; from = t - tau; }
    }
    score[t] = env[t] + best; prev[t] = from;
  }
  const tail = Math.round(period(n - 1) * 1.8);
  let end = n - 1;
  for (let t = Math.max(0, n - tail); t < n; t++) if (score[t] > score[end]) end = t;
  const beats: number[] = [];
  for (let t = end; t >= 0; t = prev[t]) { beats.push(t); if (prev[t] < 0) break; }
  return beats.reverse();
}

/**
 * A steady track has one beat grid. Beat tracking can lock a stretch half a beat away (a hi-hat-only intro puts the
 * "beat" on the off-beat, then the kick arrives and the path jumps). When most beats agree on one phase and a line
 * through them fits within a few percent of a beat, every beat is re-placed on that line, snapped to the nearest
 * onset. Otherwise (a live band, a ramp) null: the tracked positions are left alone.
 */
function unifyPhase(frames: number[], env: Float32Array, half: number, ref: number): number[] | null {
  if (frames.length < 16) return null;
  // The period from eight-beat spans, so a fraction of a frame per beat does not smear the phases.
  const p = median(frames.slice(8).map((b, i) => (b - frames[i]) / 8));
  const BINS = 12;
  const weight = new Float64Array(BINS);
  for (const t of frames) {
    const phase = ((t % p) + p) % p;
    weight[Math.min(BINS - 1, Math.floor(phase / p * BINS))] += Math.min(env[t], 4 * ref);
  }
  let bestBin = 0, bestSum = -1;
  for (let b = 0; b < BINS; b++) {
    const sum = weight[(b + BINS - 1) % BINS] + weight[b] + weight[(b + 1) % BINS];
    if (sum > bestSum) { bestSum = sum; bestBin = b; }
  }
  const centre = (bestBin + 0.5) / BINS * p;
  const circ = (t: number) => { const d = ((((t - centre) % p) + p) % p); return d > p / 2 ? d - p : d; };
  const inliers = frames.filter(t => Math.abs(circ(t)) <= 0.2 * p);
  if (inliers.length < 0.6 * frames.length) return null;
  // Least squares through the inliers: t = a + p * k, k counted from the first inlier.
  const first = inliers[0];
  const ks = inliers.map(t => Math.round((t - first) / p));
  const n = ks.length, mk = ks.reduce((x, y) => x + y, 0) / n, mt = inliers.reduce((x, y) => x + y, 0) / n;
  let skk = 0, skt = 0;
  for (let i = 0; i < n; i++) { skk += (ks[i] - mk) ** 2; skt += (ks[i] - mk) * (inliers[i] - mt); }
  if (skk === 0) return null;
  const period = skt / skk, a = mt - period * mk;
  const resid = Math.sqrt(inliers.reduce((s, t, i) => s + (t - a - period * ks[i]) ** 2, 0) / n);
  if (resid > 0.045 * period) return null;
  // A tempo that steps or ramps fits a line on average; its halves do not agree.
  const slope = (ts: number[], kk: number[]) => {
    const m = kk.length, mk2 = kk.reduce((x, y) => x + y, 0) / m, mt2 = ts.reduce((x, y) => x + y, 0) / m;
    let a2 = 0, b2 = 0;
    for (let i = 0; i < m; i++) { a2 += (kk[i] - mk2) ** 2; b2 += (kk[i] - mk2) * (ts[i] - mt2); }
    return a2 > 0 ? b2 / a2 : period;
  };
  const mid = Math.floor(n / 2);
  if (n >= 16 && Math.abs(slope(inliers.slice(0, mid), ks.slice(0, mid)) - slope(inliers.slice(mid), ks.slice(mid))) > 0.015 * period) return null;
  const lo = frames[0] - period / 2, hi = frames[frames.length - 1] + period / 2;
  const out: number[] = [];
  for (let k = Math.ceil((lo - a) / period); a + period * k <= hi; k++) {
    const t = Math.round(a + period * k);
    if (t < 1 || t >= env.length - 1) continue;
    let best = t;
    for (let i = Math.max(1, t - half); i <= Math.min(env.length - 2, t + half); i++) if (env[i] > env[best]) best = i;
    out.push(env[best] >= 0.5 * ref ? best : t);
  }
  return out.length >= 6 ? out : null;
}

/**
 * A tempo that moves has no single grid to pull stray beats onto, but it has a stretch where the kick is clear. Beats
 * before and after that stretch that sit away from where its tempo carries on to (a hi-hat intro tracked on the
 * off-beat) are moved onto the extrapolated beat, snapped to a nearby onset when there is one.
 */
function reanchor(frames: number[], env: Float32Array, f: Features, half: number, ref: number): number[] {
  const n = frames.length;
  if (n < 24) return frames;
  // A kick is a loud, tonal low-band event; a hi-hat or clap barely lifts the bands under 210 Hz. So a beat counts as
  // solid when the low bands near it stand 12 dB above their usual level.
  const low = new Float32Array(f.level.length);
  for (let t = 0; t < low.length; t++) { let m = 0; for (let b = 0; b < f.lowBands; b++) m += f.bands[t * f.bandCount + b]; low[t] = m / f.lowBands; }
  const usual = [...low].sort((x, y) => x - y)[Math.floor(low.length * 0.5)];
  const ok = frames.map(t => {
    let top = -Infinity;
    for (let i = Math.max(0, t - half); i <= Math.min(low.length - 1, t + 2 * half); i++) top = Math.max(top, low[i]);
    return top - usual >= 12;
  });
  const solid = (from: number) => { let c = 0; for (let i = from; i < from + 8; i++) if (ok[i]) c++; return c >= 7; };
  let a = -1, z = -1;
  for (let i = 0; i + 8 <= n; i++) if (ok[i] && solid(i)) { a = i; break; }
  for (let i = n - 8; i >= 0; i--) if (ok[i + 7] && solid(i)) { z = i + 7; break; }
  if (a < 0 || z < a) return frames;
  const out = frames.slice();
  const fix = (j: number, from: number, dir: 1 | -1) => {
    const gaps: number[] = [];
    // The reference beats lie behind `from` as seen in the direction of travel.
    for (let k = 0; k < 8 && out[from - dir * (k + 1)] !== undefined; k++) gaps.push(Math.abs(out[from - dir * k] - out[from - dir * (k + 1)]));
    const period = median(gaps);
    const predicted = out[from] + dir * period;
    if (Math.abs(frames[j] - predicted) <= 0.08 * period) return frames[j];
    let best = Math.round(predicted);
    const limit = Math.round(0.15 * period);
    for (let t = Math.max(1, Math.round(predicted) - limit); t <= Math.min(env.length - 2, Math.round(predicted) + limit); t++) if (env[t] > env[best] && env[t] >= 0.5 * ref) best = t;
    return best;
  };
  for (let j = a - 1; j >= 0; j--) out[j] = fix(j, j + 1, -1);
  for (let j = z + 1; j < n; j++) out[j] = fix(j, j - 1, 1);
  return out.filter(t => t >= 1);
}

/** Beat period (frames) at each beat from the median of the surrounding intervals, spread to every frame. */
function localPeriod(beats: number[], n: number, fallback: number) {
  const out = new Float32Array(n).fill(fallback);
  if (beats.length < 6) return out;
  const gaps = beats.slice(1).map((b, i) => b - beats[i]);
  const local = gaps.map((_, i) => median(gaps.slice(Math.max(0, i - 4), i + 5)));
  for (let i = 0; i < gaps.length; i++) {
    const end = i === gaps.length - 1 ? n : beats[i + 1];
    for (let t = i === 0 ? 0 : beats[i]; t < end; t++) out[t] = local[i];
  }
  return out;
}

function peakAround(env: Float32Array, t: number, half: number) {
  let top = 0;
  for (let i = Math.max(0, t - half); i <= Math.min(env.length - 1, t + half); i++) if (env[i] > top) top = env[i];
  return top;
}
function refine(env: Float32Array, t: number) {
  const a = env[t - 1] ?? env[t], b = env[t], c = env[t + 1] ?? env[t];
  const d = a - 2 * b + c;
  return t + (d < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / d)) : 0);
}

/** Beats may stray this far (a fraction of a beat, 9-beat median) from the line of one constant tempo before the track
    counts as having a tempo that moves. Measured on real recordings: a programmed 128 bpm track strays 0.02 of a beat and
    a produced pop track 0.11, where a tempo ramp or a live band strays by whole beats. */
const STEADY_WANDER = 0.15;

/**
 * How far the beats stray from the straight line of a constant tempo, as a fraction of a beat. This is what a constant
 * stretch and a bar grid depend on: a track that stays on its line can be matched at one rate however long it runs.
 * The local tempo's swing (the old drift reading) is not that: frames are 11.6 ms, a few percent of a beat, so a rock
 * steady track reads several percent of drift from the tracker's own quantization. The line is fitted through the
 * median, so a few misplaced beats do not move it, and each residual is smoothed over 9 beats before it counts.
 */
function wanderOf(times: number[]) {
  if (times.length < 16) return 0;
  const period = median(times.slice(8).map((t, i) => (t - times[i]) / 8));
  const offset = median(times.map((t, i) => t - i * period));
  const residual = times.map((t, i) => t - offset - i * period);
  let worst = 0;
  for (let i = 0; i < residual.length; i++) worst = Math.max(worst, Math.abs(median(residual.slice(Math.max(0, i - 4), i + 5))));
  return worst / period;
}

const NO_BEATS = (grid: GridKind = "none"): Rhythm => ({
  version: RHYTHM_VERSION, beats: [], strength: [], bpm: null, beatConfidence: 0, grid,
  tempo: { confidence: 0, drift: 0, wander: 0, octaveAmbiguous: false }, downbeat: { phase: 0, confidence: 0, assumed: true },
});

export type RhythmHint = { bpm: number | null };

export function analyzeRhythm(f: Features, hint: RhythmHint, duration: number): Rhythm {
  const n = f.onset.length, fps = f.fps;
  if (duration < MIN_SECONDS || n < fps * MIN_SECONDS) return NO_BEATS();
  // Full-band flux plus the low bands again, as a DJ hears it: a kick says more about the beat than a hi-hat does.
  const raw = new Float32Array(n);
  let sum = 0, sq = 0;
  for (let t = 0; t < n; t++) { raw[t] = f.onset[t] + 1.5 * f.lowOnset[t]; sum += raw[t]; sq += raw[t] * raw[t]; }
  const mean = sum / n, std = Math.sqrt(Math.max(0, sq / n - mean * mean));
  if (std < 1e-4) return NO_BEATS(); // nothing ever changes: silence or a held tone
  const env = new Float32Array(n);
  for (let t = 0; t < n; t++) env[t] = raw[t] / std;

  const seed = hint.bpm ?? seedTempo(env, fps);
  const seedPeriod = fps * 60 / seed;
  const half = Math.round(fps * 0.035);
  const ref = (() => { const s = Array.from(env).sort((a, b) => a - b); return Math.max(1e-6, s[Math.floor(s.length * 0.95)]); })();
  let frames = dpBeats(env, () => seedPeriod, 80);
  const steady = unifyPhase(frames, env, half, ref);
  if (steady) frames = steady;
  // Where the first pass wandered from the seed, follow the local period instead.
  else if (frames.length >= 8) {
    const gaps = frames.slice(1).map((b, i) => b - frames[i]);
    const local = gaps.map((_, i) => median(gaps.slice(Math.max(0, i - 4), i + 5)));
    const spread = (Math.max(...local) - Math.min(...local)) / median(local);
    if (spread > 0.03) {
      const period = localPeriod(frames, n, seedPeriod);
      frames = dpBeats(env, t => period[t], 80);
    }
    frames = reanchor(frames, env, f, half, ref);
  }
  if (frames.length < 6) return NO_BEATS();

  // Support: the strongest onset within 35 ms of each beat, and half a beat away.
  // Beats in the silence before the music or after it (a tail, a gap between tracks) are not beats.
  const sortedLevel = Array.from(f.level).sort((a, b) => a - b), floor = sortedLevel[Math.floor(sortedLevel.length * 0.95)] - 45;
  const audible = (t: number) => f.level[Math.min(f.level.length - 1, Math.max(0, t))] > floor;
  while (frames.length > 6 && !audible(frames[frames.length - 1])) frames.pop();
  while (frames.length > 6 && !audible(frames[0])) frames.shift();

  const support = frames.map(t => peakAround(env, t, half));
  // The null: the same measure with the beats shifted by 1/8 .. 7/8 of a beat. Music with hats or arpeggios on the
  // off-beat still has its beats stand out from this average; noise and a held tone do not.
  const shifted = [1, 2, 3, 4, 5, 6, 7].map(k => {
    let s = 0, c = 0;
    for (let i = 0; i + 1 < frames.length; i++) { s += peakAround(env, Math.round(frames[i] + (frames[i + 1] - frames[i]) * k / 8), half); c++; }
    return s / Math.max(1, c);
  });
  const meanSupport = support.reduce((a, b) => a + b, 0) / support.length;
  const meanOff = shifted.reduce((a, b) => a + b, 0) / shifted.length;
  const contrast = meanSupport / Math.max(1e-6, meanOff);
  const real = (i: number) => support[i] >= 0.6 * ref;
  const share = (parity: number | null) => {
    const idx = support.map((_, i) => i).filter(i => parity === null || i % 2 === parity);
    return idx.filter(real).length / Math.max(1, idx.length);
  };
  // A pulse every other beat (half-time kicks) is still a pulse.
  const supported = Math.max(share(null), share(0), share(1));
  const beatConfidence = Math.round(Math.sqrt(clamp01((contrast - 1.3) / 2.7) * clamp01((supported - 0.3) / 0.5)) * 1000) / 1000;

  const times = frames.map(t => (refine(env, t) * FAST_HOP) / f.rate + LATENCY);
  const strength = support.map(s => Math.round(clamp01(s / ref) * 100) / 100);

  const gaps = times.slice(1).map((b, i) => b - times[i]);
  const localGap = gaps.map((_, i) => median(gaps.slice(Math.max(0, i - 4), i + 5)));
  const core = localGap.slice(4, Math.max(5, localGap.length - 4));
  const drift = core.length > 2 ? (Math.max(...core) - Math.min(...core)) / median(core) : 0;

  const wander = wanderOf(times), constant = wander <= STEADY_WANDER;
  // A steady track's tempo is its whole span over its beats (precise to far better than a frame); a moving one reports the median.
  const bpm = Math.round((constant ? 60 * (times.length - 1) / (times[times.length - 1] - times[0]) : 60 / median(gaps)) * 100) / 100;

  // Does half or double time fit about as well? Compare onset support on every second beat and on the midpoints.
  const octaveAmbiguous = share(0) > 0.8 && share(1) < 0.3 || share(1) > 0.8 && share(0) < 0.3;

  // Tempo confidence: the beat confidence, halved or worse when the independent legacy estimate disagrees.
  let agree = 0.7;
  if (hint.bpm) {
    const folded = [0.5, 1, 2].map(m => Math.abs(bpm * m - hint.bpm!) / hint.bpm!);
    const miss = Math.min(...folded);
    agree = miss <= 0.015 ? 1 : miss <= 0.04 ? 0.6 : 0.3;
  }
  const tempoConfidence = Math.round(beatConfidence * agree * 1000) / 1000;

  const grid: GridKind = beatConfidence < 0.2 ? "none" : beatConfidence < 0.45 ? "weak" : !constant ? "variable" : "steady";
  if (grid === "none") return { ...NO_BEATS(), beatConfidence };
  const rounded = times.map(t => Math.round(t * 1000) / 1000);
  return {
    version: RHYTHM_VERSION, beats: rounded, strength, bpm, beatConfidence, grid,
    tempo: { confidence: tempoConfidence, drift: Math.round(drift * 1000) / 1000, wander: Math.round(wander * 1000) / 1000, octaveAmbiguous },
    downbeat: downbeats(f, rounded),
  };
}

/** Which of four beat phases starts a bar. */
export function downbeats(f: Features, beats: number[]): Rhythm["downbeat"] {
  const nb = beats.length;
  if (nb < 16) return { phase: 0, confidence: 0, assumed: true };
  const fps = f.fps;
  const frameOf = (t: number) => Math.max(0, Math.min(f.level.length - 1, Math.round(t * fps)));
  const beat = (i: number) => beats[Math.min(nb - 1, Math.max(0, i))];
  const gap = median(beats.slice(1).map((b, i) => b - beats[i]));

  const cumLevel = new Float64Array(f.level.length + 1);
  for (let t = 0; t < f.level.length; t++) cumLevel[t + 1] = cumLevel[t] + f.level[t];
  const meanLevel = (a: number, b: number) => { const x = frameOf(a), y = Math.max(x + 1, frameOf(b)); return (cumLevel[Math.min(y, f.level.length)] - cumLevel[x]) / Math.max(1, Math.min(y, f.level.length) - x); };
  const cumLow = new Float64Array(f.level.length + 1);
  for (let t = 0; t < f.level.length; t++) {
    let s = 0;
    for (let b = 0; b < f.lowBands; b++) s += f.bands[t * f.bandCount + b];
    cumLow[t + 1] = cumLow[t] + s / f.lowBands;
  }
  const meanLow = (a: number, b: number) => { const x = frameOf(a), y = Math.max(x + 1, frameOf(b)); return (cumLow[Math.min(y, f.level.length)] - cumLow[x]) / Math.max(1, Math.min(y, f.level.length) - x); };
  const chromaAt = (a: number, b: number) => {
    const slow = f.chroma.length / 12, x = Math.max(0, Math.min(slow - 1, Math.floor(a * f.chromaFps))), y = Math.max(x + 1, Math.min(slow, Math.ceil(b * f.chromaFps)));
    const v = new Float64Array(12);
    for (let i = x; i < y; i++) for (let c = 0; c < 12; c++) v[c] += f.chroma[i * 12 + c];
    return v;
  };
  const cos = (a: Float64Array, b: Float64Array) => {
    let ab = 0, aa = 0, bb = 0;
    for (let c = 0; c < 12; c++) { ab += a[c] * b[c]; aa += a[c] * a[c]; bb += b[c] * b[c]; }
    return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 1;
  };

  const kick = new Float64Array(nb), bass = new Float64Array(nb), harmony = new Float64Array(nb), step = new Float64Array(nb);
  for (let i = 0; i < nb; i++) {
    const t = beats[i], c = frameOf(t - LATENCY);
    kick[i] = peakAround(f.lowOnset, c, Math.round(fps * 0.035));
    bass[i] = meanLow(t, t + gap);
    harmony[i] = 1 - cos(chromaAt(beat(i - 2), beat(i)), chromaAt(beat(i), beat(i + 2)));
    step[i] = Math.abs(meanLevel(beat(i), beat(i + 4)) - meanLevel(beat(i - 4), beat(i)));
  }
  const z = (v: Float64Array) => {
    const m = v.reduce((a, b) => a + b, 0) / nb, sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / nb);
    return Array.from(v, x => sd > 1e-9 ? (x - m) / sd : 0);
  };
  const cues = [{ v: z(kick), w: 1 }, { v: z(bass), w: 0.7 }, { v: z(harmony), w: 1 }, { v: z(step), w: 1.2 }];
  const combined = Array.from({ length: nb }, (_, i) => cues.reduce((s, c) => s + c.w * c.v[i], 0));
  const phaseScore = (from: number, to: number) => {
    const s = [0, 0, 0, 0], c = [0, 0, 0, 0];
    for (let i = from; i < to; i++) { s[i % 4] += combined[i]; c[i % 4]++; }
    return s.map((v, p) => v / Math.max(1, c[p]));
  };
  const overall = phaseScore(0, nb), order = [0, 1, 2, 3].sort((a, b) => overall[b] - overall[a]);
  const margin = overall[order[0]] - overall[order[1]];
  if (margin < 1e-6) return { phase: 0, confidence: 0, assumed: true };
  // Consistency: every 4-bar stretch votes for its own best phase. Chance is 1 in 4.
  const WINDOW = 16;
  let votes = 0, agree = 0;
  for (let a = 0; a + WINDOW <= nb; a += WINDOW) {
    const s = phaseScore(a, a + WINDOW);
    votes++;
    if (s.indexOf(Math.max(...s)) === order[0]) agree++;
  }
  const consistency = votes ? clamp01((agree / votes - 0.25) / 0.75) : 0;
  const cueMargin = clamp01(margin / 0.8);
  const confidence = Math.round(consistency * cueMargin * 1000) / 1000;
  return { phase: order[0], confidence, assumed: confidence < 0.3 };
}
