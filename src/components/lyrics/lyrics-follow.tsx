"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { DJ } from "@/hooks/use-dj";
import { groupLines, indexAt } from "@/lib/lyrics";
import type { DeckId, Track } from "@/lib/types";
import { Button } from "@/components/sodium/ui/button";
import { Frame, FrameActions, FrameBody, FrameHeader, FrameTitle, FrameValue } from "@/components/sodium/ui/frame";
import { ChevronDown, Icon, Sparkles } from "@/components/sodium/icon";

/* The lyrics of the track that is playing, as an accordion under the decks (transitions.dev accordion expand): closed it
   is one header, open it follows the song. Every line stays in the list and the box scrolls to keep the one being sung in
   the middle; a line moves only by opacity, colour and a scale, so nothing reflows while the song goes on. It reads the
   deck's media clock every frame and touches the DOM directly, so a playing song does not re-render it. */

const KEY = "shift:lyrics-follow";
const read = () => { try { return localStorage.getItem(KEY) === "1"; } catch { return false; } };

export function LyricsFollow({ dj, deck, track }: { dj: DJ; deck: DeckId; track: Track | undefined }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { queueMicrotask(() => setOpen(read())); }, []);
  const toggle = () => setOpen(v => { try { localStorage.setItem(KEY, v ? "0" : "1"); } catch {} return !v; });

  const lyrics = track?.lyrics;
  const lines = useMemo(() => lyrics ? groupLines(lyrics.words) : [], [lyrics]);
  const starts = useMemo(() => lines.map(l => l.t), [lines]);
  const box = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLElement | null)[]>([]);
  const wordRefs = useRef<(HTMLSpanElement | null)[][]>([]);
  const shown = useRef({ line: -2, word: -2 });
  const mediaTime = dj.mediaTime;

  useEffect(() => {
    if (!open || !lines.length) return;
    shown.current = { line: -2, word: -2 };
    let raf = 0;
    const tick = () => {
      const time = mediaTime(deck), now = indexAt(starts, time);
      if (now !== shown.current.line) {
        shown.current = { line: now, word: -2 };
        lineRefs.current.forEach((el, i) => {
          if (!el) return;
          el.dataset.state = i === now ? "now" : i < now ? "past" : "next";
          el.dataset.far = String(Math.abs(i - now) > 2);
        });
        const el = lineRefs.current[Math.max(0, now)], host = box.current;
        if (el && host) host.scrollTo({ top: el.offsetTop - host.clientHeight / 2 + el.offsetHeight / 2,
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      }
      // The word being sung is marked and the ones before it are dark.
      if (now >= 0) {
        const words = lines[now].words, at = words.findLastIndex(w => w.t <= time);
        if (at !== shown.current.word) {
          shown.current.word = at;
          words.forEach((_, j) => { const el = wordRefs.current[now]?.[j]; if (el) el.dataset.word = j < at ? "done" : j === at ? "now" : "ahead"; });
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [open, lines, starts, mediaTime, deck]);

  const busy = track ? dj.transcribing[track.id] : undefined;
  const status = !track ? "No track playing" : lines.length ? `${lines.length} lines` : busy !== undefined ? `Transcribing ${Math.round(busy * 100)}%` : "No lyrics yet";

  return <Frame aria-label="Lyrics" id="lyrics" className="t-acc" data-open={open}>
    <FrameHeader>
      <FrameTitle>Lyrics</FrameTitle>
      <FrameValue meta className="truncate">{track ? `${track.title} · ${status}` : status}</FrameValue>
      <FrameActions>
        <Button size="icon-sm" variant="ghost" aria-expanded={open} aria-controls="lyrics-body" aria-label={open ? "Hide the lyrics" : "Show the lyrics"} onClick={toggle}>
          <span className="t-acc-chevron"><Icon icon={ChevronDown}/></span>
        </Button>
      </FrameActions>
    </FrameHeader>
    <div className="t-acc-panel" inert={!open}><div className="t-acc-panel-inner">
      <FrameBody id="lyrics-body" className="py-4">
        {!track && <p className="type-body-sm text-text-2">Play a track to follow its lyrics here.</p>}
        {track && !lines.length && <div className="flex flex-wrap items-center gap-3">
          <p className="type-body-sm text-text-2">{dj.lyricsAvailable === false ? "Transcribing needs Whisper on this machine: see the README." : "This track has no timed lyrics yet."}</p>
          <Button size="sm" variant="secondary" disabled={!dj.lyricsAvailable || busy !== undefined} pending={busy !== undefined} pendingLabel="Transcribing"
            onClick={() => void dj.transcribeLyrics(track.id)}><Icon icon={Sparkles}/>Transcribe</Button>
        </div>}
        {lines.length > 0 && <div ref={box} className="relative h-56 overflow-hidden">
          <ol className="mx-auto flex max-w-3xl flex-col items-center gap-3 py-24 text-center">
            {lines.map((line, i) => <li key={i} ref={el => { lineRefs.current[i] = el; }} data-state="next" className="t-lyric w-full">
              <Button variant="ghost" size="sm" className="w-full justify-center" onClick={() => dj.seek(deck, line.t)}>
                <span className="min-w-0 truncate type-body text-text-1">
                  {line.words.map((w, j) => <span key={j} ref={el => { (wordRefs.current[i] ??= [])[j] = el; }} data-word="ahead"
                    className="data-[word=done]:text-text-2 data-[word=now]:text-accent-text">{w.w}{" "}</span>)}
                </span>
              </Button>
            </li>)}
          </ol>
        </div>}
      </FrameBody>
    </div></div>
  </Frame>;
}
