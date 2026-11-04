"use client";

import { useEffect, useRef, useState } from "react";
import { gsap, useGSAP } from "@/lib/gsap";
import { cn } from "@/lib/sodium/utils";
import { EFFECTS, STEMS, formatTime, type DeckId, type DeckState, type EffectName, type Track } from "@/lib/types";
import type { DJ } from "@/hooks/use-dj";
import { DECK_KEYS, MIX_KEY } from "@/hooks/use-shortcuts";
import { Kbd } from "@/components/sodium/ui/kbd";
import { Hint } from "@/components/hint";
import { IconSwap, TextSwap } from "@/components/motion";
import { Frame, FrameActions, FrameBody, FrameHeader, FrameStatus, FrameTitle, FrameValue } from "@/components/sodium/ui/frame";
import { Button } from "@/components/sodium/ui/button";
import { ButtonGroup, ButtonGroupText } from "@/components/sodium/ui/button-group";
import { SegmentedControl, SegmentedControlItem } from "@/components/sodium/ui/segmented-control";
import { Slider } from "@/components/sodium/ui/slider";
import { Meter, MeterLabel, MeterValue } from "@/components/sodium/ui/meter";
import { Pick } from "@/components/pick";
import { Switch } from "@/components/sodium/ui/switch";
import { Field, FieldLabel } from "@/components/sodium/ui/field";
import { Status } from "@/components/sodium/ui/status";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/sodium/ui/tooltip";
import { Add, Icon, Keyboard, Pause, Play, Subtract } from "@/components/sodium/icon";
import { ECHO_BEATS, beatsLabel as fxBeatsLabel } from "@/lib/transition-options";
import { useDeckPosition, type DeckPositions } from "@/hooks/use-deck-position";

const deckName = (id: DeckId) => `Deck ${id === "A" ? 1 : 2}`;
const first = (v: number | readonly number[]) => Array.isArray(v) ? v[0] : v as number;
const beatsLabel = (n: number) => n < 1 ? `1/${1 / n}` : String(n);
const db = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
const pct = (v: number) => `${Math.round(v * 100)}%`;

/* Sodium has no rotary control. This one is drawn as a flat gauge from Sodium's line and data tokens, and behaves as an
   ARIA slider: arrows step (Shift for fine steps), Page up and Page down jump, Home and End go to the ends, Delete or a
   double-click resets. Its tooltip carries the live value, so it reads while it turns. */
type KnobProps = { label: string; value: number; min: number; max: number; reset?: number; format?: (v: number) => string; tone?: string; className?: string; onChange: (value: number) => void };
export function Knob({ label, value, min, max, reset = 0, format = String, tone = "text-data-1", className, onChange }: KnobProps) {
  const needle = useRef<SVGGElement>(null);
  const turn = useRef<((angle: number) => void) | null>(null);
  // The drag builds on its own running value, not the prop: several moves can land before React renders the last one.
  const drag = useRef<{ y: number; value: number } | null>(null);
  const fraction = (value - min) / (max - min);
  const angle = -135 + fraction * 270;
  const arc = 2 * Math.PI * 19 * 0.75;
  useGSAP(() => {
    gsap.set(needle.current, { svgOrigin: "24 24" });
    turn.current = gsap.quickTo(needle.current, "rotation", { duration: 0.25, ease: "power2.out" });
  });
  useEffect(() => { turn.current?.(angle); }, [angle]);
  const step = (max - min) / 30;
  const set = (next: number) => onChange(Math.max(min, Math.min(max, Math.round(next * 1000) / 1000)));
  const keys: Record<string, (fine: boolean) => number> = {
    ArrowUp: fine => value + (fine ? step / 5 : step), ArrowRight: fine => value + (fine ? step / 5 : step),
    ArrowDown: fine => value - (fine ? step / 5 : step), ArrowLeft: fine => value - (fine ? step / 5 : step),
    PageUp: () => value + step * 5, PageDown: () => value - step * 5,
    Home: () => min, End: () => max, Delete: () => reset, Backspace: () => reset,
  };
  const text = format(value);
  return <Tooltip>
    <TooltipTrigger closeOnClick={false} render={<div/>} role="slider" tabIndex={0} aria-label={label} aria-orientation="vertical"
      aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} aria-valuetext={text}
      className={cn("size-11 shrink-0 cursor-ns-resize touch-none select-none", className)} draggable={false}
      onDoubleClick={() => onChange(reset)}
      onPointerDown={e => {
        if (e.button !== 0) return;
        e.preventDefault(); // no text selection or native drag to steal the gesture
        e.currentTarget.focus({ preventScroll: true });
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, value };
      }}
      onPointerMove={e => {
        const d = drag.current;
        if (!d) return;
        const dy = d.y - e.clientY;
        d.y = e.clientY;
        if (!dy) return;
        d.value = Math.max(min, Math.min(max, d.value + dy * (max - min) / (e.shiftKey ? 800 : 160)));
        set(d.value);
      }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
      onKeyDown={e => { const to = keys[e.key]; if (!to) return; e.preventDefault(); set(to(e.shiftKey)); }}>
      <svg viewBox="0 0 48 48" className="size-full overflow-visible" aria-hidden>
        <circle cx={24} cy={24} r={19} fill="none" stroke="currentColor" strokeWidth={1} strokeDasharray={`${arc} 200`} transform="rotate(135 24 24)" className="text-line-control"/>
        <circle cx={24} cy={24} r={19} fill="none" stroke="currentColor" strokeWidth={2} strokeDasharray={`${arc * fraction} 200`} transform="rotate(135 24 24)" className={cn("glow", tone)}/>
        <circle cx={24} cy={24} r={13} fill="none" stroke="currentColor" strokeWidth={1} className="text-line"/>
        <g ref={needle}><line x1={24} y1={24} x2={24} y2={12} stroke="currentColor" strokeWidth={1.5} className="text-text-1"/></g>
      </svg>
    </TooltipTrigger>
    <TooltipContent>{`${label} ${text}`}</TooltipContent>
  </Tooltip>;
}

/* A turntable platter in Sodium's line language: 1px rules, the deck's data tone for the mark. Drag, the arrow keys or,
   once it has focus, the scroll wheel nudge the track. */
function Jog({ id, deck, positions, enabled, onNudge }: { id: DeckId; deck: DeckState; positions: DeckPositions; enabled: boolean; onNudge: (seconds: number) => void }) {
  // Whole seconds: the readout and the slider values show no finer, so the platter re-renders once a second.
  const position = useDeckPosition(positions, id, 1);
  const root = useRef<HTMLDivElement>(null);
  const platter = useRef<SVGGElement>(null);
  const live = useRef({ playing: false, rate: 1, angle: 0 });
  const prev = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => { live.current.playing = deck.playing; live.current.rate = deck.rate; }, [deck.playing, deck.rate]);
  useGSAP(() => {
    gsap.set(platter.current, { svgOrigin: "100 100" });
    const setRotation = gsap.quickSetter(platter.current, "rotation", "deg");
    const tick = (_time: number, delta: number) => {
      if (!live.current.playing) return;
      live.current.angle += delta * 0.2 * live.current.rate; // 33⅓ rpm
      setRotation(live.current.angle);
    };
    gsap.ticker.add(tick);
    return () => gsap.ticker.remove(tick);
  });
  /* Turning the platter by degrees moves the track as a record would: one turn is 1.8 s at 33⅓ rpm. */
  const scrub = (degrees: number) => {
    if (!enabled) return;
    live.current.angle += degrees;
    gsap.set(platter.current, { rotation: live.current.angle });
    onNudge(degrees / 360 * 1.8);
  };
  const scrubRef = useRef(scrub);
  useEffect(() => { scrubRef.current = scrub; });
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    // Only once the platter has focus, so a page scroll that passes over it never moves the track.
    const onWheel = (e: WheelEvent) => { if (document.activeElement !== el) return; e.preventDefault(); scrubRef.current(e.deltaY > 0 ? -20 : 20); };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  const remaining = Math.max(0, deck.duration - position);
  return <Tooltip>
    <TooltipTrigger render={<div ref={root}/>} role="slider" tabIndex={enabled ? 0 : -1} aria-disabled={!enabled || undefined}
      aria-label={`${deckName(id)} jog wheel`} aria-valuemin={0} aria-valuemax={Math.round(deck.duration)} aria-valuenow={Math.round(position)}
      aria-valuetext={enabled ? `${formatTime(position)} of ${formatTime(deck.duration)}` : "No track"}
      className={cn("aspect-square w-full max-w-md touch-none select-none", enabled ? "cursor-grab active:cursor-grabbing" : "cursor-not-allowed opacity-60")} draggable={false}
      onPointerDown={e => {
        if (!enabled || e.button !== 0) return;
        e.preventDefault(); // no text selection or native drag to steal the gesture
        e.currentTarget.focus({ preventScroll: true });
        e.currentTarget.setPointerCapture(e.pointerId);
        prev.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerMove={e => {
        const p = prev.current, el = root.current;
        if (!p || !el) return;
        const box = el.getBoundingClientRect(), cx = box.left + box.width / 2, cy = box.top + box.height / 2;
        const near = Math.hypot(p.x - cx, p.y - cy) < box.width * 0.12; // too close to the spindle for an angle to mean anything
        let turn = near ? (e.clientX - p.x) * 1.5
          : (Math.atan2(e.clientY - cy, e.clientX - cx) - Math.atan2(p.y - cy, p.x - cx)) * 180 / Math.PI;
        if (turn > 180) turn -= 360; else if (turn < -180) turn += 360;
        prev.current = { x: e.clientX, y: e.clientY };
        if (turn) scrub(turn);
      }}
      onPointerUp={() => { prev.current = null; }} onPointerCancel={() => { prev.current = null; }} onLostPointerCapture={() => { prev.current = null; }}
      onKeyDown={e => {
        if (!enabled) return;
        const dir = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : 0;
        if (!dir) return;
        e.preventDefault();
        onNudge(dir * (e.shiftKey ? 0.1 : 0.5));
      }}>
      <svg viewBox="0 0 200 200" className="size-full overflow-visible" aria-hidden>
        <circle cx={100} cy={100} r={97} fill="none" stroke="currentColor" strokeWidth={deck.playing ? 2 : 1} className={deck.playing ? "glow text-data-1" : "text-line-control"}/>
        <circle cx={100} cy={100} r={58} fill="none" stroke="currentColor" strokeWidth={1} className="text-line"/>
        <g ref={platter}>
          {Array.from({ length: 72 }, (_, i) => <line key={i} x1={100} y1={i % 6 ? 8 : 4} x2={100} y2={16} stroke="currentColor" strokeWidth={1}
            transform={`rotate(${i * 5} 100 100)`} className="text-line-control"/>)}
          <line x1={100} y1={4} x2={100} y2={42} stroke="currentColor" strokeWidth={3} className="glow text-data-1"/>
        </g>
        <text x={100} y={96} textAnchor="middle" fill="currentColor" className="type-micro text-text-3">Remain</text>
        <text x={100} y={114} textAnchor="middle" fill="currentColor" className="type-code text-text-1">-{formatTime(remaining)}</text>
      </svg>
    </TooltipTrigger>
    <TooltipContent>{enabled ? "Drag around the platter, or focus it and use ← → (⇧ for fine) or scroll" : "Load a track to use the jog wheel"}</TooltipContent>
  </Tooltip>;
}

function LevelMeter({ id, level }: { id: DeckId; level: (id: DeckId) => number }) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    let peak = 0, frame = 0;
    const tick = () => {
      peak = Math.max(Math.min(1, level(id) * 1.7), peak - 0.03);
      if (++frame % 3 === 0) setValue(Math.round(peak * 100));
    };
    gsap.ticker.add(tick);
    return () => gsap.ticker.remove(tick);
  }, [id, level]);
  return <Meter size="sm" value={value} warnAt={0.85} failAt={0.98} statusLabel="Hot" className="w-full">
    <MeterLabel>{deckName(id)}</MeterLabel>
    <MeterValue>{(_, v) => `${v}%`}</MeterValue>
  </Meter>;
}

type PadMode = "hotcue" | "padfx" | "jump" | "loop" | "stems";
const JUMPS = [-1, 1, -2, 2, -4, 4, -8, 8];
const LOOPS = [0.25, 0.5, 1, 2, 4, 8, 16, 32];
const PAD_FX: { fx: Exclude<EffectName, "off">; amount: number; label: string }[] = [
  ...EFFECTS.map(e => ({ fx: e.id, amount: 0.5, label: e.label })),
  { fx: "echo", amount: 0.9, label: "Echo out" }, { fx: "reverb", amount: 0.9, label: "Wash" },
];
/** The stem pads' second row: which stems each one leaves sounding, in STEMS order. The pads are narrow, so the
    labels are DJ shorthand and the spoken names say it in full. */
const STEM_SETS: { label: string; spoken: string; on: boolean[] }[] = [
  { label: "Vox", spoken: "Vocals only", on: [true, false, false, false] },
  { label: "Inst", spoken: "Everything but the vocals", on: [false, true, true, true] },
  { label: "Beat", spoken: "Drums and bass only", on: [false, true, true, false] },
  { label: "All", spoken: "All stems", on: [true, true, true, true] },
];
const sameSet = (a: boolean[], b: boolean[]) => a.every((v, i) => v === b[i]);

function Pads({ id, deck, mode, disabled, dj }: { id: DeckId; deck: DeckState; mode: PadMode; disabled: boolean; dj: DJ }) {
  const looping = deck.loopEnd !== null;
  const lit = (i: number) => mode === "hotcue" ? deck.hotCues[i] !== null
    : mode === "padfx" ? deck.fx === PAD_FX[i].fx && deck.fxAmount === PAD_FX[i].amount
    : mode === "loop" ? looping && deck.loopBeats === LOOPS[i]
    : mode === "stems" ? (i < 4 ? deck.stems[i] : sameSet(deck.stems, STEM_SETS[i - 4].on)) : false;
  const label = (i: number) => mode === "hotcue" ? String(i + 1) : mode === "padfx" ? PAD_FX[i].label
    : mode === "jump" ? (JUMPS[i] > 0 ? `+${JUMPS[i]}` : String(JUMPS[i]))
    : mode === "stems" ? (i < 4 ? STEMS[i].label : STEM_SETS[i - 4].label) : beatsLabel(LOOPS[i]);
  // What a screen reader hears for each pad: the bare numbers on the pads only make sense beside the mode.
  const spoken = (i: number) => mode === "hotcue" ? `Hot cue ${i + 1}${deck.hotCues[i] === null ? ", empty: press to set" : ""}`
    : mode === "padfx" ? `${PAD_FX[i].label} effect`
    : mode === "jump" ? `Jump ${JUMPS[i] > 0 ? "forward" : "back"} ${Math.abs(JUMPS[i])} ${Math.abs(JUMPS[i]) === 1 ? "beat" : "beats"}`
    : mode === "stems" ? (i < 4 ? `${STEMS[i].label} ${deck.stems[i] ? "on" : "muted"}` : STEM_SETS[i - 4].spoken)
    : `Loop ${beatsLabel(LOOPS[i])} ${LOOPS[i] <= 1 ? "beat" : "beats"}`;
  const keyFor = (i: number) => mode === "hotcue" ? DECK_KEYS[id].cues[i] : undefined;
  const press = (i: number) => {
    if (mode === "hotcue") dj.pad(id, i);
    else if (mode === "padfx") dj.fx(id, lit(i) ? "off" : PAD_FX[i].fx, PAD_FX[i].amount);
    else if (mode === "jump") dj.skipBeats(id, JUMPS[i]);
    else if (mode === "stems") { if (i < 4) dj.toggleStem(id, i); else dj.stems(id, STEM_SETS[i - 4].on); }
    else dj.beatLoop(id, LOOPS[i]);
  };
  // Each row is a multi-toggle: its value is the lit pads, and a press on any pad (on or off) runs that pad.
  const row = (start: number) => {
    const value = [0, 1, 2, 3].map(n => start + n).filter(lit).map(String);
    return <SegmentedControl multiple fill size="lg" aria-label={`${deckName(id)} pads ${start + 1} to ${start + 4}`} value={value}
      onValueChange={next => {
        const changed = [...next.filter(v => !value.includes(v)), ...value.filter(v => !next.includes(v))][0];
        if (changed !== undefined) press(Number(changed));
      }}>
      {[0, 1, 2, 3].map(n => <SegmentedControlItem key={n} value={String(start + n)} disabled={disabled} aria-label={spoken(start + n)}
        aria-keyshortcuts={keyFor(start + n)}>{label(start + n)}</SegmentedControlItem>)}
    </SegmentedControl>;
  };
  return <div className="flex min-w-0 flex-1 flex-col gap-2">{row(0)}{row(4)}</div>;
}

/* In the stems pad mode, a track without stems gets the way to make them in place of the pads. */
function StemPrompt({ track, dj }: { track: Track; dj: DJ }) {
  const progress = dj.splitting[track.id];
  const busy = progress !== undefined;
  const text = busy ? `Separating vocals, drums, bass and melody: ${pct(progress)}`
    : dj.stemsAvailable === false ? "Stem separation needs Demucs on this machine: run npm run setup:stems."
    : "This track has no stems yet. Demucs splits it into vocals, drums, bass and melody.";
  return <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
    <p className="type-body-sm text-text-2" aria-live="polite">{text}</p>
    <Button size="sm" variant="secondary" pending={busy} pendingLabel="Splitting" disabled={!dj.stemsAvailable}
      onClick={() => void dj.splitStems(track.id)}>Split stems</Button>
  </div>;
}

/* One deck's performance side. Narrow, it stacks: transport, platter, pad mode, pads. Once the panel is 42rem wide
   (stacked on a tablet), the platter takes one half and the transport and pads the other, so neither half sits empty.
   Deck 2 mirrors deck 1, with its tempo fader and platter on the outside edge. */
function DeckPanel({ id, deck, track, mirror, dj, className }: { id: DeckId; deck: DeckState; track?: Track; mirror: boolean; dj: DJ; className?: string }) {
  const [mode, setMode] = useState<PadMode>("hotcue");
  const name = deckName(id);
  const hasTrack = !!track;
  const looping = deck.loopEnd !== null;
  const shift = (deck.rate - 1) * 100;
  const keys = DECK_KEYS[id];
  const side = mirror ? "flex-row-reverse" : "flex-row";
  const platterCol = mirror ? "@2xl:col-start-2" : "@2xl:col-start-1";
  const controlCol = mirror ? "@2xl:col-start-1" : "@2xl:col-start-2";

  return <section data-deck={id} aria-label={`${name} controls`} className={cn("@container flex min-w-0 flex-col", className)}>
    <div className="panel-head">
      <span className="shrink-0">{name}</span>
      {dj.silent[id]
        ? <Hint label={`${dj.silent[id]}. Click to hear this deck.`}>
            <Button size="sm" variant="ghost" onClick={() => dj.makeHeard(id)} aria-label={`${name} plays but is silent: ${dj.silent[id]}. Make it heard`}>
              <Status size="sm" status="warn"><TextSwap>Silent</TextSwap></Status>
            </Button>
          </Hint>
        : <Status size="sm" status={deck.playing ? "running" : hasTrack ? "paused" : "idle"}><TextSwap>{deck.playing ? "Playing" : hasTrack ? "Cued" : "Empty"}</TextSwap></Status>}
      {track && <span className="ms-auto min-w-0 truncate type-code-sm text-text-2" title={track.title}>{track.title}</span>}
    </div>

    <div className="grid flex-1 grid-rows-[auto_1fr_auto_auto] @2xl:grid-cols-2 @2xl:grid-rows-[auto_auto_1fr]">
      <div className={cn("flex flex-wrap items-center gap-2 border-b border-line-faint p-3 @2xl:row-start-1", controlCol, mirror && "flex-row-reverse")}>
        <ButtonGroup aria-label={`${name} loop`}>
          <Button size="sm" variant="secondary" disabled={!hasTrack} onClick={() => dj.loopIn(id)} aria-label={`Set ${name.toLowerCase()} loop in`}>In</Button>
          <Button size="sm" variant="secondary" disabled={!hasTrack} onClick={() => dj.loopOut(id)} aria-label={`Set ${name.toLowerCase()} loop out`}>Out</Button>
          <Button size="sm" variant="secondary" disabled={!hasTrack} aria-pressed={looping} onClick={() => looping ? dj.toggleLoop(id) : dj.beatLoop(id, 4)}
            aria-label={looping ? `Exit ${name.toLowerCase()} loop` : `Loop 4 beats on ${name.toLowerCase()}`}><TextSwap>{looping ? "Exit" : "Auto"}</TextSwap></Button>
        </ButtonGroup>
        <ButtonGroup aria-label={`${name} loop length`}>
          <Button size="icon-sm" variant="secondary" disabled={!hasTrack} onClick={() => dj.resizeLoop(id, 0.5)} aria-label={`Halve ${name.toLowerCase()} loop`}><Icon icon={Subtract}/></Button>
          <ButtonGroupText>{beatsLabel(deck.loopBeats)} beats</ButtonGroupText>
          <Button size="icon-sm" variant="secondary" disabled={!hasTrack} onClick={() => dj.resizeLoop(id, 2)} aria-label={`Double ${name.toLowerCase()} loop`}><Icon icon={Add}/></Button>
        </ButtonGroup>
        <Hint label={`Sync ${name.toLowerCase()} to the other deck`} keys={keys.sync}>
          <Button size="sm" variant="secondary" disabled={!hasTrack} onClick={() => dj.sync(id)} className={mirror ? "me-auto" : "ms-auto"}>Sync</Button>
        </Hint>
      </div>

      <div className={cn("flex min-h-0 items-center gap-4 border-b border-line-faint p-4 @2xl:row-span-3 @2xl:row-start-1 @2xl:border-b-0", platterCol,
        mirror ? "@2xl:border-s" : "@2xl:border-e", side)}>
        <div className="flex w-16 shrink-0 flex-col items-center gap-2 self-stretch">
          <span className="type-label-sm text-text-2" aria-hidden>Tempo</span>
          <Slider orientation="vertical" min={-25} max={25} step={0.1} value={Math.round(shift * 10) / 10} disabled={!hasTrack}
            format={{ style: "unit", unit: "percent", signDisplay: "exceptZero", maximumFractionDigits: 1 }}
            aria-label={`${name} tempo`} onValueChange={v => dj.setRate(id, 1 + first(v) / 100)} className="flex-1"/>
          <span className="type-code-sm text-text-1" aria-hidden>{shift >= 0 ? "+" : ""}{shift.toFixed(1)}%</span>
          <Button size="sm" variant="ghost" disabled={!hasTrack || deck.rate === 1} onClick={() => dj.setRate(id, 1)} aria-label={`Reset ${name.toLowerCase()} tempo`}>Reset</Button>
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-center">
          <Jog id={id} deck={deck} positions={dj.positions} enabled={hasTrack} onNudge={n => dj.nudge(id, n)}/>
        </div>
      </div>

      <div className={cn("border-b border-line-faint p-3 @2xl:row-start-2", controlCol)}>
        <SegmentedControl fill size="sm" aria-label={`${name} pad mode`} value={mode} onValueChange={v => setMode(v as PadMode)}>
          <SegmentedControlItem value="hotcue">Hot cue</SegmentedControlItem>
          <SegmentedControlItem value="padfx">Pad fx</SegmentedControlItem>
          <SegmentedControlItem value="jump">Jump</SegmentedControlItem>
          <SegmentedControlItem value="loop">Loop</SegmentedControlItem>
          <SegmentedControlItem value="stems">Stems</SegmentedControlItem>
        </SegmentedControl>
      </div>

      <div className={cn("flex items-center gap-3 p-3 @2xl:row-start-3", controlCol, side)}>
        <div className="flex w-16 shrink-0 flex-col gap-2">
          <Hint label={`Cue ${name.toLowerCase()}`} keys={keys.cue}>
            <Button size="lg" variant="secondary" disabled={!hasTrack} onClick={() => dj.cue(id)} className="w-full">Cue</Button>
          </Hint>
          <Hint label={`${deck.playing ? "Pause" : "Play"} ${name.toLowerCase()}`} keys={keys.play}>
            <Button size="lg" variant="secondary" disabled={!hasTrack} onClick={() => void dj.togglePlay(id)} aria-pressed={deck.playing}
              aria-label={`${deck.playing ? "Pause" : "Play"} ${name.toLowerCase()}`} className="w-full"><IconSwap active={deck.playing} from={Play} to={Pause}/></Button>
          </Hint>
        </div>
        {mode === "stems" && track && !track.stems ? <StemPrompt track={track} dj={dj}/>
          : <Pads id={id} deck={deck} mode={mode} disabled={!hasTrack || (mode === "stems" && !track?.stems)} dj={dj}/>}
      </div>
    </div>
  </section>;
}

const BAND_TONE = { high: "text-data-3", mid: "text-data-4", low: "text-data-5" } as const;

/* One channel strip row: deck 1's control, the row's name in the middle, deck 2's control mirrored. */
function StripRow({ label, a, b }: { label: string; a: React.ReactNode; b: React.ReactNode }) {
  return <div className="grid grid-cols-3 items-center justify-items-center px-3 py-0.5">
    <div data-deck="A">{a}</div><span className="type-label-sm text-text-3" aria-hidden>{label}</span><div data-deck="B">{b}</div>
  </div>;
}

/* The channel strips, levels, faders and crossfader. In the three-column console it is one column; stacked on a tablet,
   the strips take one half and the faders the other. */
function Mixer({ dj, className }: { dj: DJ; className?: string }) {
  const { A, B } = dj.decks;
  const bands = [["high", "Hi"], ["mid", "Mid"], ["low", "Low"]] as const;
  const fader = { style: "unit", unit: "percent" } as const;

  return <section aria-label="Mixer" className={cn("@container flex min-w-0 flex-col", className)}>
    <div className="panel-head"><span>Mixer</span><span className="ms-auto type-code-sm text-text-2">Master {pct(dj.master)}</span></div>

    <div className="grid flex-1 @2xl:grid-cols-2">
      <div className="flex flex-col justify-center border-b border-line-faint py-2 @2xl:border-e @2xl:border-b-0 @2xl:border-line">
        <StripRow label="Trim" a={<Knob label="Deck 1 trim" value={A.trim} min={-12} max={12} format={db} onChange={n => dj.trim("A", n)}/>}
          b={<Knob label="Deck 2 trim" value={B.trim} min={-12} max={12} format={db} onChange={n => dj.trim("B", n)}/>}/>
        {bands.map(([band, label]) => <StripRow key={band} label={label}
          a={<Knob label={`Deck 1 ${label.toLowerCase()}`} value={A.eq[band]} min={-24} max={12} format={db} tone={BAND_TONE[band]} onChange={n => dj.eq("A", band, n)}/>}
          b={<Knob label={`Deck 2 ${label.toLowerCase()}`} value={B.eq[band]} min={-24} max={12} format={db} tone={BAND_TONE[band]} onChange={n => dj.eq("B", band, n)}/>}/>)}
        <StripRow label="Color" a={<Knob label="Deck 1 color filter" value={A.color} min={-1} max={1} format={pct} onChange={n => dj.color("A", n)}/>}
          b={<Knob label="Deck 2 color filter" value={B.color} min={-1} max={1} format={pct} onChange={n => dj.color("B", n)}/>}/>
      </div>

      <div className="flex min-w-0 flex-col">
        <div className="grid grid-cols-2 gap-4 border-b border-line-faint p-3">
          <div data-deck="A"><LevelMeter id="A" level={dj.level}/></div>
          <div data-deck="B"><LevelMeter id="B" level={dj.level}/></div>
        </div>

        <div className="grid flex-1 grid-cols-3 items-stretch justify-items-center border-b border-line-faint p-3">
          <div data-deck="A" className="flex"><Slider orientation="vertical" min={0} max={100} value={Math.round(A.volume * 100)} format={fader}
            aria-label="Deck 1 channel fader" onValueChange={v => dj.volume("A", first(v) / 100)}/></div>
          <div className="flex flex-col items-center justify-center gap-1">
            <Knob label="Master level" value={dj.master} min={0} max={1} reset={0.9} format={pct} tone="text-data-6" onChange={dj.setMaster}/>
            <span className="type-label-sm text-text-3" aria-hidden>Master</span>
          </div>
          <div data-deck="B" className="flex"><Slider orientation="vertical" min={0} max={100} value={Math.round(B.volume * 100)} format={fader}
            aria-label="Deck 2 channel fader" onValueChange={v => dj.volume("B", first(v) / 100)}/></div>
        </div>

        <div className="flex flex-col gap-1 p-3">
          <Slider min={-100} max={100} value={Math.round(dj.cross * 100)} aria-label={dj.transition ? "Crossfader, moved by the running mix" : "Crossfader"}
            disabled={!!dj.transition} onValueChange={v => dj.crossfade(first(v) / 100)}/>
          <div className="flex justify-between" aria-hidden>
            <span className="type-label-sm text-text-3">Deck 1</span>
            <span className="type-label-sm text-text-3">{dj.transition ? "Mixing" : "Crossfader"}</span>
            <span className="type-label-sm text-text-3">Deck 2</span>
          </div>
        </div>
      </div>
    </div>
  </section>;
}

/* The effects unit: one ruled row under the console, its state read back at the row's end. */
function BeatFx({ dj }: { dj: DJ }) {
  const [effect, setEffect] = useState<Exclude<EffectName, "off">>("echo");
  const [target, setTarget] = useState<"A" | "B" | "AB">("AB");
  const ids: DeckId[] = target === "AB" ? ["A", "B"] : [target];
  const fxOn = ids.some(id => dj.decks[id].fx === effect);
  const depth = dj.decks[ids[0]].fxAmount;
  const beats = dj.decks[ids[0]].fxBeats;
  // Heard length of the effect's time on the first targeted deck, so the division reads in ms too.
  const track = ids[0] === "A" ? dj.trackA : dj.trackB;
  const timeMs = track?.bpm ? Math.round(60 / (track.bpm * (dj.decks[ids[0]].rate || 1)) * beats * 1000) : null;
  const timed = effect === "echo" || effect === "flanger" || effect === "phaser";
  const apply = (fx: EffectName, targets = ids) => targets.forEach(id => dj.fx(id, fx, depth));
  const effectLabel = EFFECTS.find(e => e.id === effect)?.label ?? "";
  const targetLabel = target === "AB" ? "both decks" : deckName(target).toLowerCase();

  return <section aria-label="Beat fx" className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-line p-3">
    <Field orientation="horizontal" className="w-auto gap-2">
      <Switch size="sm" checked={fxOn} onCheckedChange={on => apply(on ? effect : "off")}/>
      <FieldLabel>Beat fx</FieldLabel>
    </Field>
    <Field orientation="horizontal" className="w-auto gap-2">
      <FieldLabel>Effect</FieldLabel>
      <Pick items={EFFECTS.map(e => ({ value: e.id, label: e.label }))} value={effect} className="w-32"
        onValueChange={v => { const next = v as Exclude<EffectName, "off">; setEffect(next); if (fxOn) ids.forEach(id => dj.fx(id, next, depth)); }}/>
    </Field>
    <SegmentedControl size="sm" aria-label="Effect channel" value={target}
      onValueChange={v => { if (fxOn) apply("off"); setTarget(v as "A" | "B" | "AB"); }}>
      <SegmentedControlItem value="A">Deck 1</SegmentedControlItem>
      <SegmentedControlItem value="B">Deck 2</SegmentedControlItem>
      <SegmentedControlItem value="AB">Both</SegmentedControlItem>
    </SegmentedControl>
    <div className="flex items-center gap-2">
      <Knob label="Effect depth" value={depth} min={0} max={1} reset={0.45} format={pct} tone="text-data-3"
        onChange={n => ids.forEach(id => fxOn ? dj.fx(id, effect, n) : dj.fxAmount(id, n))}/>
      <span className="type-label-sm text-text-2" aria-hidden>Depth {pct(depth)}</span>
    </div>
    {timed && <div className="flex items-center gap-2">
      <SegmentedControl size="sm" aria-label="Effect time in beats" value={String(beats)} onValueChange={v => ids.forEach(id => dj.fxBeats(id, Number(v)))}>
        {ECHO_BEATS.map(n => <SegmentedControlItem key={n} value={String(n)}>{fxBeatsLabel(n)}</SegmentedControlItem>)}
      </SegmentedControl>
      <span className="type-label-sm text-text-2" aria-hidden>{effect === "echo" ? "beat" : "× 4 beats sweep"}{timeMs ? ` · ${timeMs} ms` : " · no tempo"}</span>
    </div>}
    <span className="ms-auto type-code-sm text-text-2" aria-live="polite"><TextSwap>{fxOn ? `${effectLabel} on ${targetLabel}` : "Effects off"}</TextSwap></span>
  </section>;
}

/* The console's keys, written out under it: how to move through the controls, how to turn them, and the play keys. */
function KeyGuide({ onShortcuts }: { onShortcuts: () => void }) {
  const A = DECK_KEYS.A, B = DECK_KEYS.B;
  const item = (keys: string[], text: string) => <li className="flex items-center gap-2">
    <span className="flex items-center gap-1">{keys.map(k => <Kbd key={k} keys={k}/>)}</span><span className="type-body-sm text-text-2">{text}</span>
  </li>;
  return <section aria-label="Keyboard guide" className="flex flex-col gap-2 border-t border-line p-3">
    <div className="flex items-center gap-3">
      <h3 className="type-label-sm text-text-2">Keyboard</h3>
      <Button size="sm" variant="ghost" onClick={onShortcuts} className="ms-auto">All shortcuts <Kbd keys="?"/></Button>
    </div>
    <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2 xl:grid-cols-3">
      {item(["tab"], "Move between controls")}
      {item(["left", "right", "up", "down"], "Turn a knob, nudge a fader or the jog wheel")}
      {item(["shift"], "Hold for fine steps")}
      {item(["backspace"], "Reset a focused knob")}
      {item(["home", "end"], "Jump a knob to its ends")}
      {item(["space"], "Press the focused button or pad")}
      {item([A.play, A.cue, A.sync], "Deck 1: play, cue, sync")}
      {item([...A.cues], "Deck 1 hot cues")}
      {item([B.play, B.cue, B.sync], "Deck 2: play, cue, sync")}
      {item([...B.cues], "Deck 2 hot cues")}
      {item(["z", "x", "c"], "Crossfader: toward deck 1, center, deck 2")}
      {item([MIX_KEY], "Mix now, or stop the mix")}
    </ul>
  </section>;
}

export function Console({ dj, onShortcuts }: { dj: DJ; onShortcuts: () => void }) {
  const live = dj.decks.A.playing || dj.decks.B.playing;
  return <Frame aria-label="Controller" id="controller">
    <FrameHeader>
      <FrameTitle>Controller</FrameTitle>
      <FrameStatus><Status size="sm" status={live ? "running" : "idle"}><TextSwap>{live ? "Live" : "Idle"}</TextSwap></Status></FrameStatus>
      <FrameValue meta className="hidden sm:inline">Crossfader {dj.cross === 0 ? "center" : dj.cross < 0 ? "deck 1" : "deck 2"}</FrameValue>
      <FrameActions>
        <Hint label="Keyboard shortcuts" keys="?">
          <Button size="icon-sm" variant="ghost" onClick={onShortcuts} aria-label="Keyboard shortcuts"><Icon icon={Keyboard}/></Button>
        </Hint>
      </FrameActions>
    </FrameHeader>
    <FrameBody padding="none">
      <div className="flex flex-col lg:flex-row">
        <DeckPanel id="A" deck={dj.decks.A} track={dj.trackA} mirror={false} dj={dj} className="border-b border-line lg:flex-1 lg:border-e lg:border-b-0"/>
        <Mixer dj={dj} className="border-b border-line lg:w-72 lg:shrink-0 lg:border-e lg:border-b-0 xl:w-80"/>
        <DeckPanel id="B" deck={dj.decks.B} track={dj.trackB} mirror dj={dj} className="lg:flex-1"/>
      </div>
      <BeatFx dj={dj}/>
      <KeyGuide onShortcuts={onShortcuts}/>
    </FrameBody>
  </Frame>;
}
