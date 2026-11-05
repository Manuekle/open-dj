import { describe, expect, it } from "vitest";
import { createSpectralShifter, PITCH_SHIFT_WORKLET, ratioOf, shifterSize } from "@/lib/pitch-shift";

const RATE = 48000, BLOCK = 128;

/** Runs `input` through a shifter in render-quantum blocks, as the worklet does. */
function run(channels: Float32Array[], semitones: number) {
  const s = createSpectralShifter(shifterSize(RATE), channels.length);
  s.setRatio(ratioOf(semitones));
  const out = channels.map(c => new Float32Array(c.length));
  for (let at = 0; at + BLOCK <= channels[0].length; at += BLOCK) {
    s.process(channels.map(c => c.subarray(at, at + BLOCK)), out.map(c => c.subarray(at, at + BLOCK)));
  }
  return { out, latency: s.latency };
}

const sine = (hz: number, seconds: number, amp = 0.5) => {
  const x = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin(2 * Math.PI * hz * i / RATE);
  return x;
};

/** Frequency from upward zero crossings, interpolated, over `x`. */
function frequency(x: Float32Array) {
  const crossings: number[] = [];
  for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) crossings.push(i - 1 + x[i - 1] / (x[i - 1] - x[i]));
  return (crossings.length - 1) * RATE / (crossings[crossings.length - 1] - crossings[0]);
}
const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

describe("spectral pitch shifter", () => {
  it("passes the sound through unchanged at no shift, a latency late", () => {
    const x = sine(330, 1);
    const { out: [y], latency } = run([x], 0);
    let worst = 0;
    for (let i = 4096 + latency; i < x.length - BLOCK; i++) worst = Math.max(worst, Math.abs(y[i] - x[i - latency]));
    expect(worst).toBeLessThan(1e-4);
  });

  it.each([[5, 220], [-7, 440], [3, 82.41], [-2, 1000]])("moves a %i semitone shift of a %f Hz tone to the right pitch", (semitones, hz) => {
    const { out: [y] } = run([sine(hz, 2)], semitones);
    const steady = y.subarray(RATE / 2, RATE * 2 - 4096);
    const got = frequency(steady), want = hz * ratioOf(semitones);
    expect(Math.abs(1200 * Math.log2(got / want))).toBeLessThan(10);
    expect(rms(steady)).toBeGreaterThan(0.5 / Math.SQRT2 * 0.7);
    expect(rms(steady)).toBeLessThan(0.5 / Math.SQRT2 * 1.2);
  });

  it("moves both notes of a chord and keeps the channels apart", () => {
    const a = sine(261.63, 2), e = sine(329.63, 2, 0.3);
    const left = a.map((v, i) => v + e[i]), right = a.slice();
    const { out: [l, r] } = run([left, right], 4);
    const steady = (x: Float32Array) => x.subarray(RATE / 2, RATE * 2 - 4096);
    expect(Math.abs(1200 * Math.log2(frequency(steady(r)) / (261.63 * ratioOf(4))))).toBeLessThan(10);
    // The left channel carries more energy than the right, as it went in.
    expect(rms(steady(l))).toBeGreaterThan(rms(steady(r)) * 1.1);
  });

  it("stays silent on silence", () => {
    const { out: [y] } = run([new Float32Array(RATE)], 3);
    expect(rms(y)).toBe(0);
  });

  it("ships as a worklet module that needs no outside names", () => {
    const registered: Record<string, new (o: unknown) => { port: { onmessage: (e: unknown) => void }; process: (i: Float32Array[][], o: Float32Array[][]) => boolean }> = {};
    new Function("AudioWorkletProcessor", "registerProcessor", PITCH_SHIFT_WORKLET)(
      class { port = { onmessage: () => undefined }; },
      (name: string, ctor: (typeof registered)[string]) => { registered[name] = ctor; },
    );
    const node = new registered["pitch-shift"]({ processorOptions: { size: 2048 } });
    node.port.onmessage({ data: { ratio: ratioOf(2) } });
    const x = sine(440, 0.5), out = [new Float32Array(x.length), new Float32Array(x.length)];
    for (let at = 0; at + BLOCK <= x.length; at += BLOCK) {
      expect(node.process([[x.subarray(at, at + BLOCK)]], [out.map(c => c.subarray(at, at + BLOCK))])).toBe(true);
    }
    expect(rms(out[1].subarray(RATE / 8))).toBeGreaterThan(0.2);
    // No input connected: silence, not an error.
    expect(node.process([[]], [[new Float32Array(BLOCK), new Float32Array(BLOCK)]])).toBe(true);
  });
});
