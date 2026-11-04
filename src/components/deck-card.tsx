"use client";

import { memo, useEffect, useRef } from "react";
import { gsap, useGSAP } from "@/lib/gsap";
import { formatTime, type DeckId, type DeckState, type Track } from "@/lib/types";
import { cn } from "@/lib/sodium/utils";
import { Frame, FrameBody, FrameFooter, FrameHeader, FrameStatus, FrameTitle, FrameValue } from "@/components/sodium/ui/frame";
import { Status } from "@/components/sodium/ui/status";
import { StatusStrip, StatusStripCell, StatusStripLabel, StatusStripUnit, StatusStripValue } from "@/components/sodium/ui/status-strip";
import { Button } from "@/components/sodium/ui/button";
import { Slider } from "@/components/sodium/ui/slider";
import { Cover } from "@/components/track-editor";
import { Icon, Next, Pause, Play, Previous, Repeat, Upload } from "@/components/sodium/icon";
import { Hint } from "@/components/hint";
import { Pick } from "@/components/pick";
import { IconSwap, TextSwap } from "@/components/motion";
import { DECK_KEYS } from "@/hooks/use-shortcuts";
import { useDeckPosition, type DeckPositions } from "@/hooks/use-deck-position";

// Rounded so server and client render identical markup.
const PLACEHOLDER = Array.from({ length: 160 }, (_, i) => Math.round((0.08 + 0.16 * Math.abs(Math.sin(i * 0.57) * Math.cos(i * 0.13))) * 1000) / 1000);

/* Memoized on the peaks: the waveform re-renders with the playhead, the bars only with a new track. */
const Bars = memo(function Bars({ peaks }: { peaks: number[] }) {
  return <svg viewBox={`0 0 ${peaks.length * 5} 80`} preserveAspectRatio="none" aria-hidden className="absolute inset-0 size-full">
    {peaks.map((n, i) => { const h = Math.max(2, Math.round(n * 76)); return <rect key={i} x={i * 5} y={(80 - h) / 2} width={3} height={h} fill="currentColor"/>; })}
  </svg>;
});

type Marker = { at: number; label: string; tone: string };
/** A stretch of the track the next transition covers: where the outgoing deck leaves, or where the incoming one enters. */
type Region = { from: number; to: number; label: string; tone: string };
type WaveformProps = { id: DeckId; peaks: number[]; positions: DeckPositions; duration: number; enabled: boolean; markers: Marker[]; regions: Region[];
  onSeek: (fraction: number) => void; onStep: (seconds: number) => void; onBrowse: () => void };
/* The track overview, and a seek slider: click or drag to move, the arrows step 5 s (Page up and Page down 30 s), Home
   and End go to the ends. Empty, it says how to load a track and offers the file picker. */
function Waveform({ id, peaks, positions, duration, enabled, markers, regions, onSeek, onStep, onBrowse }: WaveformProps) {
  const position = useDeckPosition(positions, id);
  const progress = duration ? Math.max(0, Math.min(1, position / duration)) : 0;
  const root = useRef<HTMLDivElement>(null);
  const setProgress = useRef<((value: number) => void) | null>(null);
  const dragging = useRef(false);
  useGSAP(() => {
    gsap.set(root.current, { "--p": 0 });
    setProgress.current = gsap.quickTo(root.current, "--p", { duration: 0.2, ease: "none" });
  }, { scope: root });
  useEffect(() => { if (!dragging.current) setProgress.current?.(progress); }, [progress]);
  const fractionAt = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  const steps: Record<string, number> = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5, PageUp: 30, PageDown: -30 };
  const number = id === "A" ? 1 : 2;
  return <div ref={root} className="relative h-16 bg-well">
    {enabled ? <div role="slider" tabIndex={0} aria-label={`Seek deck ${number}`} aria-valuemin={0} aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(position)} aria-valuetext={`${formatTime(position)} of ${formatTime(duration)}`}
      aria-describedby={regions.length ? `${id}-mix-points` : undefined}
      className="absolute inset-0 cursor-pointer touch-none"
      onPointerDown={e => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); setProgress.current?.(fractionAt(e)); }}
      onPointerMove={e => { if (dragging.current) setProgress.current?.(fractionAt(e)); }}
      onPointerUp={e => { if (!dragging.current) return; dragging.current = false; onSeek(fractionAt(e)); }}
      onPointerCancel={() => { dragging.current = false; setProgress.current?.(progress); }}
      onKeyDown={e => {
        if (e.key === "Home" || e.key === "End") { e.preventDefault(); onSeek(e.key === "Home" ? 0 : 1); return; }
        const by = steps[e.key];
        if (by) { e.preventDefault(); onStep(by); }
      }}>
      <div className="text-line absolute inset-0"><Bars peaks={peaks}/></div>
      <div className="wave-progress glow text-data-1 absolute inset-0"><Bars peaks={peaks}/></div>
      {regions.map(r => <div key={r.label} title={r.label} style={{ "--from": `${r.from * 100}%`, "--span": `${Math.max(0, r.to - r.from) * 100}%` } as React.CSSProperties}
        className={cn("pointer-events-none absolute inset-y-0 left-(--from) w-(--span) bg-current opacity-15", r.tone)}/>)}
      {markers.map(m => <div key={m.label} title={m.label} style={{ "--at": `${m.at * 100}%` } as React.CSSProperties}
        className={cn("glow absolute inset-y-0 left-(--at) w-0.5", m.tone)}><span className="block size-full bg-current"/></div>)}
      <div className="wave-head absolute inset-y-0 w-px bg-text-1"/>
      {regions.length > 0 && <span id={`${id}-mix-points`} className="sr-only">{regions.map(r => r.label).join(". ")}</span>}
    </div> : <>
      <div className="text-line absolute inset-0" aria-hidden><Bars peaks={peaks}/></div>
      <div className="absolute inset-0 flex items-center justify-center gap-3 px-3">
        <p className="type-body-sm text-text-2 hidden sm:block">Drop a file here or load one from the library</p>
        <Button size="sm" variant="secondary" onClick={onBrowse} aria-label={`Load a file on deck ${number}`}><Icon icon={Upload}/>Load a file</Button>
      </div>
    </>}
  </div>;
}

type Props = {
  id: DeckId; deck: DeckState; track?: Track; selected: boolean; /** The next transition on this deck's track, in seconds: where the outgoing side leaves (start, end) and where the
      incoming side enters and is fully up (start, end). */
  marks: { out?: [number, number]; in?: [number, number] };
  onSelect: () => void; onPlay: () => void; onSkip: (beats: number) => void; onSync: () => void;
  onLoop: () => void; onSeek: (seconds: number) => void; onVolume: (value: number) => void; onBrowse: () => void;
  /** Why the deck plays but is not heard, and how to bring it back. */
  silent?: string | null; onHear?: () => void;
  /** The library, and the action that puts one of its tracks on this deck. Without them the header only names the track. */
  library?: Track[]; onLoadTrack?: (trackId: string) => void;
  /** The live playhead, read by the parts that show it so the card does not re-render as the deck plays. */
  positions: DeckPositions;
};

/* The time readout, on its own so only it re-renders, once a second, while the deck plays. */
function DeckTime({ id, positions, duration }: { id: DeckId; positions: DeckPositions; duration: number }) {
  const position = useDeckPosition(positions, id, 1);
  return <>{formatTime(position)}<StatusStripUnit>/ {formatTime(duration)}</StatusStripUnit></>;
}
export function DeckCard({ id, deck, track, selected, marks, onSelect, onPlay, onSkip, onSync, onLoop, onSeek, onVolume, onBrowse, silent, onHear, library, onLoadTrack, positions }: Props) {
  const number = id === "A" ? 1 : 2;
  const looping = deck.loopEnd !== null;
  const keys = DECK_KEYS[id];
  const at = (s: number) => Math.max(0, Math.min(1, s / deck.duration));
  const markers: Marker[] = deck.duration ? [
    ...(marks.out ? [{ at: at(marks.out[0]), label: `Mix out ${formatTime(marks.out[0])}`, tone: "text-data-6" },
      { at: at(marks.out[1]), label: `Mix out ends ${formatTime(marks.out[1])}`, tone: "text-data-6" }] : []),
    ...(marks.in ? [{ at: at(marks.in[0]), label: `Mix in ${formatTime(marks.in[0])}`, tone: "text-data-4" },
      { at: at(marks.in[1]), label: `Mix in complete ${formatTime(marks.in[1])}`, tone: "text-data-4" }] : []),
  ] : [];
  const regions: Region[] = deck.duration ? [
    ...(marks.out ? [{ from: at(marks.out[0]), to: at(marks.out[1]), label: `Mix out ${formatTime(marks.out[0])} to ${formatTime(marks.out[1])}`, tone: "text-data-6" }] : []),
    ...(marks.in ? [{ from: at(marks.in[0]), to: at(marks.in[1]), label: `Mix in ${formatTime(marks.in[0])} to ${formatTime(marks.in[1])}`, tone: "text-data-4" }] : []),
  ] : [];

  return <Frame data-deck={id} aria-label={`Deck ${number}`} onFocus={onSelect} onPointerDown={onSelect} variant={selected ? "panel" : "frame"} className="min-w-0 transition-colors duration-(--dur-state) ease-out">
    <FrameHeader>
      {track && <Cover track={track} size={22}/>}
      {library?.length && onLoadTrack
        ? <div className="min-w-0 flex-1" onPointerDown={e => e.stopPropagation()}>
            <Pick size="sm" value={track?.id ?? null} placeholder="Choose a track" aria-label={`Track on deck ${number}`}
              items={library.map(t => ({ value: t.id, label: `${t.title} · ${t.artist}` }))} onValueChange={onLoadTrack}/>
          </div>
        : <FrameTitle title={track ? `${track.title} · ${track.artist}` : undefined}>{track?.title ?? "No track loaded"}</FrameTitle>}
      <FrameStatus>
        {silent
          ? <Hint label={`${silent}. Click to hear this deck.`}>
              <Button size="sm" variant="ghost" onClick={onHear} aria-label={`Deck ${number} plays but is silent: ${silent}. Make it heard`}>
                <Status size="sm" status="warn"><TextSwap>Silent</TextSwap></Status>
              </Button>
            </Hint>
          : <Status size="sm" status={deck.playing ? "running" : track ? "paused" : "idle"}><TextSwap>{deck.playing ? "Playing" : track ? "Cued" : "Empty"}</TextSwap></Status>}
      </FrameStatus>
      <FrameValue meta>Deck {number}</FrameValue>
    </FrameHeader>
    <FrameBody padding="none">
      <StatusStrip variant="plain" label={`Deck ${number} readout`}>
        <StatusStripCell><StatusStripLabel>Time</StatusStripLabel><StatusStripValue><DeckTime id={id} positions={positions} duration={deck.duration}/></StatusStripValue></StatusStripCell>
        <StatusStripCell><StatusStripLabel>Tempo</StatusStripLabel><StatusStripValue>{track?.bpm ? (track.bpm * deck.rate).toFixed(1) : "-"}<StatusStripUnit>bpm</StatusStripUnit></StatusStripValue></StatusStripCell>
        <StatusStripCell><StatusStripLabel>Transition</StatusStripLabel><StatusStripValue>{marks.out ? `Out ${formatTime(marks.out[0])}` : marks.in ? `In ${formatTime(marks.in[0])}` : "-"}</StatusStripValue></StatusStripCell>
        <StatusStripCell><StatusStripLabel>Gain</StatusStripLabel><StatusStripValue>{deck.trim > 0 ? "+" : ""}{deck.trim.toFixed(1)}<StatusStripUnit>dB</StatusStripUnit></StatusStripValue></StatusStripCell>
      </StatusStrip>
    </FrameBody>
    <FrameBody padding="none">
      <Waveform id={id} peaks={track?.peaks?.length ? track.peaks : PLACEHOLDER} positions={positions} duration={deck.duration}
        enabled={!!track} markers={markers} regions={regions} onBrowse={onBrowse}
        onSeek={f => onSeek(f * deck.duration)} onStep={s => onSeek(Math.max(0, Math.min(deck.duration, positions.get(id) + s)))}/>
    </FrameBody>
    <FrameFooter>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        <Hint label={`${deck.playing ? "Pause" : "Play"} deck ${number}`} keys={keys.play}>
          <Button size="icon-sm" variant="ghost" onClick={onPlay} disabled={!track} aria-pressed={deck.playing} aria-label={`${deck.playing ? "Pause" : "Play"} deck ${number}`}><IconSwap active={deck.playing} from={Play} to={Pause}/></Button>
        </Hint>
        <Hint label="Jump back 4 beats">
          <Button size="icon-sm" variant="ghost" onClick={() => onSkip(-4)} disabled={!track} aria-label={`Jump deck ${number} back 4 beats`}><Icon icon={Previous}/></Button>
        </Hint>
        <Hint label="Jump forward 4 beats">
          <Button size="icon-sm" variant="ghost" onClick={() => onSkip(4)} disabled={!track} aria-label={`Jump deck ${number} forward 4 beats`}><Icon icon={Next}/></Button>
        </Hint>
        <Hint label={`Sync deck ${number} to the other deck`} keys={keys.sync}>
          <Button size="sm" variant="secondary" onClick={onSync} disabled={!track}>Sync tempo</Button>
        </Hint>
        <Hint label={looping ? "Exit loop" : "Loop 4 beats"}>
          <Button size="icon-sm" variant="ghost" onClick={onLoop} disabled={!track} aria-pressed={looping} aria-label={looping ? `Exit deck ${number} loop` : `Loop 4 beats on deck ${number}`}><Icon icon={Repeat}/></Button>
        </Hint>
        <div className="ms-auto flex min-w-32 flex-1 items-center gap-2">
          <Slider aria-label={`Deck ${number} volume`} min={0} max={100} value={Math.round(deck.volume * 100)}
            onValueChange={v => onVolume((Array.isArray(v) ? v[0] : v) / 100)} format={{ style: "unit", unit: "percent" }} showValue/>
        </div>
        <Hint label={`Load a file on deck ${number}`}>
          <Button size="icon-sm" variant="ghost" onClick={onBrowse} aria-label={`Load a file on deck ${number}`}><Icon icon={Upload}/></Button>
        </Hint>
      </div>
    </FrameFooter>
  </Frame>;
}
