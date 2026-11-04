import { describe, expect, it } from "vitest";
import { ANALYSIS_VERSION } from "@/lib/analyze";
import { track } from "@/lib/test-tracks";
import { autoPlan, planRatio, snapToBar, spanOn } from "@/lib/transition";
import {
  CRITERIA, DEFAULT_WEIGHTS, STRATEGIES, STRATEGY, analysisConfidence, pairOf, planTransition, scorePlan, weightsOf,
  type PlannerResult,
} from "@/lib/transition-planner";
import type { Track, TransitionPlan } from "@/lib/types";

/** 240 s with a quiet intro to 32 s, the body at -10 dB, a quieter outro from 208 s; the low band follows the same shape.
    A clear beat (pulse 8), a clear key and the current analysis, so only what a test changes is in question. */
const full = (patch: Partial<Track> = {}) => track({
  bpm: 124, pulse: 8, loudness: -10, lufs: -10, duration: 240, camelot: "8A", key: "Am", keyClarity: 0.2, analysis: ANALYSIS_VERSION,
  energy: Array.from({ length: 240 }, (_, s) => s < 32 ? -30 : s < 208 ? -10 : -25),
  bands: { low: Array.from({ length: 240 }, (_, s) => s < 32 ? -40 : s < 208 ? -12 : -30), mid: [], high: [] },
  ...patch,
});
const pair = (a: Partial<Track> = {}, b: Partial<Track> = {}) => [full({ title: "Out", ...a }), full({ title: "In", ...b })] as const;
const plan = (a: Partial<Track> = {}, b: Partial<Track> = {}, options = {}) => planTransition(...pair(a, b), options);
const notes = (r: PlannerResult) => (r.plan.notes ?? []).join(" ");

describe("candidates", () => {
  const r = plan({}, { bpm: 124.5 });

  it("builds many candidates across strategies, with unique ids", () => {
    const strategies = new Set(r.candidates.map(c => c.strategy));
    expect(r.candidates.length).toBeGreaterThan(10);
    expect(strategies.size).toBeGreaterThanOrEqual(5);
    expect(new Set(r.candidates.map(c => c.id)).size).toBe(r.candidates.length);
  });

  it("keeps every playable candidate inside both tracks and on the bar grid", () => {
    const [from, to] = pair();
    for (const c of r.candidates.filter(c => c.eligible)) {
      expect(c.outAt).toBeGreaterThanOrEqual(0);
      expect(c.inAt).toBeGreaterThanOrEqual(0);
      expect(c.outAt + spanOn(from, c.bars)).toBeLessThanOrEqual(from.duration + 1e-6);
      expect(c.inAt + spanOn(to, c.bars)).toBeLessThanOrEqual(to.duration + 1e-6);
      expect(snapToBar(from, c.outAt)).toBeCloseTo(c.outAt, 6);
    }
  });

  it("scores 0..100 and keeps confidence apart, 0..1", () => {
    for (const c of r.candidates) {
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(100);
      expect(c.confidence).toBeGreaterThanOrEqual(0);
      expect(c.confidence).toBeLessThanOrEqual(1);
      expect(c.plan.score).toBe(c.score);
      expect(c.plan.confidence).toBe(c.confidence);
    }
  });

  it("decides the same way every time", () => {
    expect(plan({}, { bpm: 126 })).toEqual(plan({}, { bpm: 126 }));
  });

  it("puts the DJ's own points among the candidates", () => {
    const anchored = plan({}, { bpm: 124.5 }, { anchors: { outAt: 180, inAt: 8 } });
    expect(anchored.candidates.some(c => c.out === "anchor" && c.outAt === 180)).toBe(true);
    expect(anchored.candidates.some(c => c.in === "anchor" && c.inAt === 8)).toBe(true);
  });
});

describe("strategies", () => {
  it("Smooth Blend: matching keys, a tempo that barely moves", () => {
    const r = plan({}, { bpm: 124.5 });
    expect(r.selected.strategy).toBe("smooth-blend");
    expect(r.plan).toMatchObject({ bars: 16, volume: "smooth", effect: "none", strategy: "smooth-blend", by: "auto" });
    expect(r.plan.sync).toBeUndefined();
    expect(r.fallback).toBeNull();
  });

  it("Beatmatch: a 6% tempo change, too far for a 16-bar blend", () => {
    const r = plan({}, { bpm: 131.4 });
    expect(r.selected.strategy).toBe("beatmatch");
    expect(r.plan).toMatchObject({ eq: "bass", volume: "smooth", effect: "none" });
    expect(r.plan.bars).toBeLessThanOrEqual(8);
    expect(r.candidates.find(c => c.strategy === "smooth-blend")?.rejected.join(" ")).toMatch(/over the 4\.0% Smooth Blend stretches/);
  });

  it("Energy Boost: the heard level rises into the new track", () => {
    // After the load trims, the outgoing body sits 2 dB under target and the incoming one 2 dB over it.
    const r = plan({ lufs: -8 }, { lufs: -12 });
    expect(r.selected.strategy).toBe("energy-boost");
    expect(r.plan).toMatchObject({ volume: "overlap", effect: "rise", eq: "bass" });
    expect(r.selected.criteria.energy.note).toMatch(/rises/);
  });

  it("EQ Transition: clashing keys get the filter swap", () => {
    const r = plan({}, { camelot: "3B", key: "D" });
    expect(r.selected.strategy).toBe("eq-transition");
    expect(r.plan).toMatchObject({ eq: "bass", effect: "swap" });
  });

  it("Quick Cut: a 12% tempo change keeps the incoming tempo and echoes out", () => {
    const r = plan({ bpm: 120 }, { bpm: 134.4 });
    expect(r.selected.strategy).toBe("quick-cut");
    expect(r.plan).toMatchObject({ sync: false, volume: "fade", effect: "echo", eq: "none" });
    expect(r.plan.bars).toBeLessThanOrEqual(2);
  });

  it("Quick Cut keeps tempo sync on a near tempo", () => {
    const r = plan({}, { bpm: 124.5 }, { strategy: "quick-cut" });
    expect(r.selected.strategy).toBe("quick-cut");
    expect(r.plan.sync).toBeUndefined();
    expect(r.plan.volume).toBe("overlap");
  });

  it("Smart Fallback: no tempo on one side, a plain crossfade off the grid", () => {
    const r = plan({}, { bpm: null, title: "Loose" });
    expect(r.selected.strategy).toBe("fallback");
    expect(r.plan).toMatchObject({ volume: "smooth", eq: "none", effect: "none", sync: false, stems: "none" });
    expect(r.fallback).toMatch(/No other strategy/);
    expect(notes(r)).toMatch(/No tempo estimate for Loose/);
  });

  it("gives each strategy a label and a summary", () => {
    for (const s of STRATEGIES) { expect(STRATEGY[s].label).toBeTruthy(); expect(STRATEGY[s].summary).toBeTruthy(); }
  });
});

describe("incompatible candidates", () => {
  it("never chooses a candidate that breaks a hard limit", () => {
    for (const r of [plan({}, { bpm: 131.4 }), plan({}, { camelot: "3B" }), plan({ bpm: 100 }, { bpm: 128 }), plan({}, { bpm: null })]) {
      expect(r.selected.rejected).toEqual([]);
      expect(r.selected.eligible).toBe(true);
    }
  });

  it("keeps Smooth Blend off clashing, unknown or guessed keys", () => {
    const why = (r: PlannerResult) => r.candidates.find(c => c.strategy === "smooth-blend")!.rejected.join(" ");
    expect(why(plan({}, { camelot: "3B" }))).toMatch(/keys that clash/);
    expect(why(plan({ camelot: undefined }, {}))).toMatch(/not analyzed/);
    expect(why(plan({ keyClarity: 0.01 }, {}))).toMatch(/a guess/);
  });

  it("keeps Energy Boost off a point where the level does not rise", () => {
    // Out where the body ends, in as the new body arrives: level. (Out at the very end, after the quiet outro, the
    // level does rise into the new body, and that placement is allowed.)
    const r = planTransition(...pair({}, { bpm: 124.5 }), { strategy: "energy-boost", bars: 8 });
    const all = plan({}, { bpm: 124.5 }, { bars: 8 }).candidates;
    expect(all.find(c => c.id === "energy-boost:8:outro:main")).toBeUndefined();
    expect(r.candidates.filter(c => c.strategy === "energy-boost").every(c => c.out === "latest")).toBe(true);
    const level = scorePlan(...pair({}, { bpm: 124.5 }), { ...r.plan, outAt: all.find(c => c.id === "beatmatch:8:outro:main")!.outAt, inAt: all.find(c => c.id === "beatmatch:8:outro:main")!.inAt, strategy: "energy-boost" });
    expect(level.rejected.join(" ")).toMatch(/Energy Boost needs a rise in heard level/);
  });

  it("allows Energy Boost on a boost move up the Camelot wheel", () => {
    const r = plan({}, { camelot: "10A", key: "Bm" });
    expect(r.candidates.some(c => c.strategy === "energy-boost" && c.eligible)).toBe(true);
  });

  it("holds long locked blends off a weak beat grid", () => {
    const r = plan({ pulse: 3.4 }, { pulse: 3.4 });
    expect(r.selected.bars).toBeLessThanOrEqual(4);
    expect(r.candidates.find(c => c.strategy === "smooth-blend")!.rejected.join(" ")).toMatch(/Beat strength 3\.4/);
  });

  it("rejects every beat-matched strategy when tempo matching is off", () => {
    const r = plan({}, { bpm: 124.5 }, { tempo: "off" });
    for (const s of ["smooth-blend", "beatmatch", "energy-boost", "eq-transition"] as const) {
      expect(r.candidates.filter(c => c.strategy === s).every(c => !c.eligible)).toBe(true);
    }
    expect(r.plan.sync).toBe(false);
  });

  it("stretches at most 4% with gentle tempo matching", () => {
    const r = plan({}, { bpm: 129.6 }, { tempo: "gentle" });
    expect(r.candidates.filter(c => c.strategy === "beatmatch").every(c => !c.eligible)).toBe(true);
    expect(r.selected.strategy).toBe("quick-cut");
  });
});

describe("no tempo", () => {
  it("only Smart Fallback can play without a tempo on either track", () => {
    const r = plan({ bpm: null }, { bpm: null });
    expect(r.candidates.filter(c => c.eligible).every(c => c.strategy === "fallback")).toBe(true);
    for (const s of ["smooth-blend", "beatmatch", "energy-boost", "eq-transition", "quick-cut"] as const) {
      expect(r.candidates.find(c => c.strategy === s)!.rejected.join(" ")).toMatch(/needs a tempo estimate/);
    }
    expect(r.selected.criteria.tempo.status).toBe("n/a");
    expect(r.confidence.factors.find(f => f.name === "Tempo and beat grid")!.value).toBe(0);
  });

  it("times the crossfade in seconds and still reads the structure", () => {
    const r = plan({ bpm: null }, { bpm: null });
    expect(r.selected.criteria.structure.status).toBe("ok");
    expect(r.plan.outAt).toBeGreaterThan(120);
  });
});

describe("short tracks", () => {
  it("cuts quickly when nothing longer fits a 20 s track", () => {
    const r = plan({ duration: 20, energy: Array(20).fill(-10), bands: undefined }, { duration: 20, energy: Array(20).fill(-10), bands: undefined });
    expect(r.selected.strategy).toBe("quick-cut");
    expect(spanOn(full(), r.plan.bars)).toBeLessThanOrEqual(20 / 3);
    expect(r.candidates.find(c => c.strategy === "beatmatch")!.rejected.join(" ")).toMatch(/do not fit within a third of a 20\.0 s track/);
  });

  it("still plans a 4 s track, from inside it", () => {
    const tiny = { duration: 4, energy: [-10, -10, -10, -10], bands: undefined };
    const r = plan(tiny, tiny);
    expect(r.selected.strategy).toBe("fallback");
    expect(r.plan.bars).toBe(1);
    expect(r.plan.outAt).toBeGreaterThanOrEqual(0);
    expect(r.plan.inAt).toBeGreaterThanOrEqual(0);
  });
});

describe("fallback", () => {
  it("takes Smart Fallback when the best score is under the minimum", () => {
    const r = plan({}, { bpm: 124.5 }, { minScore: 101 });
    expect(r.selected.strategy).toBe("fallback");
    expect(r.fallback).toMatch(/Smooth Blend at \d+\/100, is under the 101 minimum/);
    expect(notes(r)).toMatch(/under the 101 minimum/);
  });

  it("takes Smart Fallback when the analysis cannot be trusted", () => {
    // A tempo and nothing else: no key, no loudness series, no bands, no pulse, an unknown analysis version.
    const bare = { camelot: undefined, key: undefined, keyClarity: undefined, energy: undefined, bands: undefined, pulse: undefined, analysis: undefined };
    const r = plan(bare, bare);
    expect(r.confidence.level).toBe("low");
    expect(r.selected.strategy).toBe("fallback");
    expect(r.fallback).toMatch(/Analysis confidence \d+% is under the 30% minimum/);
    // Known tempo and a beat grid not proven weak: the fallback stays beat-matched with little overlap.
    expect(r.plan).toMatchObject({ volume: "fade", eq: "none" });
  });

  it("falls back, and says why, when a chosen strategy cannot play", () => {
    const r = plan({}, { bpm: null }, { strategy: "beatmatch" });
    expect(r.selected.strategy).toBe("fallback");
    expect(r.fallback).toMatch(/Beatmatch was chosen, but it cannot play this pair/);
    expect(r.reasons.join(" ")).toMatch(/needs a tempo estimate/);
  });

  it("plays a chosen strategy that can, even under the minimum score", () => {
    const r = plan({}, { bpm: 124.5 }, { strategy: "eq-transition", minScore: 101 });
    expect(r.selected.strategy).toBe("eq-transition");
    expect(r.fallback).toBeNull();
  });

  it("honours a length chosen by hand", () => {
    expect(plan({}, { bpm: 124.5 }, { bars: 4 }).plan.bars).toBe(4);
  });
});

describe("score and confidence", () => {
  it("leaves out what the analysis does not have instead of guessing it", () => {
    const r = plan({ bands: undefined }, { bands: undefined, bpm: 124.5 });
    const bass = r.selected.criteria.bass;
    expect(bass).toMatchObject({ status: "missing", value: null, weight: 0 });
    expect(notes(r)).toMatch(/left out of the score: bass/);
  });

  it("lowers confidence, not the score, as analysis goes missing", () => {
    const [a, b] = pair({}, { bpm: 124.5 });
    const rich = analysisConfidence(pairOf(a, b));
    const poor = analysisConfidence(pairOf({ ...a, bands: undefined, keyClarity: 0.02 }, { ...b, bands: undefined }));
    expect(rich.value).toBe(1);
    expect(rich.level).toBe("high");
    expect(poor.value).toBeLessThan(rich.value);
  });

  it("weights a guessed key down in the score", () => {
    const clear = plan({}, { camelot: "3B" }).candidates.find(c => c.id.startsWith("beatmatch:8:outro"))!;
    const guessed = plan({ keyClarity: 0.01 }, { camelot: "3B", keyClarity: 0.01 }).candidates.find(c => c.id.startsWith("beatmatch:8:outro"))!;
    expect(guessed.criteria.harmony.weight).toBeLessThan(clear.criteria.harmony.weight);
    expect(guessed.score).toBeGreaterThan(clear.score);
  });

  it("takes weights from the options, and ignores bad ones", () => {
    expect(weightsOf({ harmony: -1, tempo: Number.NaN })).toMatchObject({ harmony: 0, tempo: 0 });
    expect(weightsOf(Object.fromEntries(CRITERIA.map(k => [k, 0])))).toEqual(DEFAULT_WEIGHTS);
    // With harmony weighted out, a clash no longer costs a Beatmatch anything.
    const r = plan({}, { camelot: "3B" }, { weights: { harmony: 0 } });
    const beat = r.candidates.find(c => c.id.startsWith("beatmatch:8:outro"))!;
    expect(beat.criteria.harmony.weight).toBe(0);
    expect(r.weights.harmony).toBe(0);
    for (const c of r.candidates) expect(c.score).toBeLessThanOrEqual(100);
  });

  it("aims the energy criterion where the flow option says", () => {
    const build = plan({ lufs: -8 }, { lufs: -12 }, { energy: "build" });
    const relax = plan({ lufs: -8 }, { lufs: -12 }, { energy: "relax" });
    const id = "beatmatch:8:outro:main";
    expect(build.candidates.find(c => c.id === id)!.criteria.energy.value!).toBeGreaterThan(relax.candidates.find(c => c.id === id)!.criteria.energy.value!);
  });

  it("never claims sections it does not detect", () => {
    for (const r of [plan({}, { bpm: 124.5 }), plan({ bpm: null }, { bpm: null }), plan({}, { camelot: "3B" })]) {
      for (const c of r.candidates) expect((c.plan.notes ?? []).join(" ")).not.toMatch(/chorus|verse|\bdrop\b|downbeat|phrase boundary/i);
    }
  });
});

describe("plans made elsewhere", () => {
  const [from, to] = pair({}, { bpm: 124.5 });

  it("rates a saved plan from before the planner", () => {
    const old: TransitionPlan = { fromId: from.id, toId: to.id, outAt: 200, inAt: 0, bars: 8, volume: "smooth", eq: "bass", effect: "flanger", preset: "auto" };
    const e = scorePlan(from, to, old);
    expect(e.strategy).toBe("eq-transition");
    expect(e.score).toBeGreaterThan(0);
    expect(e.score).toBeLessThanOrEqual(100);
  });

  it("rates the rule-based autoPlan, and a plan with points the DJ dragged", () => {
    const auto = autoPlan(from, to);
    const moved = { ...auto, outAt: 120 };
    expect(scorePlan(from, to, moved).criteria.structure.value!).toBeLessThan(scorePlan(from, to, auto).criteria.structure.value!);
  });

  it("reports hard limits of a plan the DJ made as warnings", () => {
    const loose = full({ bpm: 100 });
    const e = scorePlan(loose, full({ bpm: 128 }), { fromId: "a", toId: "b", outAt: 200, inAt: 0, bars: 16, volume: "smooth", eq: "none", effect: "none", preset: "custom" });
    expect(e.rejected.join(" ")).toMatch(/tempo moves/);
  });
});

describe("tempo sync in the engine", () => {
  const a = full({ bpm: 120 }), b = full({ bpm: 126 });
  it("matches tempo for a plan that does not say otherwise", () => {
    expect(planRatio({}, a, b, 1, 1)).toBeCloseTo(120 / 126, 6);
  });
  it("leaves the incoming deck at its own rate when sync is off", () => {
    expect(planRatio({ sync: false }, a, b, 1, 1)).toBe(1);
    expect(planRatio({ sync: false }, a, b, 1.02, 1)).toBeCloseTo(1 / 1.02, 9);
  });
});
