"use client";

import { memo, useEffect, useRef } from "react";
import type { DeckId } from "@/lib/types";
import { dueIn, formatDue } from "./model";

type Props = {
  /** The live deck's media clock, read every frame. Must be a stable function. */
  mediaTime: (id: DeckId) => number;
  deck: DeckId | null; outAt: number | null; rate: number; playing: boolean;
  className?: string;
};

/* The time to the mix point, written straight into the text node every frame from the media clock: the deck state that
   React holds updates ten times a second and would make the count stutter, and a re-render per frame would cost the
   whole panel. Stopped decks show the time it would be at the current position. The figure is a timer, not a live
   region: a screen reader reads it when it reaches it, it does not announce every tick. */
export const Countdown = memo(function Countdown({ mediaTime, deck, outAt, rate, playing, className }: Props) {
  const text = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = text.current;
    if (!el) return;
    if (deck === null || outAt === null) { el.textContent = "-"; return; }
    const write = () => { el.textContent = formatDue(dueIn(outAt, mediaTime(deck), rate)); };
    write();
    if (!playing) return;
    let raf = requestAnimationFrame(function tick() { write(); raf = requestAnimationFrame(tick); });
    // A hidden tab stops animation frames; a slow timer keeps the figure right for when it comes back.
    const slow = window.setInterval(write, 500);
    return () => { cancelAnimationFrame(raf); window.clearInterval(slow); };
  }, [mediaTime, deck, outAt, rate, playing]);
  return <span ref={text} role="timer" className={className}>-</span>;
});
