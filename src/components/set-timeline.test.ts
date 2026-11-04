import { describe, expect, it } from "vitest";
import { track } from "@/lib/test-tracks";
import { spanOn } from "@/lib/transition";
import type { TransitionPlan } from "@/lib/types";
import { layoutSet } from "./set-timeline";

const plan = (over: Partial<TransitionPlan>): TransitionPlan => ({
  fromId: "a", toId: "b", outAt: 200, inAt: 16, bars: 8, volume: "smooth", eq: "none", effect: "none", preset: "blend", ...over,
});

describe("the set on one clock", () => {
  it("starts the playing track at its own time 0 and brings each next one in at the out point before it", () => {
    const a = track({ id: "a", bpm: 120, duration: 240 }), b = track({ id: "b", bpm: 120, duration: 300 }), c = track({ id: "c", bpm: 120, duration: 180 });
    const s = layoutSet([
      { track: a, uid: null, plan: plan({ outAt: 200, inAt: 16, bars: 8 }) },
      { track: b, uid: null, plan: plan({ fromId: "b", toId: "c", outAt: 260, inAt: 0, bars: 4 }) },
      { track: c, uid: null, plan: null },
    ]);
    expect(s[0]).toEqual({ start: 0, outStart: 200, end: 200 + spanOn(a, 8), enter: 0 });
    // b is heard from its in point (16 s) when a reaches its out point, and leaves at its own out point (260 s).
    expect(s[1].start).toBe(200);
    expect(s[1].outStart).toBe(200 + (260 - 16));
    expect(s[1].end).toBe(s[1].outStart + spanOn(b, 4));
    // The last track plays to its end.
    expect(s[2].start).toBe(s[1].outStart);
    expect(s[2].end).toBe(s[2].start + 180);
  });

  it("gives a stale plan whose out point is before the in point a short body instead of running backwards", () => {
    const a = track({ id: "a", duration: 240 }), b = track({ id: "b", duration: 240 });
    const s = layoutSet([{ track: a, uid: null, plan: plan({ inAt: 100 }) }, { track: b, uid: null, plan: plan({ outAt: 50 }) }, { track: a, uid: null, plan: null }]);
    expect(s[1].outStart).toBeGreaterThan(s[1].start);
  });
});
