import { harmony, meanDb, spanOn, tempoGap, type Harmony } from "@/lib/transition";
import type { Track, TransitionPlan } from "@/lib/types";

/* What the queue needs around a transition, not the transition itself (that is the transition planner's job): how well
   two tracks go together (Smart ordering sorts a queue by it), and how a plan bends to the moment it runs in (a skip, a
   seek past the out point, a track that is nearly over). Pure and deterministic. */

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** How hard a track hits, 0..1: its loudness (-30 to -6 dB) and a little from its tempo, or null without an energy map. */
export function energyOf(track: Track): number | null {
  const level = track.energy?.length ? meanDb(track.energy, 0, track.energy.length) : track.loudness ?? null;
  if (level === null) return null;
  const loud = clamp01((level + 30) / 24);
  return track.bpm ? 0.75 * loud + 0.25 * clamp01((track.bpm - 70) / 110) : loud;
}

const KEY_FIT: Record<Harmony, number> = { same: 1, adjacent: 0.9, relative: 0.85, boost: 0.7, clash: 0.25, unknown: 0.5 };
export type Pair = { score: number; tempo: number; key: number; energy: number };
/** How well `to` follows `from`, 0..1: tempo (half and double time folded), key on the Camelot wheel and energy flow (a
    gentle rise is best, a drop costs more than a climb). Unknown values count as neutral, not as a clash. */
export function pairScore(from: Track, to: Track): Pair {
  const gap = tempoGap(from, to);
  const tempo = gap === null ? 0.5 : clamp01(1 - Math.abs(gap) / 0.12);
  const key = KEY_FIT[harmony(from.camelot, to.camelot)];
  const a = energyOf(from), b = energyOf(to);
  let energy = 0.5;
  if (a !== null && b !== null) {
    const d = b - a;
    energy = d >= 0 ? clamp01(1 - Math.max(0, d - 0.12) / 0.5) : clamp01(1 - Math.abs(d) / 0.35);
  }
  return { score: 0.4 * tempo + 0.35 * key + 0.25 * energy, tempo, key, energy };
}

/** Orders items so each follows the one before it as well as it can: from the anchor (kept out of the result), always the
    best-scoring item left. With no anchor the first item stays first. Greedy and deterministic; ties keep the given order,
    and items whose track is unknown go last. */
export function smartOrder<T>(items: T[], trackOf: (item: T) => Track | undefined, anchor?: Track): T[] {
  const left = items.filter(i => trackOf(i)), unknown = items.filter(i => !trackOf(i));
  const out: T[] = [];
  let last = anchor;
  if (!last && left.length) { const first = left.shift()!; out.push(first); last = trackOf(first); }
  while (left.length && last) {
    let best = 0, bestScore = -1;
    left.forEach((item, k) => { const s = pairScore(last!, trackOf(item)!).score; if (s > bestScore + 1e-9) { best = k; bestScore = s; } });
    const [pick] = left.splice(best, 1);
    out.push(pick);
    last = trackOf(pick);
  }
  return [...out, ...unknown];
}

/** The plan trimmed to fit what is left of the outgoing track from `position`, with `lead` seconds before the blend
    starts. A plan that already fits comes back untouched. */
export function fitPlanFrom(plan: TransitionPlan, from: Track, position: number, lead = 0.6): { plan: TransitionPlan; trimmed: boolean } {
  const room = from.duration - position - lead - 0.25;
  let bars = plan.bars;
  while (bars > 1 && spanOn(from, bars) > room) bars /= 2;
  if (bars === plan.bars) return { plan, trimmed: false };
  const note = `Only ${Math.max(0, room).toFixed(0)} s of the old track are left, so the blend is cut to ${bars} bar${bars === 1 ? "" : "s"}.`;
  return { plan: { ...plan, bars, notes: [...(plan.notes ?? []), note] }, trimmed: true };
}
/** A skip is a quick blend: the plan's curves and effect, but over at most 4 bars, and never longer than what is left. */
export function skipPlan(plan: TransitionPlan, from: Track, position: number): TransitionPlan {
  const capped = plan.bars > 4 ? { ...plan, bars: 4 } : plan;
  return fitPlanFrom(capped, from, position).plan;
}
