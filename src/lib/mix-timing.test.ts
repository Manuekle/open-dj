import { describe, expect, it } from "vitest";
import { UNLOCKED_MAX_RATE_DEVIATION, rateCents } from "@/lib/drift";
import { track } from "@/lib/test-tracks";
import { foldMultiple, planRatio, spanOn } from "@/lib/transition";

/* The arithmetic a blend is scheduled by: how long it takes in context seconds, where the incoming media is when it ends,
   and whether the two tracks land on the same beat count over it. */

const cases: [string, number, number][] = [["120 into 124 bpm", 120, 124], ["124 into 120 bpm", 124, 120], ["64 into 128 bpm", 64, 128], ["128 into 64 bpm", 128, 64]];

describe.each(cases)("%s", (_name, outBpm, inBpm) => {
  const from = track({ bpm: outBpm }), to = track({ bpm: inBpm });
  it.each([16, 32])("lands both tracks on the same number of beats over %i bars, at any outgoing rate", bars => {
    for (const fromRate of [1, 0.97, 1.04]) {
      const k = planRatio({}, from, to, fromRate, 1);
      const rateIn = k * fromRate;
      const span = spanOn(from, bars);
      const real = span / fromRate; // context seconds the blend takes
      const beatsOut = real * outBpm * fromRate / 60;
      const beatsIn = real * inBpm * foldMultiple(outBpm, inBpm) * rateIn / 60;
      expect(beatsIn).toBeCloseTo(beatsOut, 6);
      // The incoming media advances by span x k over the blend, which is where the next scheduling lands its end.
      expect(span * k).toBeCloseTo(real * rateIn, 6);
    }
  });

  it("changes the incoming deck by no more than a stretcher renders well, pitch kept or not", () => {
    const rate = planRatio({}, from, to, 1, 1);
    expect(rate).toBeGreaterThan(0.94);
    expect(rate).toBeLessThan(1.07);
    // Without a pitch lock this much would be a pitch shift of up to ~70 cents, which mix() refuses.
    if (Math.abs(rate - 1) > UNLOCKED_MAX_RATE_DEVIATION) expect(Math.abs(rateCents(rate))).toBeGreaterThan(26);
  });
});

describe("blend length in context seconds", () => {
  it("is the outgoing track's bars over its rate", () => {
    const t = track({ bpm: 120 });
    expect(spanOn(t, 16) / 1).toBeCloseTo(32, 9);
    expect(spanOn(t, 32) / 1).toBeCloseTo(64, 9);
    expect(spanOn(t, 32) / 1.02).toBeCloseTo(62.745, 2);
    expect(spanOn(track({ bpm: 64 }), 16) ).toBeCloseTo(60, 9);
  });
  it("leaves an unmatched blend at the incoming deck's own rate", () => {
    expect(planRatio({ sync: false }, track({ bpm: 120 }), track({ bpm: 124 }), 1, 1.02)).toBeCloseTo(1.02, 9);
  });
});
