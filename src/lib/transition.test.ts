import { describe, expect, it } from "vitest";
import { camelotOf } from "@/lib/analyze";
import { track } from "@/lib/test-tracks";
import {
  autoPlan, foldMultiple, harmony, mainEntry, outroStart, snapToBar, spanOn, syncRate, tempoGap, tempoRatio, volumeAt,
  type Harmony,
} from "@/lib/transition";
import type { VolumeCurve } from "@/lib/types";

describe("tempo matching", () => {
  it("stretches a near tempo by the ratio", () => {
    expect(syncRate(128, 124)).toBeCloseTo(128 / 124, 6);
    expect(tempoGap(track({ bpm: 124 }), track({ bpm: 128 }))).toBeCloseTo(128 / 124 - 1, 6);
  });

  it("folds half and double time instead of stretching", () => {
    expect(foldMultiple(128, 64)).toBe(2);
    expect(foldMultiple(85, 170)).toBe(0.5);
    expect(foldMultiple(128, 126)).toBe(1);
    expect(syncRate(128, 64)).toBe(1);
    expect(syncRate(85, 172)).toBeCloseTo(170 / 172, 6);
    expect(tempoGap(track({ bpm: 128 }), track({ bpm: 64 }))).toBe(0);
  });

  it("gives the editor and the engine the same folded ratio", () => {
    // Before the fold this clamped to 1.25 and played a 64 bpm track 25% fast against a 128 bpm one.
    expect(tempoRatio(track({ bpm: 128 }), track({ bpm: 64 }))).toBe(1);
    expect(tempoRatio(track({ bpm: 126 }), track({ bpm: 63 }), 1.02)).toBeCloseTo(1, 6);
  });

  it("holds a rate the deck cannot reach to its range", () => {
    expect(syncRate(140, 100)).toBe(1.25);
    expect(syncRate(100, 140)).toBe(0.75);
  });

  it("does not match without a tempo", () => {
    expect(tempoRatio(track({ bpm: null }), track())).toBe(1);
    expect(tempoGap(track(), track({ bpm: null }))).toBeNull();
  });
});

describe("harmonic compatibility", () => {
  const cases: [string | undefined, string | undefined, Harmony][] = [
    ["8A", "8A", "same"], ["8A", "9A", "adjacent"], ["12A", "1A", "adjacent"], ["1B", "12B", "adjacent"],
    ["8A", "8B", "relative"], ["8A", "10A", "boost"], ["8A", "3A", "boost"], ["8A", "3B", "clash"], ["8A", "5A", "clash"],
    [undefined, "8A", "unknown"], ["8A", "x", "unknown"],
  ];
  it.each(cases)("%s into %s is %s", (a, b, want) => expect(harmony(a, b)).toBe(want));

  it("places keys on the Camelot wheel", () => {
    expect(camelotOf(9, true)).toBe("8A"); // A minor
    expect(camelotOf(0, false)).toBe("8B"); // C major
    expect(camelotOf(7, false)).toBe("9B"); // G major
    expect(camelotOf(4, true)).toBe("9A"); // E minor
  });
});

describe("volume curves", () => {
  const curves: VolumeCurve[] = ["smooth", "overlap", "fade"];
  it.each(curves)("%s starts on the old track and ends on the new one", curve => {
    expect(volumeAt(curve, 0)).toEqual({ out: 1, in: 0 });
    const end = volumeAt(curve, 1);
    expect(end.out).toBeCloseTo(0, 9);
    expect(end.in).toBeCloseTo(1, 9);
  });

  it.each(curves)("%s never jumps", curve => {
    let last = volumeAt(curve, 0);
    for (let i = 1; i <= 1000; i++) {
      const v = volumeAt(curve, i / 1000);
      expect(Math.abs(v.out - last.out)).toBeLessThan(0.01);
      expect(Math.abs(v.in - last.in)).toBeLessThan(0.01);
      last = v;
    }
  });

  it("keeps the power constant across a smooth blend", () => {
    for (let i = 0; i <= 100; i++) {
      const v = volumeAt("smooth", i / 100);
      expect(v.out ** 2 + v.in ** 2).toBeCloseTo(1, 9);
    }
  });
});

/** 240 s at 120 bpm (2 s bars): a quiet intro to 32 s, the body at -10 dB, a quieter outro from 208 s. */
const shaped = (patch = {}) => track({
  bpm: 120, loudness: -10, duration: 240,
  energy: Array.from({ length: 240 }, (_, s) => s < 32 ? -30 : s < 208 ? -10 : -25), ...patch,
});

describe("mix points", () => {
  it("snaps to bar lines, and leaves a track with no grid alone", () => {
    expect(snapToBar(track({ bpm: 120, firstBeat: 0.5 }), 10.7)).toBeCloseTo(10.5, 9);
    expect(snapToBar(track({ bpm: 120, firstBeat: 0.5 }), 11.8)).toBeCloseTo(12.5, 9);
    expect(snapToBar(track({ bpm: null, firstBeat: 0.5 }), 10.7)).toBe(10.7);
  });

  it("leaves the outgoing track as its body ends, on a bar, with room to finish", () => {
    const from = shaped(), at = outroStart(from, 8);
    expect(at % 2).toBeCloseTo(0, 9);
    expect(at).toBeGreaterThanOrEqual(200);
    expect(at).toBeLessThanOrEqual(208);
    expect(at + spanOn(from, 8)).toBeLessThanOrEqual(from.duration);
  });

  it("brings the incoming body in as the blend ends", () => {
    const to = shaped(), at = mainEntry(to, 8);
    expect(at % 2).toBeCloseTo(0, 9);
    expect(Math.abs(at + spanOn(to, 8) - 32)).toBeLessThanOrEqual(2);
  });

  it("falls back to the last bar that fits when the quiet part is a breakdown", () => {
    // Loud only in the first half: an "outro" that early is a breakdown, not the end.
    const from = shaped({ energy: Array.from({ length: 240 }, (_, s) => s < 100 ? -10 : -30) });
    const at = outroStart(from, 8);
    expect(at).toBeGreaterThan(from.duration * 0.6);
    expect(at + spanOn(from, 8)).toBeLessThanOrEqual(from.duration);
  });
});

describe("autoPlan", () => {
  const key = (camelot: string) => ({ camelot, key: camelot });

  it("blends long when keys agree and the tempo barely moves", () => {
    const plan = autoPlan(shaped({ bpm: 124, ...key("8A") }), shaped({ bpm: 125, ...key("9A") }));
    expect(plan.bars).toBe(16);
    expect(plan.volume).toBe("smooth");
  });

  it("treats a half-time track as the same tempo", () => {
    const plan = autoPlan(shaped({ bpm: 128, ...key("8A") }), shaped({ bpm: 64, ...key("8A") }));
    expect(plan.bars).toBe(16);
    expect(plan.effect).not.toBe("echo");
  });

  it("echoes out over 2 bars when the tempo gap is too wide to stretch", () => {
    const plan = autoPlan(shaped({ bpm: 100, ...key("8A") }), shaped({ bpm: 128, ...key("8A") }));
    expect(plan.bars).toBe(2);
    expect(plan.effect).toBe("echo");
    expect(plan.eq).toBe("none");
  });

  it("hides clashing keys under a short filtered blend", () => {
    const plan = autoPlan(shaped({ ...key("8A") }), shaped({ ...key("3B") }));
    expect(plan.bars).toBe(4);
    expect(plan.effect).toBe("reverb");
  });

  it("crossfades plainly, off the grid, without a tempo", () => {
    const plan = autoPlan(shaped({ ...key("8A") }), shaped({ bpm: null, title: "Loose", ...key("8A") }));
    expect(plan.effect).toBe("none");
    expect(plan.eq).toBe("none");
    expect(plan.notes?.join(" ")).toMatch(/No tempo estimate for Loose/);
  });

  it("shortens the blend to fit a short track", () => {
    const short = track({ bpm: 120, duration: 30, energy: Array(30).fill(-10), loudness: -10, ...key("8A") });
    const plan = autoPlan(short, shaped({ bpm: 120, ...key("8A") }));
    expect(spanOn(short, plan.bars)).toBeLessThanOrEqual(10);
    expect(plan.outAt).toBeGreaterThanOrEqual(0);
    expect(plan.outAt + spanOn(short, plan.bars)).toBeLessThanOrEqual(short.duration);
    expect(plan.notes?.join(" ")).toMatch(/short track/);
  });

  it("never plans a point before the start of either track", () => {
    const tiny = track({ bpm: 120, duration: 4, energy: [-10, -10, -10, -10], loudness: -10 });
    const plan = autoPlan(tiny, tiny);
    expect(plan.outAt).toBeGreaterThanOrEqual(0);
    expect(plan.inAt).toBeGreaterThanOrEqual(0);
    expect(plan.bars).toBe(1);
  });

  it("decides the same way every time", () => {
    const a = shaped({ ...key("8A") }), b = shaped({ bpm: 126, ...key("9A") });
    expect(autoPlan(a, b)).toEqual(autoPlan(a, b));
  });
});
