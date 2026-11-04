/* Offline pitch correction for a monophonic voice take.
   1. detectPitch: YIN on a 4x decimated copy gives a fundamental per 512-sample hop (0 where the voice is unvoiced).
   2. correctionCents: each voiced frame is pulled toward the nearest note of the chosen key and scale. "Speed" is the
      time constant of that pull: 0 snaps at once (the hard, robotic sound), a few hundred ms glides and keeps vibrato.
   3. retune: pitch-synchronous overlap-add. Two-period Hann grains of the input are laid down one shifted period apart,
      so the pitch moves and the length and the formants stay. Unvoiced stretches pass through untouched. */

export type Scale = "chromatic" | "major" | "minor" | "pentatonic";
export const SCALES: Record<Scale, number[]> = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 3, 5, 7, 10],
};
export const SCALE_LABELS: Record<Scale, string> = { chromatic: "Chromatic", major: "Major", minor: "Minor", pentatonic: "Minor pentatonic" };
export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export type TuneOptions = {
  /** Pitch class of the key, 0 = C. */
  key: number;
  scale: Scale;
  /** Retune speed, ms. 0 snaps at once. */
  speed: number;
  /** 0..1: how far toward the note the voice is pulled. */
  amount: number;
};

export const hzToMidi = (hz: number) => 69 + 12 * Math.log2(hz / 440);

/** The MIDI note of the scale nearest to `midi`. */
export function nearestInScale(midi: number, key: number, scale: Scale): number {
  const pcs = SCALES[scale];
  let best = Math.round(midi), bestDistance = Infinity;
  for (let n = Math.floor(midi) - 7; n <= Math.ceil(midi) + 7; n++) {
    if (!pcs.includes((((n - key) % 12) + 12) % 12)) continue;
    const d = Math.abs(n - midi);
    if (d < bestDistance) { best = n; bestDistance = d; }
  }
  return best;
}

export type PitchTrack = {
  /** Fundamental in Hz per frame; 0 where unvoiced. */
  f0: Float32Array;
  /** Samples between frames, and the sample the first frame is centered on. */
  hop: number;
  delay: number;
};

const DECIMATE = 4, HOP = 512, MIN_HZ = 70, MAX_HZ = 800, THRESHOLD = 0.15, SILENCE = 0.008;
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** YIN fundamental track of `x`. Yields to the event loop now and then and reports progress 0..1. */
export async function detectPitch(x: Float32Array, sampleRate: number, onProgress?: (p: number) => void): Promise<PitchTrack> {
  const rate = sampleRate / DECIMATE, n = Math.floor(x.length / DECIMATE);
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < DECIMATE; k++) s += x[i * DECIMATE + k]; d[i] = s / DECIMATE; }
  const tauMax = Math.floor(rate / MIN_HZ), tauMin = Math.max(2, Math.floor(rate / MAX_HZ)), win = 320, span = win + tauMax;
  const dhop = HOP / DECIMATE, frames = Math.max(0, Math.floor((n - span) / dhop) + 1);
  const f0 = new Float32Array(frames), diff = new Float32Array(tauMax + 2), cmnd = new Float32Array(tauMax + 2);
  for (let f = 0; f < frames; f++) {
    const s = f * dhop;
    let energy = 0;
    for (let j = 0; j < win; j++) energy += d[s + j] * d[s + j];
    if (Math.sqrt(energy / win) >= SILENCE) {
      let running = 0;
      cmnd[0] = 1;
      for (let tau = 1; tau <= tauMax; tau++) {
        let sum = 0;
        for (let j = 0; j < win; j++) { const e = d[s + j] - d[s + j + tau]; sum += e * e; }
        diff[tau] = sum; running += sum;
        cmnd[tau] = running > 0 ? sum * tau / running : 1;
      }
      let tau = -1;
      for (let t = tauMin; t < tauMax; t++) {
        if (cmnd[t] < THRESHOLD) { while (t + 1 < tauMax && cmnd[t + 1] < cmnd[t]) t++; tau = t; break; }
      }
      if (tau < 0) {
        let lowest = tauMin;
        for (let t = tauMin; t < tauMax; t++) if (cmnd[t] < cmnd[lowest]) lowest = t;
        if (cmnd[lowest] < 0.35) tau = lowest;
      }
      if (tau > 0) {
        // Parabolic refinement between the neighbouring lags.
        const a = cmnd[tau - 1], b = cmnd[tau], c = cmnd[tau + 1], den = a - 2 * b + c;
        const shift = den !== 0 ? 0.5 * (a - c) / den : 0;
        f0[f] = rate / (tau + Math.max(-1, Math.min(1, shift)));
      }
    }
    if (f % 400 === 0) { onProgress?.(f / frames); await tick(); }
  }
  // A 5-frame median over the voiced neighbours removes single-frame octave jumps.
  const smooth = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    if (!f0[f]) continue;
    const near: number[] = [];
    for (let k = Math.max(0, f - 2); k <= Math.min(frames - 1, f + 2); k++) if (f0[k]) near.push(f0[k]);
    near.sort((p, q) => p - q);
    smooth[f] = near.length >= 3 ? near[near.length >> 1] : f0[f];
  }
  return { f0: smooth, hop: HOP, delay: (span / 2) * DECIMATE };
}

/** Cents to move each frame: toward the nearest scale note, `amount` of the way, eased by `speed`. 0 on unvoiced frames. */
export function correctionCents(track: PitchTrack, sampleRate: number, opts: TuneOptions): Float32Array {
  const out = new Float32Array(track.f0.length);
  const alpha = opts.speed <= 0 ? 1 : 1 - Math.exp(-(track.hop / sampleRate) / (opts.speed / 1000));
  let current = 0;
  for (let f = 0; f < out.length; f++) {
    if (!track.f0[f]) { current = 0; continue; }
    const midi = hzToMidi(track.f0[f]);
    const goal = (nearestInScale(midi, opts.key, opts.scale) - midi) * 100 * opts.amount;
    current += alpha * (goal - current);
    out[f] = Math.max(-700, Math.min(700, current));
  }
  return out;
}

/** Moves the pitch of `x` by `cents` per frame without changing its length. */
export function retune(x: Float32Array, track: PitchTrack, cents: Float32Array, sampleRate: number): Float32Array {
  const n = x.length, sum = new Float32Array(n), weight = new Float32Array(n);
  const frames = track.f0.length;
  const at = (t: number) => Math.max(0, Math.min(frames - 1, (t - track.delay) / track.hop));
  let t = 0;
  while (t < n && frames > 0) {
    const pos = at(t), lo = Math.floor(pos), hi = Math.min(frames - 1, lo + 1), frac = pos - lo;
    const near = frac < 0.5 ? lo : hi;
    if (!track.f0[near]) { t += track.hop / 2; continue; }
    const hz = track.f0[lo] && track.f0[hi] ? track.f0[lo] * (1 - frac) + track.f0[hi] * frac : track.f0[near];
    const shift = track.f0[lo] && track.f0[hi] ? cents[lo] * (1 - frac) + cents[hi] * frac : cents[near];
    const period = sampleRate / hz, ratio = Math.pow(2, shift / 1200), half = Math.round(period);
    // Snap the grain to the nearest waveform peak so consecutive grains line up.
    const centre0 = Math.round(t), reach = Math.round(period / 3);
    let centre = Math.min(n - 1, centre0);
    for (let k = -reach; k <= reach; k++) {
      const i = centre0 + k;
      if (i >= 0 && i < n && x[i] > x[centre]) centre = i;
    }
    for (let k = -half; k <= half; k++) {
      const src = centre + k, dst = centre0 + k;
      if (src < 0 || src >= n || dst < 0 || dst >= n) continue;
      const w = 0.5 * (1 + Math.cos(Math.PI * k / half));
      sum[dst] += x[src] * w; weight[dst] += w;
    }
    t += period / ratio;
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = weight[i] >= 1 ? sum[i] / weight[i] : sum[i] + x[i] * (1 - weight[i]);
  return out;
}

/** The whole chain on one mono take. */
export async function autotune(x: Float32Array, sampleRate: number, opts: TuneOptions, onProgress?: (p: number) => void): Promise<Float32Array> {
  const track = await detectPitch(x, sampleRate, p => onProgress?.(p * 0.9));
  const out = retune(x, track, correctionCents(track, sampleRate, opts), sampleRate);
  onProgress?.(1);
  return out;
}
