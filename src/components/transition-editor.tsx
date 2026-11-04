"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/sodium/utils";
import { formatTime, type CurvePoint, type CustomCurve, type DeckId, type DeckState, type Track, type TransitionEffect, type TransitionEq, type TransitionPlan, type TransitionPreset, type TransitionStems, type VolumeCurve } from "@/lib/types";
import { PRESETS, barOf, echoBeatsOf, effectOf, effectUsesColor, lowOf, movesStems, planRatio, presetOf, seedCurve, snapToBeat, spanOn, stemsOf, stepBars, swapPoint, swapsBassStem, volumeOf } from "@/lib/transition";
import { ECHO_BEATS, EFFECT_OPTIONS, EQ_OPTIONS, STEM_OPTIONS, VOLUME_OPTIONS, beatsLabel } from "@/lib/transition-options";
import { STRATEGY } from "@/lib/transition-planner";
import { holdSamples, regionPeaks } from "@/lib/analyze";
import type { DJ } from "@/hooks/use-dj";
import { Frame, FrameActions, FrameBody, FrameFooter, FrameHeader, FrameMeta, FrameStatus, FrameTitle, FrameValue } from "@/components/sodium/ui/frame";
import { SegmentedControl, SegmentedControlItem } from "@/components/sodium/ui/segmented-control";
import { Button } from "@/components/sodium/ui/button";
import { Status } from "@/components/sodium/ui/status";
import { Tag } from "@/components/sodium/ui/tag";
import { Empty, EmptyDescription, EmptyHeader, EmptyIcon, EmptyTitle } from "@/components/sodium/ui/empty-state";
import { Switch } from "@/components/sodium/ui/switch";
import { Slider } from "@/components/sodium/ui/slider";
import { Field, FieldLabel } from "@/components/sodium/ui/field";
import { Progress, ProgressLabel, ProgressValue } from "@/components/sodium/ui/progress";
import { Pick } from "@/components/pick";
import { SetTimeline } from "@/components/set-timeline";
import { Hint } from "@/components/hint";
import { AutoHeight, PageSwap, TextSwap } from "@/components/motion";
import { MIX_KEY } from "@/hooks/use-shortcuts";
import { AudioWave, ChevronLeft, ChevronRight, Icon, Play, Renew, Sparkles } from "@/components/sodium/icon";

const BARS = [1, 2, 4, 8, 16, 32];
const BINS = 220;
const first = (v: number | readonly number[]) => Array.isArray(v) ? v[0] : v as number;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
/** A lane's y in the 0..200 drawing for a gain: the out lane is the top half, the in lane the bottom one. */
const laneY = (lane: 0 | 1, g: number) => lane * 100 + 94 - g * 86;

function Lane({ peaks, locked, label, onDrag }: { peaks: number[] | null; locked: boolean; label: string; onDrag: (fraction: number, done: boolean) => void }) {
  const start = useRef<number | null>(null);
  return <div role="group" aria-label={label} className={cn("relative h-1/2 text-line-control", locked ? "cursor-default" : "cursor-ew-resize touch-none")}
    onPointerDown={e => { if (locked) return; start.current = e.clientX; e.currentTarget.setPointerCapture(e.pointerId); }}
    onPointerMove={e => { if (start.current === null) return; onDrag((e.clientX - start.current) / e.currentTarget.clientWidth, false); }}
    onPointerUp={e => { if (start.current === null) return; onDrag((e.clientX - start.current) / e.currentTarget.clientWidth, true); start.current = null; }}
    onPointerCancel={() => { start.current = null; }}>
    {peaks && <svg viewBox={`0 0 ${BINS * 5} 100`} preserveAspectRatio="none" className="absolute inset-0 size-full" aria-hidden>
      {peaks.map((n, i) => { const h = Math.max(2, Math.round(n * 92)); return <rect key={i} x={i * 5} y={(100 - h) / 2} width={3} height={h} fill="currentColor"/>; })}
    </svg>}
  </div>;
}

type Side = "out" | "in";
/** A curve with one side's points replaced, kept in order and inside the transition. */
const withSide = (curve: CustomCurve, side: Side, points: CurvePoint[]): CustomCurve => ({ ...curve, [side]: [...points].sort((a, b) => a.t - b.t) });

/* The volume envelopes as handles over the transition's stretch of both lanes. Click a lane to add a point, drag a point
   to move it (left and right for timing, up and down for gain), double-click or Delete to remove it. The arrow keys
   move a focused point. Every change writes a "custom" curve; nothing here touches the audio until it is saved. */
function CurveLayer({ curve, left, width, decks, onDraft, onCommit }: {
  curve: CustomCurve; left: number; width: number; decks: Record<Side, DeckId>;
  onDraft: (curve: CustomCurve | null) => void; onCommit: (curve: CustomCurve) => void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const drag = useRef<{ side: Side; index: number; curve: CustomCurve } | null>(null);
  /** Where a pointer is, as progress and gain. A drag keeps to its own lane: past the middle line its gain only clamps. */
  const read = (e: React.PointerEvent, lane?: Side) => {
    const box = layer.current!.getBoundingClientRect();
    const half = box.height / 2, y = e.clientY - box.top;
    const side: Side = lane ?? (y < half ? "out" : "in");
    const local = (y - (side === "out" ? 0 : half)) / half * 100;
    return { side, t: Math.max(0.01, Math.min(0.99, (e.clientX - box.left) / box.width)), g: clamp01((94 - local) / 86) };
  };
  const move = (c: CustomCurve, side: Side, index: number, t: number, g: number) => {
    const pts = c[side].map(p => ({ ...p }));
    const lo = (pts[index - 1]?.t ?? 0) + 0.01, hi = (pts[index + 1]?.t ?? 1) - 0.01;
    pts[index] = { t: Math.max(lo, Math.min(hi, t)), g: clamp01(g) };
    return { ...c, [side]: pts };
  };
  const remove = (side: Side, index: number) => onCommit(withSide(curve, side, curve[side].filter((_, i) => i !== index)));

  return <div ref={layer} className="absolute inset-y-0 left-(--l) z-(--z-raised) w-(--w) cursor-crosshair touch-none" style={{ "--l": `${left}%`, "--w": `${width}%` } as React.CSSProperties}
    aria-label="Volume curves: click to add a point" role="group"
    onPointerDown={e => {
      if (e.button !== 0) return;
      const { side, t, g } = read(e);
      // Near an existing point, grab it instead of stacking a second one on it.
      const near = curve[side].findIndex(p => Math.abs(p.t - t) < 0.03);
      let next = curve, index = near;
      if (near < 0) { next = withSide(curve, side, [...curve[side], { t, g }]); index = next[side].findIndex(p => p.t === t && p.g === g); }
      drag.current = { side, index, curve: next };
      e.currentTarget.setPointerCapture(e.pointerId);
      onDraft(next);
    }}
    onPointerMove={e => {
      const d = drag.current; if (!d) return;
      const { t, g } = read(e, d.side);
      d.curve = move(d.curve, d.side, d.index, t, g);
      onDraft(d.curve);
    }}
    onPointerUp={() => { const d = drag.current; drag.current = null; if (d) { onDraft(null); onCommit(d.curve); } }}
    onPointerCancel={() => { drag.current = null; onDraft(null); }}>
    {(["out", "in"] as const).map(side => curve[side].map((p, i) => {
      const top = laneY(side === "out" ? 0 : 1, p.g) / 2;
      // A two-axis point: the slider value is its gain, the spoken text carries both.
      return <div key={`${side}${i}`} data-deck={decks[side]} role="slider" tabIndex={0} aria-orientation="vertical" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p.g * 100)}
        aria-label={`${side === "out" ? "Outgoing" : "Incoming"} volume point`}
        aria-valuetext={`gain ${Math.round(p.g * 100)}% at ${Math.round(p.t * 100)}% of the transition. Arrows move it, Delete removes it.`}
        className="absolute left-(--x) top-(--y) size-3 -translate-x-1/2 -translate-y-1/2 cursor-grab border border-text-1 bg-data-1 focus-visible:outline-2 focus-visible:outline-focus active:cursor-grabbing"
        style={{ "--x": `${p.t * 100}%`, "--y": `${top}%` } as React.CSSProperties}
        onPointerDown={e => {
          if (e.button !== 0) return;
          e.stopPropagation();
          drag.current = { side, index: i, curve };
          layer.current?.setPointerCapture(e.pointerId);
        }}
        onDoubleClick={e => { e.stopPropagation(); remove(side, i); }}
        onKeyDown={e => {
          const step = e.shiftKey ? 0.01 : 0.05;
          const by = { ArrowUp: [0, step], ArrowDown: [0, -step], ArrowLeft: [-step / 2, 0], ArrowRight: [step / 2, 0] }[e.key];
          if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); remove(side, i); return; }
          if (!by) return;
          e.preventDefault();
          onCommit(move(curve, side, i, p.t + by[0], p.g + by[1]));
        }}/>;
    }))}
  </div>;
}

type EditorProps = {
  mediaTime: (id: DeckId) => number; plan: TransitionPlan; from: Track; to: Track; decks: Record<DeckId, DeckState>;
  /** The decks holding each track, or null for a track further down the set that no deck holds yet. */
  fromDeck: DeckId | null; toDeck: DeckId | null;
  locked: boolean; syncPlayheads: boolean; onChange: (plan: TransitionPlan) => void;
  stemsAvailable: boolean | null; splitting: Record<string, number>; onSplit: (trackId: string) => void;
};
function Editor({ mediaTime, plan, from, to, fromDeck, toDeck, decks, locked, syncPlayheads, onChange, stemsAvailable, splitting, onSplit }: EditorProps) {
  // A track no deck holds yet plays at its own tempo and has no playhead; its colour follows the deck it will go on.
  const fromId: DeckId = fromDeck ?? (toDeck === "A" ? "B" : "A"), toId: DeckId = toDeck ?? (fromId === "A" ? "B" : "A");
  const fromRate = fromDeck ? decks[fromDeck].rate : 1, toRate = toDeck ? decks[toDeck].rate : 1;
  const fromPlaying = !!fromDeck && decks[fromDeck].playing, toPlaying = !!toDeck && decks[toDeck].playing;
  const [drag, setDrag] = useState<{ outAt: number; inAt: number } | null>(null);
  const [mode, setMode] = useState<"points" | "curve">("points");
  const [draft, setDraft] = useState<CustomCurve | null>(null);
  const [data, setData] = useState<{ from: Float32Array; to: Float32Array } | null>(null);
  useEffect(() => {
    let alive = true;
    // Held while the editor draws them, so the cache cannot drop the pair under it; released when the pair changes or it closes.
    const a = holdSamples(from.id, from.blob), b = holdSamples(to.id, to.blob);
    void Promise.all([a.samples, b.samples]).then(([x, y]) => { if (alive) setData({ from: x, to: y }); }).catch(() => {});
    return () => { alive = false; a.release(); b.release(); };
  }, [from, to]);

  // What is drawn: the plan, or the curve being dragged, through the same functions the engine plays.
  const shown: TransitionPlan = draft ? { ...plan, volume: "custom", curve: draft } : plan;
  const editable: CustomCurve = draft ?? (plan.volume === "custom" && plan.curve ? plan.curve : seedCurve(plan.volume, swapPoint(plan)));
  const outAt = drag?.outAt ?? plan.outAt, inAt = drag?.inAt ?? plan.inAt;
  const length = spanOn(from, plan.bars);
  const pad = Math.max(barOf(from), length * 0.35);
  const span = length + pad * 2;
  // The same overlap the engine plays: the incoming deck stretches to the outgoing tempo, held to what a deck can stretch to.
  const k = planRatio(plan, from, to, fromRate, toRate);
  const topStart = outAt - pad, bottomStart = inAt - pad * k;
  const peaksTop = data && regionPeaks(data.from, topStart, topStart + span, BINS);
  const peaksBottom = data && regionPeaks(data.to, bottomStart, bottomStart + span * k, BINS);

  const x0 = pad / span * 1000, x1 = (pad + length) / span * 1000;
  const steps = Array.from({ length: 81 }, (_, i) => i / 80);
  // Each line is flat until the transition starts, follows the curve across it, and steps to where the engine leaves it.
  const path = (lane: 0 | 1, value: (t: number) => number, before: number, after: number) =>
    `M0 ${laneY(lane, before)} L${x0} ${laneY(lane, before)} ` + steps.map(t => `L${x0 + (x1 - x0) * t} ${laneY(lane, value(t))}`).join(" ") + ` L${x1} ${laneY(lane, after)} L1000 ${laneY(lane, after)}`;
  // Filter openness: 1 with the filter wide open, falling as a low pass closes or a high pass rises.
  const open = (c: number) => 1 - Math.min(1, Math.abs(c));
  const fxAt = (t: number) => effectOf(plan, t);
  const colored = effectUsesColor(plan.effect);
  const colorOut = colored && steps.some(t => fxAt(t).outColor !== 0);
  const colorIn = colored && steps.some(t => fxAt(t).inColor !== 0);
  const sends = steps.some(t => fxAt(t).amount > 0);
  const stemmed = !!from.stems && !!to.stems;
  // Each stem the move changes, drawn thin under the volume line, so the handover reads at a glance. Without stems on
  // both tracks the move cannot run, so nothing is drawn for it.
  const stemLines = movesStems(plan.stems) && stemmed ? [0, 1, 2, 3].flatMap(i => {
    const probe = steps.map(t => stemsOf(plan, t));
    return [
      ...(probe.some(p => p.out[i] !== 1) ? [{ lane: 0 as const, i, side: "out" as const }] : []),
      ...(probe.some(p => p.in[i] !== 1) ? [{ lane: 1 as const, i, side: "in" as const }] : []),
    ];
  }) : [];
  const STEM_TONE = ["text-data-2", "text-data-6", "text-data-5", "text-data-4"];

  // The playheads read a media clock every frame; the deck state updates at 10 Hz and would trail the lines. A running
  // mix shares the outgoing deck's progress across both lanes: separate media elements report time at different
  // granularities, while the audio transition itself runs at one shared progress on the audio clock.
  const topHead = useRef<HTMLDivElement>(null), bottomHead = useRef<HTMLDivElement>(null);
  const frame = useRef({ topStart, topWidth: span, bottomStart, bottomWidth: span * k, topPlaying: false, bottomPlaying: false, syncPlayheads: false });
  useEffect(() => {
    frame.current = { topStart, topWidth: span, bottomStart, bottomWidth: span * k, topPlaying: fromPlaying, bottomPlaying: toPlaying, syncPlayheads };
  });
  useEffect(() => {
    let raf = 0;
    const place = (el: HTMLDivElement | null, progress: number, playing: boolean) => {
      if (!el) return;
      const show = playing && progress >= 0 && progress <= 1;
      el.classList.toggle("hidden", !show);
      if (show) el.style.left = `${progress * 100}%`;
    };
    const tick = () => {
      const f = frame.current;
      const topProgress = (mediaTime(fromId) - f.topStart) / f.topWidth;
      const bottomProgress = f.syncPlayheads ? topProgress : (mediaTime(toId) - f.bottomStart) / f.bottomWidth;
      place(topHead.current, topProgress, f.topPlaying);
      place(bottomHead.current, bottomProgress, f.bottomPlaying);
    };
    // Nothing moves while both decks are stopped: draw once (which hides the heads) and do not keep a loop running.
    if (!fromPlaying && !toPlaying) { tick(); return; }
    const loop = () => { tick(); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [mediaTime, fromId, toId, fromPlaying, toPlaying]);

  const set = (patch: Partial<TransitionPlan>) => { const next = { ...plan, ...patch }; onChange({ ...next, preset: presetOf(next) }); };
  const setCurve = (curve: CustomCurve) => set({ volume: "custom", curve });
  const chooseVolume = (v: VolumeCurve) => {
    if (v === "custom") { setCurve(plan.curve ?? seedCurve(plan.volume, swapPoint(plan))); setMode("curve"); return; }
    // A preset replaces the custom points.
    set({ volume: v, curve: undefined });
  };
  const applyPreset = (key: Exclude<TransitionPreset, "custom">) => {
    const p = PRESETS[key];
    onChange({ ...plan, volume: p.volume, curve: undefined, eq: p.eq, effect: p.effect, stems: p.stems && stemmed ? p.stems : "none", preset: key });
  };
  const move = (lane: "out" | "in", fraction: number, done: boolean) => {
    const outNext = lane === "out" ? plan.outAt - fraction * span : plan.outAt;
    const inNext = lane === "in" ? plan.inAt - fraction * span * k : plan.inAt;
    // The points snap to the beat while dragging, so what is drawn is where the mix will start.
    const snapped = { outAt: Math.max(0, Math.min(from.duration - length, snapToBeat(from, outNext))), inAt: Math.max(0, Math.min(to.duration - spanOn(to, plan.bars), snapToBeat(to, inNext))) };
    if (!done) { setDrag(snapped); return; }
    setDrag(null);
    onChange({ ...plan, ...snapped });
  };
  const nudge = (lane: "out" | "in", bars: number) => onChange(lane === "out"
    ? { ...plan, outAt: Math.max(0, Math.min(from.duration - length, stepBars(from, plan.outAt, bars))) }
    : { ...plan, inAt: Math.max(0, Math.min(to.duration - spanOn(to, plan.bars), stepBars(to, plan.inAt, bars))) });
  const row = (track: Track, deck: DeckId, held: boolean, label: string, at: number, lane: "out" | "in") => <div data-deck={deck} className="flex items-center gap-3">
    <span className="size-2 shrink-0 bg-data-1" aria-hidden/>
    <div className="min-w-0 flex-1">
      <p className="type-body truncate">{track.title}</p>
      <p className="type-body-sm text-text-2 truncate">{track.artist} · {held ? `Deck ${deck === "A" ? 1 : 2}` : "Queued"} · {track.bpm ? `${track.bpm.toFixed(1)} bpm` : "no tempo"}{track.stems ? " · stems" : ""}</p>
    </div>
    <div className="flex items-center gap-1">
      <Button size="icon-sm" variant="ghost" disabled={locked} onClick={() => nudge(lane, -1)} aria-label={`${label} one bar earlier`}><Icon icon={ChevronLeft}/></Button>
      <span className="type-code w-24 text-center">{label} {formatTime(at)}</span>
      <Button size="icon-sm" variant="ghost" disabled={locked} onClick={() => nudge(lane, 1)} aria-label={`${label} one bar later`}><Icon icon={ChevronRight}/></Button>
    </div>
  </div>;
  const group = (title: string, control: React.ReactNode, hint?: string) => <div className="flex flex-col gap-1.5">
    <span className="type-label-sm text-text-2">{title}</span>{control}{hint && <p className="type-caption text-text-2">{hint}</p>}
  </div>;
  const swapShown = plan.eq === "bass" || plan.volume === "cut" || swapsBassStem(plan.stems);
  const echoShown = plan.effect === "echo" || plan.effect === "dub";
  const intensity = plan.intensity ?? 1;
  const missing = [from, to].filter(t => !t.stems);
  const beatMs = from.bpm ? Math.round(60 / from.bpm * echoBeatsOf(plan) / (fromRate || 1) * 1000) : null;

  return <div className="flex flex-col gap-4 xl:flex-row">
    <div className="flex min-w-0 flex-1 flex-col gap-3">
      {row(from, fromId, !!fromDeck, "Out", outAt, "out")}
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl size="sm" aria-label="What dragging on the waveforms does" value={mode} disabled={locked} onValueChange={v => setMode(v as "points" | "curve")}>
          <SegmentedControlItem value="points">Move points</SegmentedControlItem>
          <SegmentedControlItem value="curve">Shape volume</SegmentedControlItem>
        </SegmentedControl>
        <span className="type-caption text-text-2">{mode === "curve" ? "Click a curve to add a point, drag it, double-click to remove." : "Drag a waveform to move where it leaves or enters."}</span>
        {plan.volume === "custom" && <Button size="sm" variant="ghost" className="ms-auto" disabled={locked} onClick={() => set({ volume: "smooth", curve: undefined })}>Reset curve</Button>}
      </div>
      <div className="relative h-56 border border-line bg-well">
        <Lane peaks={peaksTop} locked={locked || mode === "curve"} label="Outgoing track, drag to move where it leaves" onDrag={(f, d) => move("out", f, d)}/>
        <Lane peaks={peaksBottom} locked={locked || mode === "curve"} label="Incoming track, drag to move where it enters" onDrag={(f, d) => move("in", f, d)}/>
        <svg viewBox="0 0 1000 200" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 size-full overflow-visible" aria-hidden>
          <rect x={x0} y={0} width={x1 - x0} height={200} fill="currentColor" fillOpacity={mode === "curve" ? 0.1 : 0.06} className="text-text-1"/>
          <line x1={x0} y1={0} x2={x0} y2={200} stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" className="text-line-control"/>
          <line x1={x1} y1={0} x2={x1} y2={200} stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" className="text-line-control"/>
          <line x1={0} y1={100} x2={1000} y2={100} stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" className="text-line"/>
          {plan.eq !== "none" && <>
            <path d={path(0, t => 1 + lowOf(plan, t).out / 24, 1, 1)} fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" className="text-data-5"/>
            <path d={path(1, t => 1 + lowOf(plan, t).in / 24, 0, 1)} fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" className="text-data-5"/>
          </>}
          {stemLines.map(l => <path key={`${l.side}${l.i}`} d={path(l.lane, t => stemsOf(plan, t)[l.side][l.i], l.side === "out" ? 1 : stemsOf(plan, 0).in[l.i], l.side === "out" ? stemsOf(plan, 1).out[l.i] : 1)}
            fill="none" stroke="currentColor" strokeWidth={1} strokeDasharray="1 3" vectorEffect="non-scaling-stroke" className={STEM_TONE[l.i]}/>)}
          {colorOut && <path d={path(0, t => open(fxAt(t).outColor), 1, open(fxAt(1).outColor))} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" className="text-data-3"/>}
          {colorIn && <path d={path(1, t => open(fxAt(t).inColor), open(fxAt(0).inColor), 1)} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" className="text-data-3"/>}
          {sends && <path d={path(0, t => fxAt(t).amount, 0, 0)} fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray="2 3" vectorEffect="non-scaling-stroke" className="text-data-4"/>}
          <g data-deck={fromId}><path d={path(0, t => volumeOf(shown, t).out, 1, 0)} fill="none" stroke="currentColor" strokeWidth={2.5} vectorEffect="non-scaling-stroke" className="glow text-data-1"/></g>
          <g data-deck={toId}><path d={path(1, t => volumeOf(shown, t).in, 0, 1)} fill="none" stroke="currentColor" strokeWidth={2.5} vectorEffect="non-scaling-stroke" className="glow text-data-1"/></g>
        </svg>
        {mode === "curve" && !locked && <CurveLayer curve={editable} left={x0 / 10} width={(x1 - x0) / 10} decks={{ out: fromId, in: toId }} onDraft={setDraft} onCommit={setCurve}/>}
        <div ref={topHead} className="pointer-events-none absolute top-0 hidden h-1/2 w-px bg-text-1"/>
        <div ref={bottomHead} className="pointer-events-none absolute bottom-0 hidden h-1/2 w-px bg-text-1"/>
      </div>
      {row(to, toId, !!toDeck, "In", inAt, "in")}
      <ul className="flex flex-wrap gap-x-4 gap-y-1 type-micro text-text-2" aria-label="Legend">
        <li className="flex items-center gap-1.5"><span className="h-0.5 w-3 bg-data-1"/>Volume</li>
        {plan.eq !== "none" && <li className="flex items-center gap-1.5"><span className="h-0.5 w-3 bg-data-5"/>Low band</li>}
        {(colorOut || colorIn) && <li className="flex items-center gap-1.5"><span className="h-0.5 w-3 bg-data-3"/>Filter</li>}
        {sends && <li className="flex items-center gap-1.5"><span className="h-0.5 w-3 bg-data-4"/>Effect send</li>}
        {stemLines.length > 0 && <li className="flex items-center gap-1.5"><span className="h-0.5 w-3 bg-data-2"/>Stems (vocals, drums, bass, melody)</li>}
      </ul>
      {!!plan.notes?.length && <div className="flex flex-col border-t border-line-faint pt-3">
        <span className="type-label-sm text-text-2">{plan.by === "ai" ? "Why the AI chose this" : "Why this plan"}</span>
        <ul className="flex flex-col">
          {plan.notes.map(note => <li key={note} className="rule-row py-1.5 type-body-sm text-text-2">{note}</li>)}
        </ul>
      </div>}
    </div>

    <div className="flex flex-col gap-3 xl:w-112 xl:shrink-0">
      {group("Preset", <div className="flex flex-wrap gap-1.5" role="group" aria-label="Preset">
        {(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map(key => <Hint key={key} label={PRESETS[key].hint + (PRESETS[key].stems && !stemmed ? " Needs stems on both tracks." : "")}>
          <Button size="sm" variant={plan.preset === key ? "secondary" : "ghost"} aria-pressed={plan.preset === key} disabled={locked} onClick={() => applyPreset(key)}>{PRESETS[key].label}</Button>
        </Hint>)}
      </div>)}
      {group("Length", <SegmentedControl fill size="sm" aria-label="Transition length" value={String(plan.bars)} disabled={locked} onValueChange={v => set({ bars: Number(v) })}>
        {BARS.map(n => <SegmentedControlItem key={n} value={String(n)}>{n}</SegmentedControlItem>)}
      </SegmentedControl>, `${plan.bars} ${plan.bars === 1 ? "bar" : "bars"} · ${(spanOn(from, plan.bars) / (fromRate || 1)).toFixed(1)} s`)}
      {group("Volume curve", <Pick aria-label="Volume curve" items={VOLUME_OPTIONS} value={plan.volume} disabled={locked} onValueChange={v => chooseVolume(v as VolumeCurve)} className="w-full"/>,
        VOLUME_OPTIONS.find(o => o.value === plan.volume)?.hint)}
      {group("Low end", <SegmentedControl fill size="sm" aria-label="Eq" value={plan.eq} disabled={locked} onValueChange={v => set({ eq: v as TransitionEq })}>
        {EQ_OPTIONS.map(o => <SegmentedControlItem key={o.value} value={o.value}>{o.label}</SegmentedControlItem>)}
      </SegmentedControl>, EQ_OPTIONS.find(o => o.value === plan.eq)?.hint)}
      {swapShown && group("Swap point", <Slider min={15} max={85} value={Math.round(swapPoint(plan) * 100)} disabled={locked} aria-label="Swap point"
        format={{ style: "unit", unit: "percent" }} showValue onValueChange={v => set({ eqAt: first(v) / 100 })}/>, "Where the bass swaps and a cut lands, as a share of the transition.")}
      {group("Effect", <Pick aria-label="Effect" items={EFFECT_OPTIONS} value={plan.effect} disabled={locked} onValueChange={v => set({ effect: v as TransitionEffect })} className="w-full"/>,
        EFFECT_OPTIONS.find(o => o.value === plan.effect)?.hint)}
      {plan.effect !== "none" && group("Intensity", <Slider min={0} max={150} value={Math.round(intensity * 100)} disabled={locked} aria-label="Effect intensity"
        format={{ style: "unit", unit: "percent" }} showValue onValueChange={v => set({ intensity: first(v) / 100 })}/>)}
      {echoShown && group("Echo time", <SegmentedControl fill size="sm" aria-label="Echo time in beats" value={String(echoBeatsOf(plan))} disabled={locked}
        onValueChange={v => set({ echoBeats: Number(v) })}>
        {ECHO_BEATS.map(n => <SegmentedControlItem key={n} value={String(n)}>{beatsLabel(n)}</SegmentedControlItem>)}
      </SegmentedControl>, beatMs ? `${beatsLabel(echoBeatsOf(plan))} beat · ${beatMs} ms at this tempo` : "Without a tempo the echo keeps its own time.")}
      {group("Stems", <Pick aria-label="Stem move" items={STEM_OPTIONS} value={plan.stems ?? "none"} disabled={locked || !stemmed}
        onValueChange={v => set({ stems: v as TransitionStems })} className="w-full"/>,
        !stemmed ? undefined : STEM_OPTIONS.find(o => o.value === (plan.stems ?? "none"))?.hint)}
      {!stemmed && <div className="flex flex-wrap items-center gap-2">
        <span className="type-caption text-text-2">{stemsAvailable === false ? "Stem moves need Demucs on this machine: run npm run setup:stems." : "Split both tracks into stems (Demucs) to use stem moves:"}</span>
        {stemsAvailable !== false && missing.map(t => <Button key={t.id} size="sm" variant="secondary" pending={splitting[t.id] !== undefined}
          pendingLabel={`${Math.round((splitting[t.id] ?? 0) * 100)}%`} disabled={!stemsAvailable || locked} onClick={() => onSplit(t.id)}>Split {t.title}</Button>)}
      </div>}
    </div>
  </div>;
}

/** The transition between the live deck and the other one, edited in place. Every change applies at once. */
export function TransitionPanel({ dj }: { dj: DJ }) {
  const running = dj.transition;
  const entries = dj.setList;
  // Which transition of the set is open: the next one by default, and again whenever the set moves on a track.
  const [picked, setPicked] = useState<{ index: number; head: string | null }>({ index: 0, head: null });
  const head = entries[0]?.track.id ?? null;
  const transitions = Math.max(0, entries.length - 1);
  const sel = picked.head === head ? Math.min(picked.index, Math.max(0, transitions - 1)) : 0;
  const entry = entries[sel];
  const plan = sel === 0 && running ? running.plan : entry?.plan ?? null;
  const from = entry?.track, to = entries[sel + 1]?.track;
  const deckOf = (id?: string): DeckId | null => !id ? null : dj.decks.A.trackId === id ? "A" : dj.decks.B.trackId === id ? "B" : null;
  const fromDeck = deckOf(from?.id), toDeck = deckOf(to?.id);
  const onDecks = !!fromDeck && !!toDeck && fromDeck !== toDeck;
  const locked = !!running && sel === 0;
  const liveDeck = running ? running.from : fromDeck && sel === 0 ? fromDeck : deckOf(head ?? undefined);
  const label = plan ? (plan.preset === "custom" ? "Custom" : PRESETS[plan.preset]?.label ?? "Custom") : "";
  // What the plan actually is and how the same criteria the planner uses rate it: the strategy, its length, and the score
  // with the confidence behind it. A running mix has no fresh evaluation, so it shows the plan's own stored numbers.
  const strategyLabel = plan?.strategy ? STRATEGY[plan.strategy].label : label;
  const { ratePlan } = dj;
  const rated = useMemo(() => locked || !plan ? null : ratePlan(plan), [locked, plan, ratePlan]);
  const rating = rated ? `${Math.round(rated.score)}/100 · ${Math.round(rated.confidence * 100)}% confidence`
    : plan?.score !== undefined ? `${Math.round(plan.score)}/100${plan.confidence !== undefined ? ` · ${Math.round(plan.confidence * 100)}% confidence` : ""}` : null;
  const later = sel > 0 || (!onDecks && !locked);
  const hint = locked ? "Stop the mix to edit it."
    : dj.armed ? "Preview armed: the mix starts at the out point."
    : !plan ? (dj.autoMix ? "AutoMix follows the queue: it plans the next pair as soon as one is ready." : "Load a track on a deck, add tracks to the queue, and every transition of the set shows here.")
    : later ? `Transition ${sel + 1} of the set: ${dj.autoMix ? "AutoMix plays it as edited here when it gets there." : "it plays as edited here once AutoMix is on."}`
    : dj.autoMix ? "AutoMix starts at the out point and keeps any edit you make here. Drag a waveform to move it."
    : "Drag a waveform to move its point; times snap to the beat.";
  const live = liveDeck ? dj.decks[liveDeck] : null;
  // Why the set will not mix on by itself, said where the set is shown, with the one press that fixes it.
  const queue = dj.auto.queue;
  const bothPlaying = dj.decks.A.playing && dj.decks.B.playing && !running;
  const notice = running || !entries.length ? null
    : !dj.autoMix ? (transitions ? { text: "AutoMix is off: transitions wait for Mix now.", action: { label: "Turn on AutoMix", run: () => dj.setAutoMix(true) } } : null)
    : bothPlaying ? { text: "Both decks are playing by hand: AutoMix waits until one stops." }
    : !transitions ? (queue.items.length > 1 && !queue.loop
      ? { text: "End of the queue: no transition after this track.", action: { label: "Loop the queue", run: () => dj.queue.setLoop(true) } }
      : { text: "Nothing queued after this track: add tracks to the queue to keep mixing." })
    : null;

  return <Frame aria-label="Transition" id="transition">
    <FrameHeader>
      <FrameTitle>Transition{transitions > 1 ? ` ${sel + 1}/${transitions}` : ""}</FrameTitle>
      <FrameStatus>
        {locked ? <Status size="sm" status="running">Mixing {Math.round(running.progress * 100)}%</Status>
          : dj.armed && sel === 0 ? <Status size="sm" status="queued">Armed</Status>
          : plan?.by === "ai" ? <Tag size="sm" variant="outline">AI</Tag>
          : plan?.preset === "custom" ? <Tag size="sm" variant="outline">Custom</Tag> : null}
      </FrameStatus>
      {plan && from && <FrameValue meta>{strategyLabel} · {plan.bars} {plan.bars === 1 ? "bar" : "bars"} · {(spanOn(from, plan.bars) / ((fromDeck && dj.decks[fromDeck].rate) || 1)).toFixed(1)} s{rating ? ` · ${rating}` : ""}</FrameValue>}
      <FrameActions>
        <Hint label={onDecks ? "Preview from two bars before the out point" : "Preview needs both tracks on the decks"}>
          <Button size="icon-sm" variant="ghost" disabled={!plan || !!running || !onDecks} onClick={() => plan && void dj.preview(plan)} aria-label="Preview from two bars before the out point"><Icon icon={Play}/></Button>
        </Hint>
        <Hint label={dj.aiAvailable === false ? "AI transitions need Ollama running on this machine with the model pulled" : "Plan this transition with the local AI model"}>
          <Button size="sm" variant="secondary" disabled={!plan || locked || !dj.aiAvailable || !from?.bpm || !to?.bpm}
            pending={!!dj.planning} pendingLabel="Planning" onClick={() => from && to && void dj.aiPlan({ fromId: from.id, toId: to.id })}><Icon icon={Sparkles}/>AI plan</Button>
        </Hint>
        <Hint label={dj.smartStyle.template ? "AutoMix uses your saved transition shape. Click to replace it with this one." : "Use this transition's shape (curves, eq, effect, stems) for every AutoMix transition"}>
          <Button size="sm" variant="ghost" disabled={!plan} onClick={() => plan && dj.saveAsTemplate(plan)}>Use in AutoMix</Button>
        </Hint>
        <Hint label="Reset points and curves to auto">
          <Button size="icon-sm" variant="ghost" disabled={!from || !to || locked} onClick={() => from && to && dj.resetPlan(from.id, to.id)} aria-label="Reset points and curves to auto"><Icon icon={Renew}/></Button>
        </Hint>
      </FrameActions>
    </FrameHeader>
    {entries.length > 0 && <FrameBody>
      <SetTimeline entries={entries} liveDeck={liveDeck} rate={live?.rate ?? 1} playing={!!live?.playing} positions={dj.positions}
        mediaTime={dj.mediaTime} progress={running ? running.progress : null} selected={sel} onSelect={index => setPicked({ index, head })}
        armed={dj.autoMix || !!dj.armed || !!running} notice={notice}/>
    </FrameBody>}
    {/* Card resize: the region eases between its one-row empty state, the editor and the running mix's progress. */}
    <AutoHeight>
    {plan && from && to
      ? <FrameBody><PageSwap id={`${from.id}>${to.id}`} order={sel}><Editor key={`${from.id}>${to.id}`} mediaTime={dj.mediaTime} plan={plan} from={from} to={to} fromDeck={fromDeck} toDeck={toDeck} decks={dj.decks}
          locked={locked} syncPlayheads={locked} onChange={dj.savePlan}
          stemsAvailable={dj.stemsAvailable} splitting={dj.splitting} onSplit={id => void dj.splitStems(id)}/></PageSwap></FrameBody>
      // Empty, the region keeps to one row: a tall hole between the decks and the console is what it would add.
      : <FrameBody padding="none">
          <Empty variant="plain" size="sm" reason="empty" className="flex-row items-center">
            <EmptyIcon icon={AudioWave}/>
            <EmptyHeader><EmptyTitle>No transition yet</EmptyTitle><EmptyDescription>Load a track and queue what follows, or load both decks, to plan how each one mixes into the next.</EmptyDescription></EmptyHeader>
          </Empty>
        </FrameBody>}
    {locked && <FrameBody>
      <Progress value={Math.round(running.progress * 100)} max={100}>
        <ProgressLabel>Deck {running.from === "A" ? 1 : 2} into deck {running.to === "A" ? 1 : 2}</ProgressLabel>
        <ProgressValue>{(_, v) => `${v}%`}</ProgressValue>
      </Progress>
    </FrameBody>}
    </AutoHeight>
    <FrameFooter>
      <FrameMeta className="whitespace-normal"><TextSwap>{hint}</TextSwap></FrameMeta>
      <Field orientation="horizontal" className="w-auto gap-2">
        <FieldLabel>Auto mix</FieldLabel>
        <Switch size="sm" checked={dj.autoMix} onCheckedChange={dj.setAutoMix}/>
      </Field>
      {running
        ? <Hint label="Stop the mix" keys={MIX_KEY}><Button size="sm" variant="secondary" onClick={dj.cancelMix}>Stop mix</Button></Hint>
        : <Hint label={onDecks && sel === 0 ? "Mix into the other deck now" : "Mix now plays the transition between the two loaded decks"} keys={MIX_KEY}>
            <Button size="sm" disabled={!dj.plan} onClick={() => dj.plan && void dj.mix(dj.plan, true)}>Mix now</Button></Hint>}
    </FrameFooter>
  </Frame>;
}
