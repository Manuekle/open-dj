import { describe, expect, it } from "vitest";
import { envelopeAt, localTime, timelineTime } from "./stem-mix";
import { planToMix, simplify } from "./stem-plan";
import type { TransitionPlan } from "./types";

const plan = (p: Partial<TransitionPlan>) => ({ outAt: 100, inAt: 8, bars: 8, volume: "linear", eq: "none", effect: "none", ...p }) as TransitionPlan;
const a = { bpm: 120 }, b = { bpm: 120 };

describe("planToMix", () => {
  it("places B so it is at inAt when A reaches outAt", () => {
    const fit = planToMix(plan({}), a, b);
    const pb = { offset: fit.offset, ratio: fit.ratio, duration: 300 };
    expect(localTime(pb, 100)).toBeCloseTo(8);
    expect(fit.span).toEqual({ from: 100, to: 116 });
  });
  it("syncs B's tempo, and keeps it when the plan does not sync", () => {
    expect(planToMix(plan({}), a, { bpm: 125 }).ratio).toBeCloseTo(0.96);
    expect(planToMix(plan({ sync: false }), a, { bpm: 125 }).ratio).toBe(1);
  });
  it("samples the plan's volume curve", () => {
    const fit = planToMix(plan({}), a, b);
    expect(envelopeAt(fit.volume[0], 99)).toBe(1);
    expect(envelopeAt(fit.volume[0], 108)).toBeCloseTo(0.5, 1);
    expect(envelopeAt(fit.volume[0], 117)).toBe(0);
    const pb = { offset: fit.offset, ratio: fit.ratio, duration: 300 };
    expect(envelopeAt(fit.volume[1], localTime(pb, 116))).toBe(1);
    // A straight line needs only its ends.
    expect(fit.volume[0]).toHaveLength(2);
  });
  it("turns a bass stem swap into the two bass curves, and leaves the other stems flat", () => {
    const fit = planToMix(plan({ stems: "bass", eqAt: 0.5 }), a, b);
    expect(fit.stems[0][0]).toEqual([]);
    expect(envelopeAt(fit.stems[0][2], 105)).toBe(1);
    expect(envelopeAt(fit.stems[0][2], 111)).toBe(0);
    const pb = { offset: fit.offset, ratio: fit.ratio, duration: 300 };
    expect(envelopeAt(fit.stems[1][2], localTime(pb, 105))).toBe(0);
    expect(envelopeAt(fit.stems[1][2], localTime(pb, timelineTime(pb, localTime(pb, 111))))).toBe(1);
  });
  it("plays an eq bass swap on the bass stems", () => {
    const fit = planToMix(plan({ eq: "bass" }), a, b);
    expect(envelopeAt(fit.stems[0][2], 112)).toBe(0);
    expect(fit.stems[0][1]).toEqual([]);
  });
  it("drops the points a line already draws", () => {
    expect(simplify([{ t: 0, g: 0 }, { t: 1, g: 0.5 }, { t: 2, g: 1 }, { t: 3, g: 1 }])).toEqual([{ t: 0, g: 0 }, { t: 2, g: 1 }, { t: 3, g: 1 }]);
  });
});
