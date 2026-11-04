import { describe, expect, it } from "vitest";
import { energyOf, fitPlanFrom, pairScore, skipPlan, smartOrder } from "@/lib/planner";
import { autoPlan, spanOn } from "@/lib/transition";
import { track } from "@/lib/test-tracks";

const key = (camelot: string) => ({ camelot, key: camelot });
const loud = (db: number) => ({ loudness: db, energy: Array(240).fill(db) });

describe("how well two tracks go together", () => {
  it("rates matching tempo and key above a clash", () => {
    const from = track({ title: "from", bpm: 128, ...key("8A") });
    const fit = pairScore(from, track({ title: "fit", bpm: 127, ...key("9A") }));
    const clash = pairScore(from, track({ title: "clash", bpm: 100, ...key("3B") }));
    expect(fit.score).toBeGreaterThan(clash.score);
    expect(fit.tempo).toBeGreaterThan(0.9);
    expect(clash.key).toBeLessThan(0.3);
  });

  it("reads half time as the same tempo", () => {
    expect(pairScore(track({ bpm: 128 }), track({ bpm: 64 })).tempo).toBe(1);
  });

  it("treats unknown tempo and key as neutral, not as a clash", () => {
    const unknown = pairScore(track({ bpm: 128, ...key("8A") }), track({ bpm: null }));
    expect(unknown.tempo).toBe(0.5);
    expect(unknown.key).toBe(0.5);
    expect(unknown.score).toBeGreaterThan(pairScore(track({ bpm: 128, ...key("8A") }), track({ bpm: 100, ...key("3B") })).score);
  });

  it("prefers a gentle rise in energy to a drop", () => {
    const base = track({ ...loud(-18) });
    const rise = pairScore(base, track({ ...loud(-15) })).energy;
    const drop = pairScore(base, track({ ...loud(-21) })).energy;
    expect(rise).toBeGreaterThan(drop);
  });

  it("has no energy for a track with no analysis", () => {
    expect(energyOf(track({ bpm: null }))).toBeNull();
    expect(energyOf(track({ bpm: null, loudness: -12 }))).toBeGreaterThan(0);
  });
});

describe("smart ordering", () => {
  const anchor = track({ title: "anchor", bpm: 128, ...key("8A"), ...loud(-14) });
  const near = track({ title: "near", bpm: 128, ...key("8A"), ...loud(-13) });
  const step = track({ title: "step", bpm: 126, ...key("9A"), ...loud(-12) });
  const far = track({ title: "far", bpm: 90, ...key("3B"), ...loud(-20) });
  const lone = track({ title: "lone", bpm: null });
  const byId = new Map([near, step, far, lone].map(t => [t.id, t]));
  const order = (ids: string[], from?: typeof anchor) => smartOrder(ids, id => byId.get(id), from);

  it("follows the anchor with the best fit each time", () => {
    expect(order(["far", "step", "near"], anchor)).toEqual(["near", "step", "far"]);
  });

  it("keeps the first item first without an anchor", () => {
    expect(order(["far", "near", "step"])).toEqual(["far", "near", "step"].slice(0, 1).concat(order(["near", "step"], far)));
  });

  it("puts tracks it knows nothing about last, and is stable", () => {
    const result = order(["ghost", "far", "near"], anchor);
    expect(result).toEqual(["near", "far", "ghost"]);
    expect(order(["ghost", "far", "near"], anchor)).toEqual(result);
  });

  it("returns every item exactly once", () => {
    const all = order(["lone", "far", "step", "near", "ghost"], anchor);
    expect([...all].sort()).toEqual(["far", "ghost", "lone", "near", "step"]);
  });
});

describe("bending a plan to the moment", () => {
  const from = track({ title: "from", bpm: 120, duration: 240, ...key("8A") });
  const plan = autoPlan(from, track({ title: "to", bpm: 120, ...key("8A") }));

  it("leaves a plan that fits untouched", () => {
    const fit = fitPlanFrom(plan, from, 100);
    expect(fit.trimmed).toBe(false);
    expect(fit.plan).toBe(plan);
  });

  it("halves the blend until it fits what is left of the track", () => {
    const fit = fitPlanFrom({ ...plan, bars: 16 }, from, 225);
    expect(fit.trimmed).toBe(true);
    expect(fit.plan.bars).toBeLessThan(16);
    expect(225 + 0.6 + spanOn(from, fit.plan.bars)).toBeLessThanOrEqual(from.duration);
    expect(fit.plan.notes?.at(-1)).toMatch(/cut to/);
  });

  it("never goes under one bar", () => {
    expect(fitPlanFrom({ ...plan, bars: 8 }, from, 239.9).plan.bars).toBe(1);
  });

  it("makes a skip quick: at most 4 bars", () => {
    expect(skipPlan({ ...plan, bars: 16 }, from, 10).bars).toBe(4);
    expect(skipPlan({ ...plan, bars: 2 }, from, 10).bars).toBe(2);
  });
});
