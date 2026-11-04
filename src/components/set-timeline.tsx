"use client";

import { useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/sodium/utils";
import { formatTime, type DeckId } from "@/lib/types";
import { spanOn } from "@/lib/transition";
import type { SetEntry } from "@/hooks/use-dj";
import { useDeckPosition, type DeckPositions } from "@/hooks/use-deck-position";
import { Button } from "@/components/sodium/ui/button";

/** Where one track sits on the set's clock, in seconds from the start of the track playing now. */
export type Segment = {
  /** Set time the track is first heard, where its outgoing transition starts, and where it is gone. */
  start: number; outStart: number; end: number;
  /** Its own time at `start`: 0 for the track playing now, the plan's in point for the others. */
  enter: number;
};

/**
 * Lays the set out on one clock. The track playing now starts at set time 0 = its own time 0, so the live deck's media
 * time is the playhead. Each following track comes in at the out point of the one before, from its own in point, and
 * leaves at its own out point. Tempo matching stretches the incoming tracks by a few percent at most, which this view
 * leaves out: the times are the tracks' own, as their waveforms show them.
 */
export function layoutSet(entries: SetEntry[]): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i < entries.length; i++) {
    const { track, plan } = entries[i];
    const enter = i === 0 ? 0 : entries[i - 1].plan?.inAt ?? 0;
    const start = i === 0 ? 0 : out[i - 1].outStart;
    // A plan whose out point sits before the track has come in (a stale or hand-placed one) still gets a short body.
    const leave = plan ? Math.max(plan.outAt, enter + 8) : track.duration;
    const outStart = start + Math.max(0, leave - enter);
    const end = plan ? outStart + spanOn(track, plan.bars) : start + Math.max(0, track.duration - enter);
    out.push({ start, outStart, end, enter });
  }
  return out;
}

const countdown = (seconds: number) => seconds <= 0 ? "now" : `in ${formatTime(seconds)}`;

type Props = {
  entries: SetEntry[];
  /** The deck the playing track is on, its rate and whether it plays, for the playhead and the countdowns. */
  liveDeck: DeckId | null; rate: number; playing: boolean;
  /** Stable: read every frame for the playhead. */
  mediaTime: (id: DeckId) => number;
  /** The live playheads, for the countdowns (read in half seconds, so the timeline re-renders twice a second). */
  positions: DeckPositions;
  /** A running mix's progress, on the first transition. */
  progress: number | null;
  selected: number;
  onSelect: (index: number) => void;
  /** Whether the transitions start on their own (AutoMix on, or a preview armed): off, they wait for Mix now. */
  armed: boolean;
  /** Why the set will not go on by itself, and the one press that fixes it. */
  notice: { text: string; action?: { label: string; run: () => void } } | null;
};

/* The whole set on one line: the track playing now, the next one and the queue after it, each a block on its own row
   (they alternate, so a transition reads as the overlap of two blocks), with the transitions between them. A playhead
   follows the live deck every frame, and each transition says how long until it starts. Click a transition (or a
   track, for the one that takes it out) to open it in the editor below. */
export function SetTimeline({ entries, liveDeck, rate, playing, mediaTime, positions, progress, selected, onSelect, armed, notice }: Props) {
  const position = useDeckPosition(positions, liveDeck, 0.5);
  const segments = useMemo(() => layoutSet(entries), [entries]);
  const total = segments.length ? segments[segments.length - 1].end : 0;
  // About the first three tracks fill the view; the rest of the set scrolls.
  const visible = segments.length ? Math.max(60, segments[Math.min(2, segments.length - 1)].end) : 1;
  const scroller = useRef<HTMLDivElement>(null), head = useRef<HTMLDivElement>(null);
  const live = useRef({ liveDeck, total, playing });
  useEffect(() => { live.current = { liveDeck, total, playing }; });
  // The loop runs only while the set plays; a paused deck draws the playhead once for each change of position.
  useEffect(() => {
    let raf = 0, last = -1, drawn = -1;
    const draw = () => {
      const { liveDeck: deck, total: span, playing: on } = live.current;
      const el = head.current, box = scroller.current;
      if (el && deck && span > 0) {
        const at = Math.max(0, Math.min(1, mediaTime(deck) / span));
        // Keep the playhead in view while the set plays, unless the DJ has scrolled away from it. The scroller is
        // measured before the playhead is written: reading layout after a style write forces a layout every frame.
        if (box && on && Math.abs(at - last) > 1e-4) {
          const width = box.scrollWidth, left = box.scrollLeft, view = box.clientWidth;
          const x = at * width, near = x >= left - 40 && x <= left + view + 40;
          if (near && x > left + view * 0.75) box.scrollLeft = x - view * 0.25;
          last = at;
        }
        if (at !== drawn) { el.style.setProperty("--at", `${at * 100}%`); drawn = at; }
      }
    };
    if (!playing) { draw(); return; }
    const tick = () => { draw(); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mediaTime, playing, liveDeck, total, position]);

  if (!entries.length) return null;
  const now = position;
  const pct = (v: number) => `${(v / total) * 100}%`;
  const remaining = total - now;

  return <div className="flex flex-col gap-1.5">
    <div className="flex items-baseline gap-3">
      <span className="type-label-sm text-text-2">Set</span>
      <span className="type-caption text-text-2">{entries.length} {entries.length === 1 ? "track" : "tracks"} · {formatTime(Math.max(0, remaining) / (rate || 1))} left{playing ? "" : " · paused"}</span>
      {notice && <span className="ms-auto flex items-center gap-2" role="status">
        <span className="type-caption text-warn-text">{notice.text}</span>
        {notice.action && <Button size="sm" variant="secondary" onClick={notice.action.run}>{notice.action.label}</Button>}
      </span>}
    </div>
    <div ref={scroller} className="overflow-x-auto border border-line bg-well">
      <div className="relative h-28 min-w-full w-(--w)" style={{ "--w": `${Math.max(1, total / visible) * 100}%` } as React.CSSProperties}>
        {entries.map((entry, i) => {
          const seg = segments[i], row = i % 2;
          const isNow = i === 0, isNext = i === 1;
          const peaks = entry.track.peaks ?? [];
          // The part of the track's waveform this block shows: from where it comes in to where it is gone.
          const from = Math.floor(seg.enter / (entry.track.duration || 1) * peaks.length);
          const to = Math.ceil((seg.enter + (seg.end - seg.start)) / (entry.track.duration || 1) * peaks.length);
          const shown = peaks.slice(Math.max(0, from), Math.max(from + 1, Math.min(peaks.length, to)));
          return <div key={`${entry.track.id}${i}`} role="button" tabIndex={0} data-deck={row === 0 ? "A" : "B"}
            aria-label={`${entry.track.title}${isNow ? ", playing now" : isNext ? ", next" : ""}. ${entry.plan ? "Open the transition out of it." : "Last in the set."}`}
            className={cn("absolute left-(--l) h-12 w-(--w) cursor-pointer overflow-hidden border text-data-1 focus-visible:outline-2 focus-visible:outline-focus",
              row === 0 ? "top-1" : "top-14", isNow ? "border-line-control bg-panel" : "border-line-faint bg-page", selected === i ? "border-text-1" : "")}
            style={{ "--l": pct(seg.start), "--w": pct(seg.end - seg.start) } as React.CSSProperties}
            onClick={() => entry.plan && onSelect(i)} onKeyDown={e => { if ((e.key === "Enter" || e.key === " ") && entry.plan) { e.preventDefault(); onSelect(i); } }}>
            {shown.length > 0 && <svg viewBox={`0 0 ${shown.length * 4} 40`} preserveAspectRatio="none" className="absolute inset-0 size-full opacity-40" aria-hidden>
              {shown.map((n, k) => { const h = Math.max(1, Math.round(n * 38)); return <rect key={k} x={k * 4} y={(40 - h) / 2} width={2.5} height={h} fill="currentColor"/>; })}
            </svg>}
            <div className="relative flex h-full flex-col justify-center px-2">
              <span className="truncate type-body-sm text-text-1">{entry.track.title}</span>
              <span className="truncate type-micro text-text-2">{isNow ? "Now" : isNext ? "Next" : `#${i + 1}`} · {entry.track.bpm ? `${entry.track.bpm.toFixed(0)} bpm` : "no tempo"}{entry.track.camelot ? ` · ${entry.track.camelot}` : ""}{entry.track.stems ? " · stems" : ""}</span>
            </div>
          </div>;
        })}
        {/* The transitions: the overlap of two blocks, over both rows, labelled with their countdown. */}
        {entries.map((entry, i) => {
          if (!entry.plan) return null;
          const seg = segments[i];
          const due = (seg.outStart - now) / (rate || 1);
          const running = i === 0 && progress !== null;
          return <div key={`x${i}`} role="button" tabIndex={0}
            aria-label={`Transition ${i + 1}: ${entry.track.title} into ${entries[i + 1].track.title}, ${running ? "mixing now" : armed ? countdown(due) : "starts only with Mix now"}. Open it in the editor.`}
            aria-pressed={selected === i}
            className={cn("absolute inset-y-0 left-(--l) z-(--z-raised) w-(--w) min-w-1.5 cursor-pointer border-x focus-visible:outline-2 focus-visible:outline-focus",
              selected === i ? "border-accent-text bg-accent-text/15" : "border-line-control bg-text-1/5 hover:bg-text-1/10")}
            style={{ "--l": pct(seg.outStart), "--w": pct(seg.end - seg.outStart) } as React.CSSProperties}
            onClick={() => onSelect(i)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(i); } }}>
            <span className={cn("absolute bottom-0.5 left-1 whitespace-nowrap type-micro", selected === i ? "text-accent-text" : "text-text-2")}>
              {running ? `Mixing ${Math.round((progress ?? 0) * 100)}%` : armed ? countdown(due) : due > 0 ? `manual · ${formatTime(due)}` : "manual"}
            </span>
          </div>;
        })}
        <div ref={head} aria-hidden className={cn("pointer-events-none absolute inset-y-0 left-(--at) z-(--z-raised) w-px bg-text-1", !liveDeck && "hidden")}/>
      </div>
    </div>
  </div>;
}
