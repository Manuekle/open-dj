import { OfflineAudioContext } from "node-web-audio-api";
import { describe, expect, it } from "vitest";
import { CEILING, createMasterBus } from "@/lib/audio-engine";

const RATE = 44100;

/** Renders sines [frequency Hz, amplitude] through the master bus, offline, and gives the output's first channel. */
async function throughMaster(parts: [number, number][], seconds = 2) {
  const ctx = new OfflineAudioContext(1, seconds * RATE, RATE);
  const bus = createMasterBus(ctx as unknown as BaseAudioContext);
  for (const [frequency, amplitude] of parts) {
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.frequency.value = frequency; gain.gain.value = amplitude;
    osc.connect(gain); gain.connect(bus.input as unknown as AudioNode & Parameters<typeof gain.connect>[0]);
    osc.start();
  }
  (bus.output as unknown as { connect: (n: unknown) => void }).connect(ctx.destination);
  return (await ctx.startRendering()).getChannelData(0);
}
const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

describe("master bus", () => {
  it("never lets two full decks clip the output", async () => {
    // Two decks near full scale at once sum to 1.8.
    const out = await throughMaster([[100, 0.9], [151, 0.9]]);
    expect(peak(out)).toBeLessThanOrEqual(CEILING);
  });

  it("holds a hot square-ish transient under the ceiling from the first sample", async () => {
    const out = await throughMaster([[60, 3]], 0.5);
    expect(peak(out)).toBeLessThanOrEqual(CEILING);
  });

  it("leaves a signal under the threshold untouched", async () => {
    const out = await throughMaster([[220, 0.5]]);
    // Skip the start, where the limiter's lookahead delays the signal.
    const settled = out.subarray(RATE / 2);
    expect(peak(settled)).toBeCloseTo(0.5, 2);
    expect(20 * Math.log10(rms(settled) / (0.5 / Math.SQRT2))).toBeCloseTo(0, 1);
  });
});
