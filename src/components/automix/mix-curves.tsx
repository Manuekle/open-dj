"use client";

import { memo, useMemo } from "react";
import { lowOf, volumeOf } from "@/lib/transition";
import type { DeckId, TransitionPlan } from "@/lib/types";

const W = 400, H = 56, STEPS = 48;
const deckName = (id: DeckId | null) => id ? `deck ${id === "A" ? 1 : 2}` : "the outgoing deck";

/** One curve, 0..1 gain, across the transition's width: plotted from the functions mix() plays, so what shows is what plays. */
function path(value: (t: number) => number) {
  return Array.from({ length: STEPS + 1 }, (_, i) => {
    const t = i / STEPS;
    return `${i ? "L" : "M"}${(t * W).toFixed(1)} ${(H - 4 - value(t) * (H - 8)).toFixed(1)}`;
  }).join(" ");
}

type Props = { plan: Pick<TransitionPlan, "volume" | "curve" | "eq" | "eqAt" | "bars">; from: DeckId | null; to: DeckId | null; progress: number | null };

/* The transition's curves at a glance: the outgoing and incoming volume, and when the plan swaps the bass, each side's
   low band with the swap point marked. While a mix runs, a line follows its progress. Paths only change with the plan,
   so the progress line is the one thing that moves during playback. */
export const MixCurves = memo(function MixCurves({ plan, from, to, progress }: Props) {
  const curves = useMemo(() => ({
    out: path(t => volumeOf(plan, t).out),
    in: path(t => volumeOf(plan, t).in),
    lowOut: plan.eq !== "none" ? path(t => 1 + lowOf(plan, t).out / 24) : null,
    lowIn: plan.eq !== "none" ? path(t => 1 + lowOf(plan, t).in / 24) : null,
  }), [plan]);
  const bass = plan.eq !== "none";
  const at = Math.max(0.15, Math.min(0.85, plan.eqAt ?? 0.5));
  const label = `Mix curves: ${deckName(from)} fades out as ${deckName(to)} fades in over ${plan.bars * 4} beats${plan.eq === "bass" ? `; the bass swaps at ${Math.round(at * 100)}%` : plan.eq === "gradual" ? "; the lows ease across" : ""}.`;

  return <div className="flex flex-col gap-1.5">
    <div role="img" aria-label={label} className="relative h-14 border border-line-faint bg-well">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" aria-hidden>
        {curves.lowOut && <g data-deck={from ?? undefined}><path d={curves.lowOut} fill="none" stroke="currentColor" strokeWidth={1.25} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" className="text-data-5"/></g>}
        {curves.lowIn && <g data-deck={to ?? undefined}><path d={curves.lowIn} fill="none" stroke="currentColor" strokeWidth={1.25} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" className="text-data-5"/></g>}
        <g data-deck={from ?? undefined}><path d={curves.out} fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" className="text-data-1"/></g>
        <g data-deck={to ?? undefined}><path d={curves.in} fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" className="text-data-1"/></g>
      </svg>
      {plan.eq === "bass" && <div className="absolute inset-y-0 start-(--at) w-px bg-line-control" style={{ "--at": `${at * 100}%` } as React.CSSProperties} aria-hidden/>}
      {progress !== null && <div aria-hidden style={{ "--t": `${Math.max(0, Math.min(1, progress)) * 100}%` } as React.CSSProperties}
        className="absolute inset-y-0 start-(--t) w-px bg-text-1 transition-[inset-inline-start] duration-(--dur-state) ease-linear"/>}
    </div>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 type-micro text-text-2" aria-hidden>
      <span className="flex items-center gap-1.5" data-deck={from ?? undefined}><span className="size-2 bg-data-1"/>Out {from ? (from === "A" ? 1 : 2) : ""}</span>
      <span className="flex items-center gap-1.5" data-deck={to ?? undefined}><span className="size-2 bg-data-1"/>In {to ? (to === "A" ? 1 : 2) : ""}</span>
      {bass && <span className="flex items-center gap-1.5"><span className="h-0.5 w-3 bg-data-5"/>{plan.eq === "gradual" ? "Lows ease across" : `Bass swap at ${Math.round(at * 100)}%`}</span>}
      {!bass && <span>No bass swap</span>}
    </div>
  </div>;
});
