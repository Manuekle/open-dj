import { describe, expect, it } from "vitest";
import { ClockMap } from "@/lib/clock";
import { DEFAULT_GOVERNOR, DriftGovernor, phaseReading, rateCents, type Decision } from "@/lib/drift";
import { noise } from "@/lib/test-tracks";
import { foldMultiple, syncRate } from "@/lib/transition";
import { LatencyTracker, MAX_PREROLL, MIN_PREROLL, prerollSeconds } from "@/lib/preroll";

/* The governor against simulated decks: two media clocks that advance in real time, a measurement with the noise a media
   element's currentTime has (a few ms of jitter, a coarse quantum, now and then a bad reading), and a hidden tempo error
   in the incoming deck, as a stretcher or a slightly wrong bpm leaves. */

type Sim = {
  outBpm: number; inBpm: number; outRate?: number; seconds: number; initial: number; epsilon?: number;
  audibleFrom?: number; jitter?: number; quantum?: number; spikes?: number; hz?: number;
};
function simulate(s: Sim, governor = new DriftGovernor()) {
  const random = noise(3);
  const hz = s.hz ?? 10, dt = 1 / hz, outRate = s.outRate ?? 1;
  const fold = foldMultiple(s.outBpm, s.inBpm);
  const base = syncRate(s.outBpm * outRate, s.inBpm);
  let tOut = 40, trim = 0;
  const out = { bpm: s.outBpm, firstBeat: 0.12 }, inn = { bpm: s.inBpm, firstBeat: 0.31 };
  // Put the incoming media where its beats sit `initial` seconds behind the outgoing ones.
  const outBeats = (tOut - out.firstBeat) * out.bpm / 60;
  const diff = s.initial * base / (60 / (s.inBpm * fold));
  let tIn = inn.firstBeat + (outBeats - diff) * 60 / (s.inBpm * fold);
  const truth = () => phaseReading({ ...out, time: tOut }, { ...inn, time: tIn, rate: base * (1 + trim) }).real;
  const log: { t: number; err: number; trim: number; decision: Decision }[] = [];
  const decisions: Decision[] = [];
  for (let i = 0; i < s.seconds * hz; i++) {
    const t = i * dt, audible = t >= (s.audibleFrom ?? 0);
    let measured = truth() + (random() * 2 - 1) * (s.jitter ?? 0.002);
    if (s.quantum) measured = Math.round(measured / s.quantum) * s.quantum;
    if (random() > 1 - (s.spikes ?? 0)) measured += 0.04 * Math.sign(random());
    const decision = governor.update({ time: t, error: measured, audible, remaining: s.seconds - t });
    decisions.push(decision);
    if (decision.kind === "trim") trim = decision.trim;
    if (decision.kind === "seek") tIn += decision.by * base;
    if (decision.kind === "fallback") break;
    tOut += dt * outRate;
    tIn += dt * base * (1 + trim) * (1 + (s.epsilon ?? 0));
    log.push({ t, err: truth(), trim, decision });
  }
  return { log, decisions };
}
const worst = (log: { t: number; err: number }[], from: number) => Math.max(...log.filter(r => r.t >= from).map(r => Math.abs(r.err)));

describe("beat phase", () => {
  it("reads zero for decks on the same beat, and the signed gap otherwise", () => {
    const a = { bpm: 120, firstBeat: 0, time: 10.25 };
    expect(phaseReading(a, { bpm: 120, firstBeat: 0, time: 10.25, rate: 1 }).media).toBeCloseTo(0, 9);
    // The incoming deck is 50 ms behind: it must move forward 50 ms.
    expect(phaseReading(a, { bpm: 120, firstBeat: 0, time: 10.2, rate: 1 }).media).toBeCloseTo(0.05, 9);
    expect(phaseReading(a, { bpm: 120, firstBeat: 0, time: 10.3, rate: 1 }).media).toBeCloseTo(-0.05, 9);
  });
  it("wraps to the nearest beat and reads real seconds at the incoming rate", () => {
    const r = phaseReading({ bpm: 120, firstBeat: 0, time: 10 }, { bpm: 120, firstBeat: 0, time: 10.45, rate: 1.1 });
    expect(r.media).toBeCloseTo(0.05, 9);
    expect(r.real).toBeCloseTo(0.05 / 1.1, 9);
  });
  it("reads a half-time track against its double-time grid", () => {
    // 64 bpm against 128: the incoming beat is 0.9375 s, and it is lined up beat for every other beat.
    const aligned = phaseReading({ bpm: 128, firstBeat: 0, time: 30 }, { bpm: 64, firstBeat: 0, time: 30, rate: 1 });
    expect(aligned.media).toBeCloseTo(0, 9);
    expect(aligned.beat).toBeCloseTo(60 / 128, 9);
  });
});

describe("drift governor, silent deck", () => {
  it("seeks a large error away, waits for the deck to settle, and reports ready once it sits on the beat", () => {
    const { log, decisions } = simulate({ outBpm: 124, inBpm: 120, seconds: 6, initial: 0.18, audibleFrom: 99 });
    expect(decisions.filter(d => d.kind === "seek").length).toBeGreaterThanOrEqual(1);
    expect(decisions.filter(d => d.kind === "seek").length).toBeLessThanOrEqual(2);
    expect(worst(log, 3)).toBeLessThan(DEFAULT_GOVERNOR.seekAbove);
  });
  it("does not seek an error it can slew", () => {
    const { decisions } = simulate({ outBpm: 120, inBpm: 120, seconds: 4, initial: 0.008, audibleFrom: 99 });
    expect(decisions.some(d => d.kind === "seek")).toBe(false);
  });
});

describe("drift governor, audible deck", () => {
  const pairs: [string, number, number][] = [["120 into 124 bpm", 120, 124], ["124 into 120 bpm", 124, 120], ["128 into 64 bpm", 128, 64], ["64 into 128 bpm", 64, 128]];

  it.each(pairs)("holds %s on the beat over a 32-bar blend, with noisy readings, without a seek", (_n, outBpm, inBpm) => {
    const seconds = 32 * 4 * 60 / outBpm;
    const { log, decisions } = simulate({ outBpm, inBpm, seconds, initial: 0.02, epsilon: 0.0006, jitter: 0.003, quantum: 0.005, spikes: 0.03 });
    expect(decisions.some(d => d.kind === "seek" || d.kind === "fallback")).toBe(false);
    // Settled within 12 s, and from then on within 6 ms of the beat (a flam under about 10 ms is not heard as one).
    expect(worst(log, 12)).toBeLessThan(0.006);
    // Never beyond the trim cap, never a jump in it, and not a rate change on every reading.
    for (let i = 0; i < log.length; i++) {
      expect(Math.abs(log[i].trim)).toBeLessThanOrEqual(DEFAULT_GOVERNOR.maxTrim + 1e-9);
      if (i) expect(Math.abs(log[i].trim - log[i - 1].trim)).toBeLessThanOrEqual(DEFAULT_GOVERNOR.slew + 1e-9);
    }
    const changes = decisions.filter(d => d.kind === "trim").length;
    expect(changes / seconds).toBeLessThan(3);
  });

  it("learns a steady tempo mismatch instead of leaving a constant offset", () => {
    const { log } = simulate({ outBpm: 120, inBpm: 120, seconds: 60, initial: 0, epsilon: 0.002, jitter: 0.001 });
    expect(worst(log, 20)).toBeLessThan(0.004);
    // The trim it settles on is the mismatch it cancels, about -0.2 %.
    expect(log[log.length - 1].trim).toBeCloseTo(-0.002, 3);
  });

  it("recovers a 25 ms offset by slewing alone, inside the cap", () => {
    const { log, decisions } = simulate({ outBpm: 124, inBpm: 124, seconds: 30, initial: 0.025, audibleFrom: 0 });
    expect(decisions.some(d => d.kind === "seek")).toBe(false);
    expect(worst(log, 15)).toBeLessThan(0.005);
    expect(Math.max(...log.map(r => Math.abs(r.trim)))).toBeLessThanOrEqual(DEFAULT_GOVERNOR.maxTrim + 1e-9);
  });

  it("gives up on sync when the decks are far apart, so the blend can leave early", () => {
    const { decisions } = simulate({ outBpm: 124, inBpm: 124, seconds: 30, initial: 0.12 });
    expect(decisions.some(d => d.kind === "fallback")).toBe(true);
  });

  it("does not give up near the end of a blend, where the old deck is nearly gone", () => {
    const { decisions } = simulate({ outBpm: 124, inBpm: 124, seconds: 1.5, initial: 0.12 });
    expect(decisions.some(d => d.kind === "fallback")).toBe(false);
  });

  it("falls back when the clock stops answering", () => {
    const g = new DriftGovernor();
    g.update({ time: 0, error: 0.001, audible: true, remaining: 20 });
    let verdict: Decision = { kind: "hold" };
    for (let t = 0.1; t < 3; t += 0.1) { const d = g.update({ time: t, error: null, audible: true, remaining: 20 - t }); if (d.kind === "fallback") { verdict = d; break; } }
    expect(verdict.kind).toBe("fallback");
  });

  it("keeps the rate change small when the browser cannot keep pitch", () => {
    const { log } = simulate({ outBpm: 120, inBpm: 120, seconds: 30, initial: 0.02, epsilon: 0.001 }, new DriftGovernor({}, 0.003));
    expect(Math.max(...log.map(r => Math.abs(r.trim)))).toBeLessThanOrEqual(0.003 + 1e-9);
    // 0.3 % is 5 cents.
    expect(Math.abs(rateCents(1.003))).toBeLessThan(5.2);
  });
});

describe("preroll", () => {
  it("grows with what the deck has been seen to take, inside its bounds", () => {
    const quick = new LatencyTracker(), slow = new LatencyTracker();
    for (const v of [0.05, 0.06, 0.05, 0.07]) quick.record(v);
    for (const v of [0.4, 0.5, 0.9, 0.45]) slow.record(v);
    const a = prerollSeconds({ startLatency: quick.slow(), seekCost: 0.02 }), b = prerollSeconds({ startLatency: slow.slow(), seekCost: 0.05 });
    expect(a).toBeGreaterThanOrEqual(MIN_PREROLL);
    expect(b).toBeGreaterThan(a);
    expect(prerollSeconds({ startLatency: 9, seekCost: 0.08 })).toBe(MAX_PREROLL);
  });
  it("starts from a guess before anything has been seen, and ignores bad samples", () => {
    const t = new LatencyTracker();
    expect(t.slow()).toBe(0.25);
    t.record(NaN); t.record(-1);
    expect(t.slow()).toBe(0.25);
  });
});

describe("clock map", () => {
  it("smooths a stepped context clock into a steady map from the performance clock", () => {
    const map = new ClockMap();
    // The context clock reads in 10 ms steps, and the true offset is 5 s.
    for (let p = 0; p < 2; p += 0.013) map.sample(p, Math.floor((p + 5) / 0.01) * 0.01);
    expect(map.ready).toBe(true);
    for (const p of [2.0, 2.003, 2.006, 2.009]) expect(Math.abs(map.at(p) - (p + 5))).toBeLessThan(0.004);
  });
});
