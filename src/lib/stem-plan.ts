import { lowOf, stemsOf, swapsBassStem, volumeOf } from "@/lib/transition";
import { syncRatio, type Loop, type VolumePoint } from "@/lib/stem-mix";
import type { StoredTrack, TransitionPlan } from "@/lib/types";

/* A transition plan (the automatic planner's or the local model's, the same ones the decks play) laid onto the Stems
   page's mix: where B sits on the timeline, the two volume curves and a curve for every stem the plan moves. The curves
   are the plan's own functions (lib/transition volumeOf, stemsOf, lowOf) sampled across the transition, so the page plays
   what the decks would. The effects of a plan are automation the page has no lane for; they are named, not played. */

export type PlanFit = {
  offset: number; ratio: number;
  /** The transition on the timeline. */
  span: Loop;
  volume: [VolumePoint[], VolumePoint[]];
  /** Per layer, a curve per stem in STEMS order; empty where the plan leaves that stem alone. */
  stems: [VolumePoint[][], VolumePoint[][]];
};

type PlanShape = Pick<TransitionPlan, "outAt" | "inAt" | "bars" | "volume" | "curve" | "eq" | "eqAt" | "stems" | "stemMoves" | "sync">;

/** Progress values to sample: an even grid, plus both sides of the swap point and the edges the stem moves ramp at. */
function samples(at: number) {
  const ts = new Set<number>();
  for (let i = 0; i <= 48; i++) ts.add(i / 48);
  for (const t of [at - 0.041, at - 0.011, at, at + 0.011, at + 0.041, 0.05, 0.1, 0.4, 0.45, 0.5, 0.55, 0.6, 0.85, 0.9]) if (t > 0 && t < 1) ts.add(t);
  return [...ts].sort((a, b) => a - b);
}

/** Drops the points a straight line through their neighbours already draws, within `tolerance` of gain. */
export function simplify(points: VolumePoint[], tolerance = 0.012): VolumePoint[] {
  if (points.length < 3) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const a = out[out.length - 1], b = points[i], c = points[i + 1];
    const line = a.g + (c.g - a.g) * (b.t - a.t) / Math.max(1e-9, c.t - a.t);
    if (Math.abs(line - b.g) > tolerance) out.push(b);
  }
  out.push(points[points.length - 1]);
  return out;
}

const flat = (points: VolumePoint[]) => points.every(p => Math.abs(p.g - 1) < 1e-3);

export function planToMix(plan: PlanShape, a: Pick<StoredTrack, "bpm">, b: Pick<StoredTrack, "bpm">): PlanFit {
  const ratio = plan.sync === false ? 1 : syncRatio(a.bpm, b.bpm);
  const bar = 240 / (a.bpm || 120), length = plan.bars * bar;
  const offset = plan.outAt - plan.inAt / ratio;
  const at = Math.max(0.15, Math.min(0.85, plan.eqAt ?? 0.5));
  const ts = samples(at);
  const tA = (t: number) => plan.outAt + t * length, tB = (t: number) => plan.inAt + t * length * ratio;
  const volA = ts.map(t => ({ t: tA(t), g: volumeOf(plan, t).out })), volB = ts.map(t => ({ t: tB(t), g: volumeOf(plan, t).in }));
  const stemA: VolumePoint[][] = [[], [], [], []], stemB: VolumePoint[][] = [[], [], [], []];
  for (const t of ts) {
    const s = stemsOf(plan, t);
    // An eq bass swap becomes the bass stems' own swap: the low band of a stems track is its bass stem.
    if (plan.eq !== "none" && !swapsBassStem(plan.stems, plan.stemMoves)) {
      const low = lowOf(plan, t);
      s.out[2] *= dbToGain(low.out); s.in[2] *= dbToGain(low.in);
    }
    for (let k = 0; k < 4; k++) { stemA[k].push({ t: tA(t), g: s.out[k] }); stemB[k].push({ t: tB(t), g: s.in[k] }); }
  }
  const tidy = (pts: VolumePoint[]) => flat(pts) ? [] : simplify(pts);
  return {
    offset, ratio, span: { from: plan.outAt, to: plan.outAt + length },
    volume: [simplify(volA), simplify(volB)],
    stems: [stemA.map(tidy), stemB.map(tidy)],
  };
}

/** lowOf answers the low shelf in dB, -24 being a kill; as a gain on the bass stem. */
const dbToGain = (db: number) => db <= -23.9 ? 0 : Math.min(1, 10 ** (db / 20));
