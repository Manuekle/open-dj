/* Pitch shift without a tempo change, for whole mixes (the karaoke key control). A phase vocoder with peak locking after
   Laroche and Dolson, "New phase-vocoder techniques for pitch-shifting" (1999):
   1. Each frame (Hann window, a quarter-frame hop, zero-phase so the phase is read at the frame centre) goes to the
      spectrum. Peaks are found on the sum of the channels and every bin joins the region of its nearest peak.
   2. A peak's true frequency comes from how far its phase moved since the last frame. Its whole region is moved to the
      bin of that frequency times the ratio, and turned by a phase that grows by (ratio - 1) x frequency x hop each
      frame, so the moved partial keeps running at its new frequency from frame to frame.
   3. Every channel gets the same moves and turns, so the stereo image holds. Overlap-add puts the frames back.
   The latency is one frame. createSpectralShifter is self-contained (no outside names) because the karaoke
   page sends its source to an AudioWorklet as text (PITCH_SHIFT_WORKLET). */

export type SpectralShifter = {
  /** Samples between a sample going in and coming out. */
  latency: number;
  /** Frequency ratio, 2 ** (semitones / 12). 1 passes the sound through unchanged, a latency late. */
  setRatio(ratio: number): void;
  /** Streams one block: `input` and `output` hold one array per channel, all the same length. */
  process(input: Float32Array[], output: Float32Array[]): void;
};

/** Frame size for a sample rate: about 43 ms, enough for a bass note's partials to land in separate bins. */
export const shifterSize = (sampleRate: number) => sampleRate > 50000 ? 4096 : 2048;
/** The shifter's delay in seconds. */
export const shifterLatency = (sampleRate: number) => shifterSize(sampleRate) / sampleRate;
export const ratioOf = (semitones: number) => Math.pow(2, semitones / 12);

export function createSpectralShifter(size: number, channels: number): SpectralShifter {
  const N = size, half = N >> 1, hop = N >> 2, start = N - hop, TAU = 2 * Math.PI;
  // Hann analysis and synthesis at a quarter-frame hop sum to 1.5.
  const gain = 1 / (N * 1.5);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(TAU * i / N);
  const bits = Math.round(Math.log2(N));
  const rev = new Uint32Array(N);
  for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cosT = new Float64Array(half), sinT = new Float64Array(half);
  for (let i = 0; i < half; i++) { cosT[i] = Math.cos(TAU * i / N); sinT[i] = Math.sin(TAU * i / N); }

  function fft(re: Float64Array, im: Float64Array, inverse: boolean) {
    for (let i = 0; i < N; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= N; len <<= 1) {
      const h = len >> 1, step = N / len;
      for (let s = 0; s < N; s += len) {
        for (let k = 0; k < h; k++) {
          const wr = cosT[k * step], wi = inverse ? sinT[k * step] : -sinT[k * step];
          const a = s + k, b = a + h;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  }
  const wrap = (x: number) => x - TAU * Math.round(x / TAU);
  const make = () => Array.from({ length: channels }, () => new Float64Array(N));

  const inFifo = Array.from({ length: channels }, () => new Float32Array(N));
  const outFifo = Array.from({ length: channels }, () => new Float32Array(hop));
  const acc = make(), re = make(), im = make(), yRe = make(), yIm = make();
  const mag = new Float64Array(half + 1), phase = new Float64Array(half + 1), prevPhase = new Float64Array(half + 1);
  const peaks = new Int32Array(half), theta = new Float64Array(half), bounds = new Int32Array(half + 1);
  const prevPeaks = new Int32Array(half), prevTheta = new Float64Array(half);
  let prevCount = 0, rover = start, ratio = 1;

  function frame() {
    for (let c = 0; c < channels; c++) {
      const x = inFifo[c], r = re[c], m = im[c];
      // Zero phase: the frame centre goes to index 0.
      for (let i = 0; i < N; i++) { const j = (i + half) % N; r[j] = x[i] * win[i]; m[j] = 0; }
      fft(r, m, false);
      yRe[c].fill(0); yIm[c].fill(0);
    }
    let top = 0;
    for (let k = 0; k <= half; k++) {
      let sr = 0, si = 0, sm = 0;
      for (let c = 0; c < channels; c++) { sr += re[c][k]; si += im[c][k]; sm += Math.hypot(re[c][k], im[c][k]); }
      mag[k] = sm; phase[k] = Math.atan2(si, sr);
      if (sm > top) top = sm;
    }
    if (ratio === 1) {
      for (let c = 0; c < channels; c++) for (let k = 0; k <= half; k++) { yRe[c][k] = re[c][k]; yIm[c][k] = im[c][k]; }
      prevCount = 0;
    } else {
      const floor = Math.max(top * 1e-4, 1e-9);
      let count = 0;
      for (let k = 2; k <= half - 2; k++) {
        const v = mag[k];
        if (v > floor && v > mag[k - 1] && v >= mag[k + 1] && v > mag[k - 2] && v >= mag[k + 2]) peaks[count++] = k;
      }
      // Regions: each boundary sits on the quietest bin between two peaks.
      bounds[0] = 0; bounds[count] = half + 1;
      for (let i = 1; i < count; i++) {
        let low = peaks[i - 1] + 1;
        for (let k = low + 1; k <= peaks[i]; k++) if (mag[k] < mag[low]) low = k;
        bounds[i] = low;
      }
      let j = 0;
      for (let i = 0; i < count; i++) {
        const k = peaks[i], omega = TAU * k / N;
        const inst = omega + wrap(phase[k] - prevPhase[k] - omega * hop) / hop;
        while (j < prevCount - 1 && Math.abs(prevPeaks[j + 1] - k) <= Math.abs(prevPeaks[j] - k)) j++;
        const before = prevCount > 0 && Math.abs(prevPeaks[j] - k) <= 2 ? prevTheta[j] : 0;
        const turn = wrap(before + hop * (ratio - 1) * inst);
        theta[i] = turn;
        const shift = Math.round(ratio * inst * N / TAU) - k;
        const cs = Math.cos(turn), sn = Math.sin(turn);
        for (let b = bounds[i]; b < bounds[i + 1]; b++) {
          const to = b + shift;
          if (to < 0 || to > half) continue;
          for (let c = 0; c < channels; c++) {
            const a = re[c][b], d = im[c][b];
            yRe[c][to] += a * cs - d * sn; yIm[c][to] += a * sn + d * cs;
          }
        }
      }
      for (let i = 0; i < count; i++) { prevPeaks[i] = peaks[i]; prevTheta[i] = theta[i]; }
      prevCount = count;
    }
    prevPhase.set(phase);
    for (let c = 0; c < channels; c++) {
      const r = yRe[c], m = yIm[c], a = acc[c];
      m[0] = 0; m[half] = 0;
      for (let k = 1; k < half; k++) { r[N - k] = r[k]; m[N - k] = -m[k]; }
      fft(r, m, true);
      for (let i = 0; i < N; i++) a[i] += r[(i + half) % N] * win[i] * gain;
      const out = outFifo[c];
      for (let i = 0; i < hop; i++) out[i] = a[i];
      a.copyWithin(0, hop); a.fill(0, N - hop);
      inFifo[c].copyWithin(0, hop);
    }
  }

  return {
    latency: N,
    setRatio(next: number) { ratio = Number.isFinite(next) && next > 0 ? Math.max(0.5, Math.min(2, next)) : 1; },
    process(input: Float32Array[], output: Float32Array[]) {
      const n = output[0]?.length ?? 0;
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < channels; c++) {
          const src = input[c] ?? input[0];
          inFifo[c][rover] = src ? src[i] : 0;
          if (output[c]) output[c][i] = outFifo[c][rover - start];
        }
        if (++rover >= N) { rover = start; frame(); }
      }
    },
  };
}

/** The AudioWorklet module: a stereo "pitch-shift" processor; post {ratio} to its port. Load it from a Blob URL. */
export const PITCH_SHIFT_WORKLET = `
const createSpectralShifter = (${createSpectralShifter.toString()});
class PitchShiftProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.shifter = createSpectralShifter(options.processorOptions.size, 2);
    this.silence = [];
    this.port.onmessage = e => { if (e.data && typeof e.data.ratio === "number") this.shifter.setRatio(e.data.ratio); };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    let input = inputs[0];
    if (!input || input.length === 0) {
      if (!this.silence[0] || this.silence[0].length !== out[0].length) this.silence = [new Float32Array(out[0].length)];
      input = this.silence;
    }
    this.shifter.process(input, out);
    return true;
  }
}
registerProcessor("pitch-shift", PitchShiftProcessor);`;
