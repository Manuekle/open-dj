import { fft } from "@/lib/fft";

/* The front end of the rhythm and structure analysis: two short-time spectra over the mono analysis copy, no DOM, so it
   runs in the worker and in the tests. A fast pass (512 points, 128 apart, 11.6 ms) gives log-spaced band levels and
   the onset envelopes the beat tracker reads; a slow pass (4096 points, 1024 apart) gives a chromagram for harmony.
   Memory is frames x bands floats (about 1.8 MB for a five-minute track), freed with the result. */

export const FAST_HOP = 128;
const FAST_N = 512, SLOW_N = 4096, SLOW_HOP = 1024;
const BAND_COUNT = 20;
/** Bands whose top edge is under this are the "low" group, where the kick and bass live. */
const LOW_EDGE_HZ = 210;

export type Features = {
  rate: number;
  /** Frames per second of the fast arrays. */
  fps: number;
  bandCount: number;
  /** How many of the first bands are the low group. */
  lowBands: number;
  /** Band power per fast frame, dB, frame-major (frame * bandCount + band). */
  bands: Float32Array;
  /** Total power per fast frame, dB. */
  level: Float32Array;
  /** Onset strength per fast frame: summed rises in band level, minus a half-second running mean, clipped at 0. */
  onset: Float32Array;
  /** The same over the low bands only. */
  lowOnset: Float32Array;
  /** Pitch-class energy per slow frame, normalized to sum 1 (all zeros in a silent frame), frame-major. */
  chroma: Float32Array;
  chromaFps: number;
};

/** First FFT bin of each band plus the end of the last: log-spaced from 40 Hz, each band at least one bin wide. */
function bandEdges(rate: number) {
  const df = rate / FAST_N, top = Math.min(FAST_N / 2 - 1, Math.floor(5200 / df));
  const edges = [Math.max(2, Math.round(40 / df))];
  const ratio = Math.pow(5200 / 40, 1 / BAND_COUNT);
  for (let b = 1; b <= BAND_COUNT; b++) {
    const wanted = Math.round(40 * Math.pow(ratio, b) / df);
    edges.push(Math.min(top + 1, Math.max(edges[edges.length - 1] + 1, wanted)));
    if (edges[edges.length - 1] > top) break;
  }
  return edges;
}

function runningMeanRemoved(raw: Float32Array, window: number) {
  const out = new Float32Array(raw.length);
  let acc = 0;
  for (let f = 0; f < raw.length; f++) {
    acc += raw[f];
    if (f >= window) acc -= raw[f - window];
    out[f] = Math.max(0, raw[f] - acc / Math.min(f + 1, window));
  }
  return out;
}

export function extractFeatures(x: Float32Array, rate: number): Features {
  const edges = bandEdges(rate), nb = edges.length - 1;
  const lowBands = Math.max(1, edges.slice(1).filter(e => e * rate / FAST_N <= LOW_EDGE_HZ).length);
  const frames = Math.max(0, Math.floor((x.length - FAST_N) / FAST_HOP) + 1);
  const fps = rate / FAST_HOP;
  const bands = new Float32Array(frames * nb), level = new Float32Array(frames);
  const flux = new Float32Array(frames), lowFlux = new Float32Array(frames);
  const window = Float32Array.from({ length: FAST_N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FAST_N - 1)));
  const re = new Float32Array(FAST_N), im = new Float32Array(FAST_N);
  const norm = 1 / ((FAST_N / 2) ** 2);
  const FLOOR_DB = -90;
  for (let f = 0; f < frames; f++) {
    const start = f * FAST_HOP;
    for (let i = 0; i < FAST_N; i++) { re[i] = x[start + i] * window[i]; im[i] = 0; }
    fft(re, im);
    let total = 0, rise = 0, lowRise = 0;
    for (let b = 0; b < nb; b++) {
      let p = 0;
      for (let k = edges[b]; k < edges[b + 1]; k++) p += re[k] * re[k] + im[k] * im[k];
      total += p;
      const db = Math.max(FLOOR_DB, 10 * Math.log10(p * norm + 1e-12));
      bands[f * nb + b] = db;
      if (f > 0) { const d = db - bands[(f - 1) * nb + b]; if (d > 0) { rise += d; if (b < lowBands) lowRise += d; } }
    }
    level[f] = Math.max(FLOOR_DB, 10 * Math.log10(total * norm + 1e-12));
    flux[f] = rise / nb / 10;
    lowFlux[f] = lowRise / lowBands / 10;
  }
  const mean = Math.round(fps * 0.5);
  const onset = runningMeanRemoved(flux, mean), lowOnset = runningMeanRemoved(lowFlux, mean);

  // Chroma, 65 Hz to 2.1 kHz, a frame every ~93 ms.
  const slowFrames = Math.max(0, Math.floor((x.length - SLOW_N) / SLOW_HOP) + 1);
  const chroma = new Float32Array(slowFrames * 12);
  const sre = new Float32Array(SLOW_N), sim = new Float32Array(SLOW_N);
  const slowWindow = Float32Array.from({ length: SLOW_N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (SLOW_N - 1)));
  const pitch = new Int8Array(SLOW_N / 2).fill(-1);
  for (let k = 1; k < SLOW_N / 2; k++) {
    const hz = k * rate / SLOW_N;
    if (hz >= 65 && hz <= 2100) pitch[k] = ((Math.round(69 + 12 * Math.log2(hz / 440)) % 12) + 12) % 12;
  }
  for (let f = 0; f < slowFrames; f++) {
    const start = f * SLOW_HOP;
    let energy = 0;
    for (let i = 0; i < SLOW_N; i++) { sre[i] = x[start + i] * slowWindow[i]; sim[i] = 0; energy += sre[i] * sre[i]; }
    if (energy < 1e-6) continue;
    fft(sre, sim);
    let sum = 0;
    for (let k = 1; k < SLOW_N / 2; k++) if (pitch[k] >= 0) { const m = Math.sqrt(sre[k] * sre[k] + sim[k] * sim[k]); chroma[f * 12 + pitch[k]] += m; sum += m; }
    if (sum > 0) for (let c = 0; c < 12; c++) chroma[f * 12 + c] /= sum;
  }
  return { rate, fps, bandCount: nb, lowBands, bands, level, onset, lowOnset, chroma, chromaFps: rate / SLOW_HOP };
}
