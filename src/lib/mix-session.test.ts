import { OfflineAudioContext } from "node-web-audio-api";
import { describe, expect, it } from "vitest";
import { CEILING } from "@/lib/audio-engine";
import { applyColor, applyEffect } from "@/lib/deck-graph";
import { peak, renderMix, sine, stepRatio, toneLevel, type Scenario } from "@/lib/mix-render";

const RATE = 22050;
/** Fader x master at rest: a deck alone on the outgoing side. */
const GAIN = 0.82 * 0.9;
const FA = 220, FB = 330, AMP = 0.3;
const parts: [number, number][] = [[FA, AMP], [FB, AMP]];
const plain = { volume: "smooth", eq: "none", effect: "none", stems: "none" } as const;

function scenario(over: Partial<Scenario> = {}): Scenario {
  const seconds = over.seconds ?? 20;
  return { sampleRate: RATE, seconds, a: sine(FA, AMP, seconds, RATE), b: sine(FB, AMP, seconds, RATE), plan: plain, start: 2, duration: 12, ...over };
}
const render = (s: Scenario) => renderMix(OfflineAudioContext, s);

describe("a transition written as AudioParam automation", () => {
  it("hands the output from one deck to the other with constant power and no step", async () => {
    const { out } = await render(scenario());
    expect(peak(out)).toBeLessThanOrEqual(CEILING);
    expect(stepRatio(out, RATE, parts, GAIN)).toBeLessThan(1.05);
    // Before: deck A alone. After: deck B alone.
    expect(toneLevel(out, RATE, FA, 0.5, 1.5)).toBeCloseTo(AMP * GAIN, 2);
    expect(toneLevel(out, RATE, FB, 0.5, 1.5)).toBeLessThan(0.002);
    expect(toneLevel(out, RATE, FB, 16, 19)).toBeCloseTo(AMP * GAIN, 2);
    expect(toneLevel(out, RATE, FA, 16, 19)).toBeLessThan(0.002);
    // Equal power: the two tones' combined power stays level across the blend (within 0.5 dB).
    const power = (from: number) => toneLevel(out, RATE, FA, from, from + 1) ** 2 + toneLevel(out, RATE, FB, from, from + 1) ** 2;
    for (let t = 2; t < 13; t++) expect(10 * Math.log10(power(t) / power(0.5))).toBeCloseTo(0, 0);
  });

  it("is not moved by anything the main thread does: the lanes finish on their own", async () => {
    // Nothing is called after schedule(); the blend must still complete on the audio clock alone.
    const { out, session } = await render(scenario());
    expect(session.end).toBeCloseTo(14, 6);
    expect(toneLevel(out, RATE, FB, 15, 19)).toBeCloseTo(AMP * GAIN, 2);
  });

  const lengths: [string, number, number][] = [
    ["16 bars at 120 bpm", 120, 16], ["16 bars at 124 bpm", 124, 16], ["32 bars at 120 bpm", 120, 32], ["32 bars at 128 bpm", 128, 32],
  ];
  it.each(lengths)("runs %s to its exact end", async (_name, bpm, bars) => {
    const duration = bars * 4 * 60 / bpm;
    const { out, session } = await render(scenario({ seconds: duration + 6, start: 1, duration }));
    expect(session.end).toBeCloseTo(1 + duration, 6);
    expect(peak(out)).toBeLessThanOrEqual(CEILING);
    expect(stepRatio(out, RATE, parts, GAIN)).toBeLessThan(1.05);
    // The blend is half done halfway: both tones sit at -3 dB.
    const mid = 1 + duration / 2;
    expect(toneLevel(out, RATE, FA, mid - 0.5, mid + 0.5) / (AMP * GAIN)).toBeCloseTo(Math.SQRT1_2, 1);
    expect(toneLevel(out, RATE, FA, 1 + duration + 1, 1 + duration + 4)).toBeLessThan(0.002);
  }, 30000);

  it("works the other way round, from deck B to deck A", async () => {
    const { out } = await render(scenario({ from: "B" }));
    expect(toneLevel(out, RATE, FB, 0.5, 1.5)).toBeCloseTo(AMP * GAIN, 2);
    expect(toneLevel(out, RATE, FA, 16, 19)).toBeCloseTo(AMP * GAIN, 2);
    expect(stepRatio(out, RATE, parts, GAIN)).toBeLessThan(1.05);
  });

  it("swaps the bass at the middle without stacking two bass lines", async () => {
    const hot = 1.2, f = 60;
    const base = scenario({ a: sine(f, hot, 20, RATE), b: sine(f, hot, 20, RATE) });
    const flat = await render(base);
    const swap = await render({ ...base, plan: { ...plain, eq: "bass" } });
    // Two in-phase hot bass lines sum coherently; the limiter holds both, but the swap keeps the sum lower in the middle.
    expect(peak(flat.out)).toBeLessThanOrEqual(CEILING);
    expect(peak(swap.out)).toBeLessThanOrEqual(CEILING);
    const mid = (x: Float32Array) => peak(x.subarray(Math.round(7.5 * RATE), Math.round(8.5 * RATE)));
    expect(mid(swap.out)).toBeLessThan(mid(flat.out));
  });

  it.each(["lowpass", "rise", "echo", "reverb", "flanger", "swap"] as const)("blends with the %s effect and leaves the outgoing deck silent", async effect => {
    const { out } = await render(scenario({ plan: { ...plain, eq: "bass", effect } }));
    expect(out.every(Number.isFinite)).toBe(true);
    expect(peak(out)).toBeLessThanOrEqual(CEILING);
    // The effect's tail is gated by the same volume lane, so nothing of the old deck is left once the blend ends.
    expect(toneLevel(out, RATE, FA, 16, 19)).toBeLessThan(0.003);
    expect(toneLevel(out, RATE, FB, 16, 19)).toBeCloseTo(AMP * GAIN, 2);
  });
});

describe("a transition that starts late", () => {
  it("ramps the incoming deck in instead of stepping it to a level", async () => {
    // Asked to start at 0, which render time has already reached, with 30% of the blend gone.
    const { out } = await render(scenario({ start: -3.6, duration: 12, seconds: 14 }));
    expect(stepRatio(out, RATE, parts, GAIN)).toBeLessThan(1.1);
    expect(toneLevel(out, RATE, FB, 10, 13)).toBeCloseTo(AMP * GAIN, 2);
  });
});

describe("cancelling a transition", () => {
  const cancelAt = (at: number) => ({ at, run: (h: { session: { cancel: () => void } }) => h.session.cancel() });

  it("returns the faders to the crossfader without a click, and leaves no automation behind", async () => {
    const { out } = await render(scenario({ seconds: 30, actions: [cancelAt(7)] }));
    expect(stepRatio(out, RATE, parts, GAIN)).toBeLessThan(1.15);
    // The crossfader sits on A: A is back at full, B is gone, and stays so well past the old end (14 s).
    for (const [from, to] of [[9, 12], [16, 20], [24, 29]]) {
      expect(toneLevel(out, RATE, FA, from, to)).toBeCloseTo(AMP * GAIN, 2);
      expect(toneLevel(out, RATE, FB, from, to)).toBeLessThan(0.002);
    }
  });

  it("cancels before the blend has started", async () => {
    const { out } = await render(scenario({ seconds: 12, actions: [cancelAt(1)] }));
    expect(toneLevel(out, RATE, FA, 4, 11)).toBeCloseTo(AMP * GAIN, 2);
    expect(toneLevel(out, RATE, FB, 4, 11)).toBeLessThan(0.002);
  });

  it("lets the next transition start clean after a cancel", async () => {
    const { out } = await render(scenario({
      seconds: 36,
      actions: [cancelAt(6), { at: 10, run: h => { h.next({ start: 12, duration: 10 }); } }],
    }));
    expect(stepRatio(out, RATE, parts, GAIN, Math.round(6 * RATE))).toBeLessThan(1.15);
    // Before the second blend A is alone; after it, B is.
    expect(toneLevel(out, RATE, FA, 9.5, 11.5)).toBeCloseTo(AMP * GAIN, 2);
    expect(toneLevel(out, RATE, FB, 9.5, 11.5)).toBeLessThan(0.002);
    expect(toneLevel(out, RATE, FB, 25, 34)).toBeCloseTo(AMP * GAIN, 2);
    expect(toneLevel(out, RATE, FA, 25, 34)).toBeLessThan(0.002);
    // The second blend is half done 5 s in, at -3 dB each, exactly as a first one would be.
    expect(toneLevel(out, RATE, FA, 16.5, 17.5) / (AMP * GAIN)).toBeCloseTo(Math.SQRT1_2, 1);
  });

  it("cancels a blend with filters, a bass swap and an effect, and the lanes come back to neutral", async () => {
    const plan = { ...plain, eq: "bass", effect: "swap" } as const;
    const { out } = await render(scenario({ seconds: 24, plan, actions: [cancelAt(8)] }));
    expect(out.every(Number.isFinite)).toBe(true);
    expect(peak(out)).toBeLessThanOrEqual(CEILING);
    expect(toneLevel(out, RATE, FA, 14, 23)).toBeCloseTo(AMP * GAIN, 2);
    expect(toneLevel(out, RATE, FB, 14, 23)).toBeLessThan(0.002);
  });
});

describe("changing the tempo while a transition runs", () => {
  it("re-anchors the rest of the blend to a new length without a step", async () => {
    // At 7 s (5 s in), the outgoing deck speeds up 25 %: the remaining 7 s of blend now take 5.6 s.
    const { out, session } = await render(scenario({
      seconds: 20, actions: [{ at: 7, run: h => h.session.reanchor(h.session.remaining(7) / 1.25) }],
    }));
    expect(session.end).toBeCloseTo(7 + 7 / 1.25, 1);
    expect(stepRatio(out, RATE, parts, GAIN)).toBeLessThan(1.15);
    expect(toneLevel(out, RATE, FB, 14, 19)).toBeCloseTo(AMP * GAIN, 2);
    expect(toneLevel(out, RATE, FA, 14, 19)).toBeLessThan(0.002);
  });

  it("leaves early on a fallback, keeping power level and ending on the new deck", async () => {
    const { out, session } = await render(scenario({
      seconds: 20, actions: [{ at: 6, run: h => h.session.reanchor(1.5) }],
    }));
    expect(session.end).toBeCloseTo(7.5, 1);
    expect(stepRatio(out, RATE, parts, GAIN)).toBeLessThan(1.2);
    expect(toneLevel(out, RATE, FB, 9, 19)).toBeCloseTo(AMP * GAIN, 2);
    expect(toneLevel(out, RATE, FA, 9, 19)).toBeLessThan(0.002);
  });

  it("follows the media when it is found to be ahead of the clock", async () => {
    // The media says the blend is at 60% when the clock says 42%: the lanes glide there and carry on.
    const { out } = await render(scenario({
      seconds: 20, actions: [{ at: 7, run: h => h.session.reanchor(5.6, 0.6) }],
    }));
    expect(stepRatio(out, RATE, parts, GAIN)).toBeLessThan(1.3);
    expect(toneLevel(out, RATE, FB, 14, 19)).toBeCloseTo(AMP * GAIN, 2);
  });
});

describe("the DJ's own controls during a transition", () => {
  it("takes effect, EQ and color moves without throwing or clicking", async () => {
    const plan = { ...plain, eq: "bass", effect: "lowpass" } as const;
    const moves = [
      { at: 5, run: (h: { ctx: BaseAudioContext; A: Parameters<typeof applyEffect>[1] }) => applyEffect(h.ctx, h.A, "echo", 0.5) },
      { at: 6, run: (h: { ctx: BaseAudioContext; A: Parameters<typeof applyEffect>[1] }) => applyColor(h.ctx, h.A, -0.6) },
      { at: 7, run: (h: { ctx: BaseAudioContext; A: Parameters<typeof applyEffect>[1] }) => h.A.low.gain.setTargetAtTime(-12, h.ctx.currentTime, 0.01) },
      { at: 8, run: (h: { ctx: BaseAudioContext; A: Parameters<typeof applyEffect>[1] }) => applyEffect(h.ctx, h.A, "reverb", 0.7) },
      { at: 9, run: (h: { ctx: BaseAudioContext; A: Parameters<typeof applyEffect>[1] }) => applyColor(h.ctx, h.A, 0) },
      { at: 10, run: (h: { ctx: BaseAudioContext; A: Parameters<typeof applyEffect>[1] }) => applyEffect(h.ctx, h.A, "off", 0) },
    ];
    const { out } = await render(scenario({ seconds: 22, plan, actions: moves as Scenario["actions"] }));
    expect(out.every(Number.isFinite)).toBe(true);
    expect(peak(out)).toBeLessThanOrEqual(CEILING);
    expect(toneLevel(out, RATE, FB, 17, 21)).toBeCloseTo(AMP * GAIN, 2);
  });

  it("moves the color knob through zero without the jump a filter type change makes", async () => {
    // A sweep from -0.8 to +0.8 in 40 steps while the blend is idle: the output stays within a step of the tone.
    const steps = Array.from({ length: 41 }, (_, i) => ({
      at: 1 + i * 0.05, run: (h: { ctx: BaseAudioContext; A: Parameters<typeof applyColor>[1] }) => applyColor(h.ctx, h.A, -0.8 + i * 0.04),
    }));
    const { out } = await render(scenario({ seconds: 5, start: 50, duration: 12, actions: steps as Scenario["actions"] }));
    expect(out.every(Number.isFinite)).toBe(true);
    expect(stepRatio(out, RATE, [[FA, AMP]], GAIN, Math.round(0.5 * RATE))).toBeLessThan(1.3);
  });
});
