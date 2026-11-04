import { OfflineAudioContext } from "node-web-audio-api";
import { describe, expect, it } from "vitest";
import { ANALYSIS_VERSION } from "@/lib/analyze";
import { renderMix, sine, toneLevel } from "@/lib/mix-render";
import { track } from "@/lib/test-tracks";
import {
  PRESETS, effectAt, effectOf, lowOf, presetOf, seedCurve, shapeOfPlan, stemsOf, volumeAt, volumeOf,
} from "@/lib/transition";
import { DEFAULT_SMART_STYLE, planTransition, withStyle } from "@/lib/transition-planner";
import type { Track, TransitionEffect, VolumeCurve } from "@/lib/types";

const PRESET_CURVES: VolumeCurve[] = ["smooth", "linear", "scurve", "overlap", "early", "late", "fade", "cut"];

describe("preset volume curves", () => {
  it.each(PRESET_CURVES)("%s starts on the old track and ends on the new one", curve => {
    const start = volumeAt(curve, 0), end = volumeAt(curve, 1);
    expect(start.out).toBeCloseTo(1, 9); expect(start.in).toBeCloseTo(0, 9);
    expect(end.out).toBeCloseTo(0, 9); expect(end.in).toBeCloseTo(1, 9);
  });

  it.each(PRESET_CURVES.filter(c => c !== "cut"))("%s never jumps", curve => {
    let last = volumeAt(curve, 0);
    for (let i = 1; i <= 1000; i++) {
      const v = volumeAt(curve, i / 1000);
      expect(Math.abs(v.out - last.out)).toBeLessThan(0.012);
      expect(Math.abs(v.in - last.in)).toBeLessThan(0.012);
      last = v;
    }
  });

  it("cuts on the swap point over a few hundredths, not in one sample", () => {
    expect(volumeOf({ volume: "cut", eqAt: 0.7 }, 0.65)).toEqual({ out: 1, in: 0 });
    const after = volumeOf({ volume: "cut", eqAt: 0.7 }, 0.75);
    expect(after.out).toBeCloseTo(0, 9); expect(after.in).toBeCloseTo(1, 9);
    expect(volumeOf({ volume: "cut", eqAt: 0.7 }, 0.7).out).toBeGreaterThan(0.5);
  });

  it("reads an old plan, with no custom points, as its preset", () => {
    for (const curve of ["smooth", "overlap", "fade"] as const) {
      for (let i = 0; i <= 20; i++) expect(volumeOf({ volume: curve }, i / 20)).toEqual(volumeAt(curve, i / 20));
    }
    expect(presetOf({ volume: "smooth", eq: "bass", effect: "lowpass" })).toBe("auto");
    expect(presetOf({ volume: "fade", eq: "none", effect: "none", stems: "none" })).toBe("fade");
  });
});

describe("custom volume curves", () => {
  const curve = { out: [{ t: 0.5, g: 0.2 }], in: [{ t: 0.3, g: 0.9 }] };
  it("keeps the fixed ends and passes through every point", () => {
    const plan = { volume: "custom" as const, curve };
    expect(volumeOf(plan, 0)).toEqual({ out: 1, in: 0 });
    expect(volumeOf(plan, 1)).toEqual({ out: 0, in: 1 });
    expect(volumeOf(plan, 0.5).out).toBeCloseTo(0.2, 9);
    expect(volumeOf(plan, 0.3).in).toBeCloseTo(0.9, 9);
  });

  it("is smooth between the points", () => {
    const plan = { volume: "custom" as const, curve };
    let last = volumeOf(plan, 0);
    for (let i = 1; i <= 1000; i++) {
      const v = volumeOf(plan, i / 1000);
      expect(Math.abs(v.out - last.out)).toBeLessThan(0.01);
      expect(Math.abs(v.in - last.in)).toBeLessThan(0.01);
      last = v;
    }
  });

  it("seeds editable points that follow the preset it starts from", () => {
    const seeded = seedCurve("overlap");
    for (const p of seeded.out) expect(volumeOf({ volume: "custom", curve: seeded }, p.t).out).toBeCloseTo(volumeAt("overlap", p.t).out, 9);
  });

  it("plays what it draws: the outgoing deck sits at the point's gain on the audio thread", async () => {
    const RATE = 22050, AMP = 0.3, GAIN = 0.82 * 0.9;
    const { out } = await renderMix(OfflineAudioContext, {
      sampleRate: RATE, seconds: 16, a: sine(220, AMP, 16, RATE), b: sine(330, AMP, 16, RATE),
      plan: { volume: "custom", curve: { out: [{ t: 0.5, g: 0.25 }], in: [{ t: 0.5, g: 0.1 }] }, eq: "none", effect: "none", stems: "none" },
      start: 2, duration: 12,
    });
    // t = 0.5 at 8 s: the cosine ease is flat on a point, so a short window reads the point's own gain.
    expect(toneLevel(out, RATE, 220, 7.9, 8.1) / (AMP * GAIN)).toBeCloseTo(0.25, 1);
    expect(toneLevel(out, RATE, 330, 7.9, 8.1) / (AMP * GAIN)).toBeCloseTo(0.1, 1);
  });
});

describe("eq and effect shaping", () => {
  it("swaps the bass where the plan says", () => {
    expect(lowOf({ eq: "bass", eqAt: 0.3 }, 0.2)).toEqual({ out: -0, in: -24 });
    expect(lowOf({ eq: "bass", eqAt: 0.3 }, 0.4)).toEqual({ out: -24, in: -0 });
    expect(lowOf({ eq: "gradual" }, 1).out).toBeCloseTo(-24, 9);
    expect(lowOf({ eq: "gradual" }, 0).in).toBeCloseTo(-24, 9);
  });

  const effects: TransitionEffect[] = ["lowpass", "hpout", "rise", "lpin", "swap", "echo", "dub", "reverb", "flanger"];
  it.each(effects)("%s scales with intensity and stays in range", effect => {
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      expect(effectOf({ effect }, t)).toEqual(effectAt(effect, t));
      const zero = effectOf({ effect, intensity: 0 }, t);
      expect(Math.abs(zero.outColor) + Math.abs(zero.inColor) + zero.amount + zero.wash).toBe(0);
      const hot = effectOf({ effect, intensity: 1.5 }, t);
      expect(Math.abs(hot.outColor)).toBeLessThanOrEqual(1); expect(Math.abs(hot.inColor)).toBeLessThanOrEqual(1);
      expect(hot.amount).toBeLessThanOrEqual(1);
    }
  });
});

describe("stem moves", () => {
  it("leaves every stem alone without a move", () => {
    expect(stemsOf({ stems: "none" }, 0.5)).toEqual({ out: [1, 1, 1, 1], in: [1, 1, 1, 1] });
  });
  it("a full stem blend hands every part over and leaves the new track whole", () => {
    const end = stemsOf({ stems: "full" }, 1), start = stemsOf({ stems: "full" }, 0);
    expect(end.out[0]).toBe(0); expect(end.out[1]).toBe(0); expect(end.out[2]).toBe(0);
    expect(end.in).toEqual([1, 1, 1, 1]);
    expect(start.in[0]).toBe(0); expect(start.in[2]).toBe(0); expect(start.in[1]).toBe(1);
  });
  it("an acapella over keeps the old voice and the new beat, then brings the new voice in", () => {
    const mid = stemsOf({ stems: "acapella" }, 0.6);
    expect(mid.out).toEqual([1, 0, 0, 0]);
    expect(mid.in[0]).toBe(0); expect(mid.in[1]).toBe(1);
    expect(stemsOf({ stems: "acapella" }, 1).in[0]).toBe(1);
  });
});

describe("AutoMix style over the planner", () => {
  const full = (patch: Partial<Track> = {}) => track({
    bpm: 124, pulse: 8, loudness: -10, lufs: -10, duration: 240, camelot: "8A", key: "Am", keyClarity: 0.2, analysis: ANALYSIS_VERSION,
    energy: Array.from({ length: 240 }, (_, s) => s < 32 ? -30 : s < 208 ? -10 : -25),
    bands: { low: Array.from({ length: 240 }, (_, s) => s < 32 ? -40 : s < 208 ? -12 : -30), mid: [], high: [] }, ...patch,
  });
  const a = full({ title: "Out" }), b = full({ id: "b", title: "In", bpm: 124.5 });

  it("leaves the plan alone with the default style", () => {
    const r = planTransition(a, b);
    expect(withStyle(r, a, b, DEFAULT_SMART_STYLE)).toBe(r);
  });

  it("lays a saved template and the overrides over the planner's placement", () => {
    const r = planTransition(a, b);
    const template = shapeOfPlan({ ...r.plan, volume: "custom", curve: { out: [{ t: 0.4, g: 0.6 }], in: [] }, eq: "gradual", effect: "dub", intensity: 1.2 });
    const styled = withStyle(r, a, b, { ...DEFAULT_SMART_STYLE, template, effect: "flanger" });
    expect(styled.plan.outAt).toBe(r.plan.outAt);
    expect(styled.plan.bars).toBe(r.plan.bars);
    expect(styled.plan.volume).toBe("custom");
    expect(styled.plan.curve?.out[0].g).toBe(0.6);
    expect(styled.plan.eq).toBe("gradual");
    expect(styled.plan.effect).toBe("flanger");
    expect(styled.plan.score).toBe(styled.score);
  });

  it("falls back to an eq bass swap when a stem move has no stems to move", () => {
    const r = planTransition(a, b);
    const styled = withStyle(r, a, b, { ...DEFAULT_SMART_STYLE, stems: "full", eq: "none" });
    expect(styled.plan.stems).toBe("none");
    expect(styled.plan.eq).toBe("bass");
  });

  it("keeps every preset's stems to tracks that have them", () => {
    expect(Object.values(PRESETS).filter(p => p.stems).every(p => p.stems === "full")).toBe(true);
  });
});
