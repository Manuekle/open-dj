import { holdAt, pointCount, rampChain, releaseTo, sampleCurve } from "@/lib/automation";
import { centsOf, colorCutoffs, ensureRack, type DeckGraph, type SendKind } from "@/lib/deck-graph";
import { echoBeatsOf, effectOf, effectSend, effectUsesColor, lowOf, stemsOf, volumeOf } from "@/lib/transition";
import type { TransitionPlan } from "@/lib/types";

/* A transition as AudioParam automation.

   The whole transition is written to the audio thread before it starts: every lane (volume, bass shelf, filters, send,
   vocals) is a chain of ramps against the context clock. Nothing in it waits for a timer, so a stalled main thread, a
   background tab or a slow React render cannot move a fade, a bass swap or the end of the blend. The main thread only
   watches: it may re-anchor the automation (a tempo change, a drift correction that needs more time) and it may cancel.

   Timing, honestly: the lanes are exact against the context clock. What the context clock says about the *media*
   (where a track is in its playback) is an estimate: a media element reports its position on its own clock, and the
   audio it has already handed to the output (its latency) is not part of that report. Two decks whose outputs lag by
   different amounts cannot be told apart from the media clocks alone. */

/** A mix that starts later than this from now is written as it was planned; sooner than that it starts late (see lay). */
const MIN_LEAD = 0.03;
/** How far ahead a re-anchor or a late start begins, so its first ramp has room to run before it matters. */
const ANCHOR_LEAD = 0.06;
/** Seconds a cancelled mix takes to hand every lane back to rest. Short enough to feel instant, long enough not to click. */
export const RELEASE = 0.25;

export type MixSpec = {
  plan: Pick<TransitionPlan, "volume" | "eq" | "effect" | "stems"> & Partial<Pick<TransitionPlan, "curve" | "eqAt" | "intensity" | "echoBeats">>;
  from: DeckGraph;
  to: DeckGraph;
  /** Context time of progress 0. */
  start: number;
  /** Context seconds the whole transition takes. */
  duration: number;
  /** The outgoing deck's share of the fader when the mix starts, so its curve begins where it already is. */
  outStart: number;
  /** The crossfader gains the decks land on when the mix ends, and the ones a cancelled mix goes back to. */
  final: { from: number; to: number };
  rest: { from: number; to: number };
  /** Whether the plan's stem move runs: both decks play stems files. */
  handover: boolean;
  /** Context seconds per beat of the outgoing track, so a transition's echo repeats on the beat. */
  beat?: number;
};

type Lane = {
  param: AudioParam;
  value: (t: number) => number;
  /** Where the lane sits when no mix drives it. */
  rest: number;
  /** Where it is set the instant the mix ends; defaults to rest. */
  end?: number;
  /** The value it holds before the mix reaches it (an incoming deck is kept silent while it prerolls). */
  entry?: number;
  /** A constant held for the whole mix, written as one event instead of a chain. */
  step?: boolean;
  /** Which deck's fader this lane belongs to, for the hand back on cancel. */
  fader?: "volume" | "cross";
  deck?: "from" | "to";
};

/** The crossfader's equal-power gains for a position -1 (deck A) .. +1 (deck B). */
export function crossGains(value: number) {
  const theta = (Math.max(-1, Math.min(1, value)) + 1) * Math.PI / 4;
  return { A: Math.cos(theta), B: Math.sin(theta) };
}

export class MixSession {
  state: "live" | "done" | "cancelled" = "live";
  private readonly lanes: Lane[];
  /** Progress t0 at context time `at`, then (1 - t0) of the blend over `len` seconds. */
  private t0 = 0;
  private at: number;
  private len: number;
  /** Context time the blend reaches progress 1. */
  end: number;
  readonly sendKind: SendKind | null;

  constructor(private readonly ctx: BaseAudioContext, private readonly spec: MixSpec) {
    this.at = spec.start; this.len = Math.max(0.05, spec.duration); this.end = this.at + this.len;
    const { plan, from, to } = spec;
    const nyquist = ctx.sampleRate / 2;
    const lp = (hz: number) => centsOf(Math.min(hz >= 20000 ? nyquist : hz, nyquist));
    const lanes: Lane[] = [];
    const add = (lane: Lane) => lanes.push(lane);

    add({ param: from.mix.volume.gain, value: t => volumeOf(plan, t).out * spec.outStart, rest: 1, fader: "volume", deck: "from" });
    add({ param: to.mix.volume.gain, value: t => volumeOf(plan, t).in, rest: 1, entry: 0, fader: "volume", deck: "to" });
    // The crossfader is taken out of the path for the length of the mix: its gains are held at 1 and the volume lanes
    // carry the blend. Both change on the same sample at the start and at the end, so neither moves the signal.
    add({ param: from.cross.gain, value: () => 1, rest: spec.rest.from, end: spec.final.from, step: true, fader: "cross", deck: "from" });
    add({ param: to.cross.gain, value: () => 1, rest: spec.rest.to, end: spec.final.to, step: true, fader: "cross", deck: "to" });

    if (plan.eq !== "none") {
      add({ param: from.mix.low.gain, value: t => lowOf(plan, t).out, rest: 0 });
      add({ param: to.mix.low.gain, value: t => lowOf(plan, t).in, rest: 0 });
    }
    if (effectUsesColor(plan.effect)) {
      for (const [deck, side] of [[from, "outColor"], [to, "inColor"]] as const) {
        add({ param: deck.mix.lp.detune, value: t => lp(colorCutoffs(effectOf(plan, t)[side]).lp), rest: centsOf(nyquist) });
        add({ param: deck.mix.hp.detune, value: t => centsOf(colorCutoffs(effectOf(plan, t)[side]).hp), rest: centsOf(colorCutoffs(0).hp) });
      }
    }
    const send = effectSend(plan.effect);
    this.sendKind = send;
    if (send) {
      const rack = ensureRack(ctx, from, send);
      // The echo repeats on the outgoing track's beat, at the plan's division, for the length of the mix.
      if (rack.delay && spec.beat) rack.delay.delayTime.setValueAtTime(Math.min(1.9, Math.max(0.03, spec.beat * echoBeatsOf(plan))), Math.max(ctx.currentTime, spec.start - 0.05));
      add({ param: from.mix.send.gain, value: t => Math.min(0.95, effectOf(plan, t).amount * 0.7), rest: 0 });
      add({ param: from.mix.dry.gain, value: t => { const e = effectOf(plan, t); return Math.max(0, 1 - e.amount * 0.25 - e.wash); }, rest: 1 });
    }
    if (spec.handover) {
      // One lane per stem and side, only where the move changes that stem.
      const probe = [0, 0.25, 0.5, 0.75, 1].map(t => stemsOf(plan, t));
      for (let k = 0; k < 4; k++) {
        if (probe.some(p => p.out[k] !== 1)) add({ param: from.mix.stems[k].gain, value: t => stemsOf(plan, t).out[k], rest: 1 });
        if (probe.some(p => p.in[k] !== 1)) add({ param: to.mix.stems[k].gain, value: t => stemsOf(plan, t).in[k], rest: 1 });
      }
    }
    this.lanes = lanes;
  }

  /** Where the blend is at a context time, 0..1, by the timing the automation was written to. */
  progressAt(time: number) {
    if (this.state === "done") return 1;
    if (time <= this.at) return this.t0;
    return Math.min(1, this.t0 + (time - this.at) / this.len * (1 - this.t0));
  }
  /** Whether the automation has run its course by this context time. */
  isOver(time: number) { return this.state === "live" && time >= this.end; }
  finish() { if (this.state === "live") this.state = "done"; }

  /** Writes the whole transition. A start in the past (a late trigger) begins at the progress the clock says, with a short
      ramp in from rest, instead of stepping the incoming deck to a level in one sample. */
  schedule() {
    const now = this.ctx.currentTime;
    if (this.spec.start - now >= MIN_LEAD) {
      for (const lane of this.lanes) lane.param.cancelScheduledValues(this.spec.start);
      this.lay("first", 0, this.spec.start, this.len);
      return;
    }
    const at = now + ANCHOR_LEAD;
    const t0 = Math.min(0.999, Math.max(0, (at - this.spec.start) / this.spec.duration));
    this.lay("late", t0, at, Math.max(0.05, this.spec.start + this.spec.duration - at));
  }

  /**
   * Keeps the blend where it is and gives it `remaining` context seconds to finish. A tempo change calls this with the
   * time the rest of the outgoing track now takes; a fallback calls it with a short time to leave early. `progress`
   * re-anchors the blend to where the media says it is, if that differs from where the clock says. The lanes glide from
   * what they hold to what the new timing wants over a few tens of ms, so neither moves with a step.
   */
  reanchor(remaining: number, progress?: number) {
    if (this.state !== "live") return;
    const now = this.ctx.currentTime, at = now + ANCHOR_LEAD;
    const live = now >= this.at;
    const current = this.progressAt(now);
    const t0 = Math.min(0.999, Math.max(0, progress ?? this.progressAt(at)));
    this.lay(live ? "live" : "late", t0, at, Math.max(0.05, remaining - ANCHOR_LEAD), current);
  }

  /** Context seconds the blend still has to run. */
  remaining(time: number) { return Math.max(0, this.end - time); }

  /**
   * Stops the mix and hands every lane back to rest: the faders to the crossfader's own gains, the filters, shelf and
   * send to neutral. Nothing is left in a lane's timeline, so a later mix, or the DJ's own controls, start clean.
   */
  cancel(release = RELEASE) {
    if (this.state !== "live") return;
    const now = this.ctx.currentTime;
    const started = now >= this.at;
    const p = this.progressAt(now);
    // A deck's audible level is volume x cross. Hand over in one sample: the volume lane goes to rest (1) while the cross
    // lane takes the product, then the cross lane glides to the crossfader's own gain.
    const level = new Map<"from" | "to", number>();
    for (const lane of this.lanes) {
      if (lane.fader !== "volume" || !lane.deck) continue;
      level.set(lane.deck, started ? lane.value(p) : (lane.entry ?? lane.rest) * this.spec.rest[lane.deck]);
    }
    for (const lane of this.lanes) {
      const now0 = started ? lane.value(p) : lane.entry ?? lane.rest;
      if (lane.fader === "volume") { holdAt(lane.param, now, now0); lane.param.setValueAtTime(lane.rest, now); continue; }
      if (lane.fader === "cross" && lane.deck) {
        const held = started ? 1 : this.spec.rest[lane.deck];
        const product = level.get(lane.deck) ?? held;
        holdAt(lane.param, now, held);
        lane.param.setValueAtTime(product, now);
        lane.param.linearRampToValueAtTime(lane.rest, now + release);
        continue;
      }
      releaseTo(lane.param, now, now0, lane.rest, release);
    }
    this.state = "cancelled";
    this.end = now + release;
  }

  /**
   * Writes the lanes from progress t0 at context time `at` over `len` seconds.
   * - first: the mix is still ahead; each lane holds its rest until `at`, where the first value is set.
   * - late: the mix has not been driving the lanes yet but starts now. Each lane glides from what the DJ hears (the
   *   deck's level is volume x cross, so the volume lane starts at that product and the cross lane goes to 1 on the same
   *   sample) to the value at t0 by `at`, instead of stepping.
   * - live: the mix is running; each lane glides from what the old timing had it at (`current`) to the new.
   */
  private lay(mode: "first" | "late" | "live", t0: number, at: number, len: number, current = 0) {
    const n = pointCount(len), now = this.ctx.currentTime;
    for (const lane of this.lanes) {
      if (mode !== "first") {
        const held = mode === "live" ? lane.value(current)
          : lane.fader === "volume" && lane.deck ? (lane.entry ?? lane.rest) * this.spec.rest[lane.deck]
          : lane.fader === "cross" && lane.deck ? this.spec.rest[lane.deck] : lane.entry ?? lane.rest;
        holdAt(lane.param, now, held);
        if (lane.step) lane.param.setValueAtTime(lane.value(t0), now);
        else lane.param.linearRampToValueAtTime(lane.value(t0), at);
      }
      if (lane.step) { if (mode === "first") lane.param.setValueAtTime(lane.value(t0), at); }
      else rampChain(lane.param, sampleCurve(lane.value, t0, 1, n), at, len);
      lane.param.setValueAtTime(lane.end ?? lane.rest, at + len);
    }
    this.t0 = t0; this.at = at; this.len = len; this.end = at + len;
  }
}
