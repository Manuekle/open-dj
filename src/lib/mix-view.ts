import { effectAt, effectUsesColor, lowAt } from "@/lib/transition";
import type { DeckId, DeckState, TransitionState } from "@/lib/types";

/* What the knobs show while a transition runs. The audio does not go through the knobs: a transition drives its own lanes
   (lib/mix-session), so the DJ's EQ and color stay the DJ's. The knobs still move, as they always did, because the view
   adds what the transition is doing to what the DJ set: the bass shelf in dB, and the color filter where it is further
   from neutral than the DJ's own. Nothing here is written back to the decks or the engine. */

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function overlayMix(decks: Record<DeckId, DeckState>, mix: TransitionState): Record<DeckId, DeckState> {
  const { plan, progress, from, to } = mix;
  const low = lowAt(plan.eq, progress), e = effectAt(plan.effect, progress), colored = effectUsesColor(plan.effect);
  const next = { ...decks };
  for (const [id, lowDb, color] of [[from, low.out, e.outColor], [to, low.in, e.inColor]] as [DeckId, number, number][]) {
    const d = decks[id];
    next[id] = {
      ...d,
      eq: plan.eq === "none" ? d.eq : { ...d.eq, low: clamp(d.eq.low + lowDb, -24, 12) },
      color: colored && Math.abs(color) > Math.abs(d.color) ? color : d.color,
    };
  }
  return next;
}
