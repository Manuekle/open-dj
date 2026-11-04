import { fft } from "@/lib/fft";
import { RHYTHM_VERSION, STRUCTURE_VERSION, type Rhythm, type Structure } from "@/lib/analysis-types";
import { extractFeatures } from "@/lib/features";
import { analyzeRhythm } from "@/lib/rhythm";
import { analyzeStructure } from "@/lib/structure";

export { RHYTHM_VERSION, STRUCTURE_VERSION };

/* The analysis itself: plain math over decoded samples, with no DOM or Web Audio, so it runs the same in the analysis
   worker (lib/analysis.worker.ts), on the page when there is no worker, and in the tests. */

/** Bump when the tempo, key, loudness or band analysis changes, so stored tracks are analyzed again. The rhythm and
    structure results carry their own versions (analysis-types.ts) and are re-derived on their own. */
export const ANALYSIS_VERSION = 5;

export type Analysis = {
  duration: number;
  peaks: number[];
  bpm: number | null;
  /** How far the beat grid stands out: the best phase's onset sum over the mean of every phase at that tempo. A steady
      beat reads well above 1; a held tone or noise reads near 1, and then bpm is null. */
  pulse: number;
  /** Seconds to the first beat of the grid (the grid's phase). */
  firstBeat: number;
  /** Median loudness in dBFS, over one-second windows with sound in them. */
  loudness: number;
  /** Loudness per second, dBFS, rounded to 0.1. */
  energy: number[];
  /** Musical key ("Am", "F#") and its Camelot code ("8A"), from a chromagram against the Krumhansl-Kessler profiles. */
  key: string;
  camelot: string;
  /** How far the best key beats the runner-up, 0..1. Below about 0.05 the key is a guess. */
  keyClarity: number;
  /** Integrated loudness, LUFS (ITU-R BS.1770 / EBU R128 gating), estimated from the mono analysis copy. */
  lufs: number;
  /** Power per second in the three DJ-mixer bands, dB: low 20-250 Hz, mid 250-2500 Hz, high 2.5-5.5 kHz. */
  bands: Bands;
  analysis: number;
  /** Individual beats, downbeats and tempo confidence. */
  rhythm: Rhythm;
  /** Sections, boundaries and phrase lengths. */
  structure: Structure;
};
export type Bands = { low: number[]; mid: number[]; high: number[] };

/** Rate the analysis copy of a track is decoded to, Hz. */
export const RATE = 11025;
/** Pulse below which no tempo is given. Mixed dance and pop tracks read 5 to 10, kick drums alone 20 and up, held tones
    and white noise 1.7 to 2.6. */
const MIN_PULSE = 3;
const HOP = 128;

/** The analysis of mono samples at RATE, the copy analyzeFile decodes a file to. */
export function analyzeSamples(x: Float32Array): Analysis {
  const duration = x.length / RATE;

  const bins = 160;
  const peaks: number[] = [];
  const stride = Math.max(1, Math.floor(x.length / bins));
  for (let i = 0; i < bins; i++) {
    let peak = 0;
    for (let j = i * stride; j < Math.min(x.length, (i + 1) * stride); j += 8) peak = Math.max(peak, Math.abs(x[j] || 0));
    peaks.push(Math.max(0.065, Math.min(1, Math.pow(peak, 0.68))));
  }

  // Frame energy, full band and below ~150 Hz, where the kick lives.
  const frames = Math.floor(x.length / HOP);
  const fps = RATE / HOP;
  const pole = Math.exp(-2 * Math.PI * 150 / RATE);
  const full = new Float32Array(frames), low = new Float32Array(frames);
  let lp = 0;
  for (let f = 0; f < frames; f++) {
    let s = 0, l = 0;
    for (let i = f * HOP; i < (f + 1) * HOP; i++) { const v = x[i]; s += v * v; lp = pole * lp + (1 - pole) * v; l += lp * lp; }
    full[f] = s / HOP; low[f] = l / HOP;
  }

  // Onset strength: rises in log energy, the low band weighted up, minus a half-second running mean.
  const onset = new Float32Array(frames);
  const window = Math.round(fps * 0.5);
  for (let f = 1; f < frames; f++) {
    onset[f] = Math.max(0, Math.log(1e-9 + full[f]) - Math.log(1e-9 + full[f - 1])) + 1.5 * Math.max(0, Math.log(1e-9 + low[f]) - Math.log(1e-9 + low[f - 1]));
  }
  const mean = new Float32Array(frames);
  let acc = 0;
  for (let f = 0; f < frames; f++) { acc += onset[f]; if (f >= window) acc -= onset[f - window]; mean[f] = acc / Math.min(f + 1, window); }
  for (let f = 0; f < frames; f++) onset[f] = Math.max(0, onset[f] - mean[f]);
  const at = (t: number) => { const i = Math.floor(t), u = t - i; return (onset[i] || 0) * (1 - u) + (onset[i + 1] || 0) * u; };

  let bpm: number | null = null;
  let firstBeat = 0, pulse = 0;
  if (duration >= 10) {
    // Coarse tempo: autocorrelation summed over the first four beat multiples, with a prior around 122 bpm.
    const ac = (lag: number) => { let s = 0; for (let f = Math.ceil(lag); f < frames; f++) s += onset[f] * at(f - lag); return s / (frames - lag); };
    let coarse = 120, best = -1;
    for (let b = 70; b <= 180; b += 0.5) {
      const lag = fps * 60 / b;
      let s = 0;
      for (let k = 1; k <= 4; k++) s += ac(lag * k) / k;
      s *= Math.exp(-0.5 * Math.pow(Math.log2(b / 122) / 0.6, 2));
      if (s > best) { best = s; coarse = b; }
    }
    // Fine tempo and phase: the beat grid that lands on the most onsets across the whole track.
    const comb = (b: number): [number, number, number] => {
      const period = fps * 60 / b;
      let top = -1, offset = 0, sum = 0, count = 0;
      for (let o = 0; o < period; o += 0.25) {
        let s = 0;
        for (let t = o; t < frames - 1; t += period) s += at(t);
        sum += s; count++;
        if (s > top) { top = s; offset = o; }
      }
      return [top, offset, sum / count];
    };
    let top = -1, mean = 1;
    for (let b = coarse - 2; b <= coarse + 2; b += 0.02) {
      const [s, o, m] = comb(b);
      if (s > top) { top = s; mean = m; bpm = b; firstBeat = o / fps; }
    }
    pulse = mean > 0 ? top / mean : 0;
    // Without a pulse (silence, a held tone, noise) there is no beat to find, and none is made up.
    if (pulse < MIN_PULSE) { bpm = null; firstBeat = 0; }
    bpm = bpm === null ? null : Math.round(bpm * 100) / 100;
  }

  const energy: number[] = [];
  for (let s = 0; s < Math.floor(duration); s++) {
    let e = 0, c = 0;
    for (let f = Math.floor(s * fps); f < Math.min(frames, Math.floor((s + 1) * fps)); f++) { e += full[f]; c++; }
    energy.push(Math.round(10 * Math.log10(1e-12 + e / Math.max(1, c)) * 10) / 10);
  }
  const audible = energy.filter(d => d > -50).sort((a, b) => a - b);
  const loudness = audible.length ? audible[Math.floor(audible.length / 2)] : -60;

  const { rhythm, structure } = analyzeFeatures(x, { bpm });
  // The beat tracker is a second, independent reading of the same audio: where it finds no beat at all, a borderline
  // legacy pulse is a false positive, and no tempo (so no beat grid) is better than a made-up one.
  const vetoed = bpm !== null && vetoTempo(pulse, rhythm);
  if (vetoed) { bpm = null; firstBeat = 0; }

  return { duration, peaks, bpm, pulse: Math.round(pulse * 100) / 100, firstBeat: Math.round(firstBeat * 1000) / 1000, loudness, energy,
    ...spectrum(x, Math.floor(duration)), lufs: integratedLufs(x), analysis: ANALYSIS_VERSION, rhythm, structure };
}

/** Pulse under which the beat tracker's verdict can overrule the legacy estimate: no beats found at all (grid "none")
    under PULSE_NO_BEATS, or only a weak, unplaceable pulse under PULSE_WEAK. Mixed dance and pop read 5 to 10 and keep
    their tempo whatever the tracker says. */
const PULSE_NO_BEATS = 5, PULSE_WEAK = 3.5;
export function vetoTempo(pulse: number, rhythm: Pick<Rhythm, "grid">): boolean {
  return (rhythm.grid === "none" && pulse < PULSE_NO_BEATS) || (rhythm.grid === "weak" && pulse < PULSE_WEAK);
}

/** Beats, downbeats, sections and phrases of mono samples at RATE. `bpm` is the legacy tempo estimate, which seeds the
    beat tracker and is checked against it; null lets the tracker find its own. */
export function analyzeFeatures(x: Float32Array, hint: { bpm: number | null }): { rhythm: Rhythm; structure: Structure } {
  const features = extractFeatures(x, RATE);
  const rhythm = analyzeRhythm(features, hint, x.length / RATE);
  return { rhythm, structure: analyzeStructure(features, rhythm, x.length / RATE) };
}

/** What a stored track still needs: the whole analysis (an old tempo/key/loudness version), only the rhythm and
    structure (they are newer than the track's analysis), or nothing. */
export function staleness(track: { analysis?: number; analysisFailed?: number; rhythm?: { version: number }; structure?: { version: number } }): "all" | "features" | null {
  // A file that could not be decoded for this version of the analysis fails the same way again: it is not retried at every start.
  if ((track.analysisFailed ?? 0) >= ANALYSIS_VERSION) return null;
  if ((track.analysis ?? 0) < ANALYSIS_VERSION) return "all";
  if ((track.rhythm?.version ?? 0) < RHYTHM_VERSION || (track.structure?.version ?? 0) < STRUCTURE_VERSION) return "features";
  return null;
}

const NOTES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
// Krumhansl-Kessler key profiles, tonic first.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
/** Camelot wheel code for a tonic pitch class: majors are B, minors A, and each step round the wheel is a fifth. */
export function camelotOf(tonic: number, minor: boolean) {
  const major = minor ? (tonic + 3) % 12 : tonic;
  return `${(major * 7 + 7) % 12 + 1}${minor ? "A" : "B"}`;
}
function pearson(a: number[], b: number[]) {
  const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length;
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return n / Math.sqrt(da * db || 1);
}

/** Key and per-second band power, from 4096-point spectra every half second. */
function spectrum(x: Float32Array, seconds: number) {
  const N = 4096, hop = Math.round(RATE / 2);
  const window = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
  const re = new Float32Array(N), im = new Float32Array(N);
  const chroma = new Array<number>(12).fill(0);
  const sums = { low: new Float64Array(seconds), mid: new Float64Array(seconds), high: new Float64Array(seconds) };
  const counts = new Uint16Array(seconds);
  // Each bin's pitch class (or -1 outside 65 Hz..2.1 kHz) and band, worked out once.
  const pc = new Int8Array(N / 2), band = new Int8Array(N / 2);
  for (let k = 1; k < N / 2; k++) {
    const f = k * RATE / N;
    pc[k] = f >= 65 && f <= 2100 ? ((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12 : -1;
    band[k] = f < 20 ? -1 : f < 250 ? 0 : f < 2500 ? 1 : 2;
  }
  for (let start = 0; start + N <= x.length; start += hop) {
    let level = 0;
    for (let i = 0; i < N; i++) { re[i] = x[start + i] * window[i]; im[i] = 0; level += re[i] * re[i]; }
    if (level < 1e-6) continue;
    fft(re, im);
    const second = Math.floor((start + N / 2) / RATE);
    const frame = [0, 0, 0];
    for (let k = 1; k < N / 2; k++) {
      const power = re[k] * re[k] + im[k] * im[k];
      if (pc[k] >= 0) chroma[pc[k]] += Math.sqrt(power);
      if (band[k] >= 0) frame[band[k]] += power;
    }
    if (second < seconds) { sums.low[second] += frame[0]; sums.mid[second] += frame[1]; sums.high[second] += frame[2]; counts[second]++; }
  }
  const db = (sum: Float64Array) => Array.from(sum, (v, i) => Math.round(10 * Math.log10(1e-12 + v / Math.max(1, counts[i]) / (N * N)) * 10) / 10);

  const scores: { tonic: number; minor: boolean; r: number }[] = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = chroma.map((_, i) => chroma[(i + tonic) % 12]);
    scores.push({ tonic, minor: false, r: pearson(rotated, MAJOR) }, { tonic, minor: true, r: pearson(rotated, MINOR) });
  }
  scores.sort((a, b) => b.r - a.r);
  const best = scores[0];
  return {
    key: NOTES[best.tonic] + (best.minor ? "m" : ""), camelot: camelotOf(best.tonic, best.minor),
    keyClarity: Math.round(Math.max(0, best.r - scores[1].r) * 1000) / 1000,
    bands: { low: db(sums.low), mid: db(sums.mid), high: db(sums.high) },
  };
}

/** A biquad from the RBJ cookbook, run over x. */
function biquad(x: Float32Array, b0: number, b1: number, b2: number, a0: number, a1: number, a2: number) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
/**
 * Integrated loudness by ITU-R BS.1770-4: K-weighting (the +4 dB shelf at 1.68 kHz and the 38 Hz high-pass, designed
 * for this sample rate), 400 ms blocks every 100 ms, the -70 LUFS absolute gate, then the gate 10 LU under the mean.
 * The analysis copy is mono at 11 kHz, so 3 dB is added for the two channels it stands for; the estimate sits within
 * about 1 LU of a full-band meter on mixed music.
 */
function integratedLufs(x: Float32Array) {
  const shelf = (() => {
    const A = 10 ** (3.999843853973347 / 40), w = 2 * Math.PI * 1681.974450955533 / RATE, cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * 0.7071752369554196), r = 2 * Math.sqrt(A) * alpha;
    return biquad(x, A * ((A + 1) + (A - 1) * cos + r), -2 * A * ((A - 1) + (A + 1) * cos), A * ((A + 1) + (A - 1) * cos - r),
      (A + 1) - (A - 1) * cos + r, 2 * ((A - 1) - (A + 1) * cos), (A + 1) - (A - 1) * cos - r);
  })();
  const w = 2 * Math.PI * 38.13547087602444 / RATE, cos = Math.cos(w), alpha = Math.sin(w) / (2 * 0.5003270373238773);
  const k = biquad(shelf, (1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
  const block = Math.round(RATE * 0.4), step = Math.round(RATE * 0.1);
  const z: number[] = [];
  for (let s = 0; s + block <= k.length; s += step) { let e = 0; for (let i = s; i < s + block; i++) e += k[i] * k[i]; z.push(e / block); }
  const lufs = (p: number) => -0.691 + 10 * Math.log10(p) + 3.01;
  const loud = z.filter(p => lufs(p) > -70);
  if (!loud.length) return -70;
  const gate = lufs(loud.reduce((s, p) => s + p, 0) / loud.length) - 10;
  const kept = loud.filter(p => lufs(p) > gate);
  return Math.round(lufs(kept.reduce((s, p) => s + p, 0) / kept.length) * 10) / 10;
}


/** Level per second of one stem, dB, from its stereo pair at RATE. */
export function stemLevel(left: Float32Array, right: Float32Array): number[] {
  return Array.from({ length: Math.floor(left.length / RATE) }, (_, s) => {
    let e = 0;
    for (let i = s * RATE; i < (s + 1) * RATE; i += 2) { const v = (left[i] + right[i]) / 2; e += v * v; }
    return Math.round(10 * Math.log10(1e-12 + e / (RATE / 2)) * 10) / 10;
  });
}

/** One job for the analysis worker: a track's mono samples, or one stem's stereo pair. */
export type AnalysisJob =
  | { kind: "track"; samples: Float32Array }
  | { kind: "features"; samples: Float32Array; bpm: number | null }
  | { kind: "stem"; left: Float32Array; right: Float32Array };
export type AnalysisRequest = AnalysisJob & { id: number };
export type AnalysisReply = { id: number; result?: Analysis | number[] | { rhythm: Rhythm; structure: Structure }; error?: string };
/** Runs one job; a failure comes back as the reply's error rather than a throw, so the worker always answers. */
export function answer(request: AnalysisRequest): AnalysisReply {
  try {
    const result = request.kind === "track" ? analyzeSamples(request.samples)
      : request.kind === "features" ? analyzeFeatures(request.samples, { bpm: request.bpm })
      : stemLevel(request.left, request.right);
    return { id: request.id, result };
  } catch (error) {
    return { id: request.id, error: error instanceof Error ? error.message : String(error) };
  }
}
