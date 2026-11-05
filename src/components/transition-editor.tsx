"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/sodium/utils";
import { formatTime, STEMS, type CurvePoint, type StemMove, type StemName, type CustomCurve, type DeckId, type DeckState, type Track, type TransitionEffect, type TransitionEq, type TransitionPlan, type TransitionPreset, type TransitionShape, type TransitionStems, type VolumeCurve } from "@/lib/types";
import { PRESETS, PITCH_RANGE, SPEED_RANGE, autoTrim, barOf, curveGain, echoBeatsOf, effectOf, effectUsesColor, hasMotion, lowOf, motionSidePoints, motionText, motionValue, movesStems, planRatio, presetOf, seedCurve, seedStemCurve, shapeOfPlan, stemMovesOf, snapToBeat, spanOn, stemsOf, stepBars, swapPoint, swapsBassStem, volumeOf } from "@/lib/transition";
import { ECHO_BEATS, EFFECT_OPTIONS, EQ_OPTIONS, STEM_MOVE_HINT, STEM_MOVE_OPTIONS, STEM_OPTIONS, VOLUME_OPTIONS, beatsLabel } from "@/lib/transition-options";
import type { Motion } from "@/lib/transition";
import { STRATEGY } from "@/lib/transition-planner";
import { holdSamples, regionPeaks } from "@/lib/analyze";
import type { DJ } from "@/hooks/use-dj";
import { useTransitionPreview, type PreviewInput } from "@/hooks/use-transition-preview";
import { useUserPresets } from "@/hooks/use-user-presets";
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
import { AudioWave, ChevronLeft, ChevronRight, Close, Icon, Pause, Play, Renew, Repeat, Sparkles, Stop } from "@/components/sodium/icon";
import { Input } from "@/components/sodium/ui/input";

const BARS = [1, 2, 4, 8, 16, 32];
const BINS = 220;
const first = (v: number | readonly number[]) => Array.isArray(v) ? v[0] : v as number;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
/** A lane's y in the 0..200 drawing for a gain: the out lane is the top half, the in lane the bottom one. */
const laneY = (lane: 0 | 1, g: number) => lane * 100 + 94 - g * 86;
/** Each stem's colour, in STEMS order (vocals, drums, bass, melody), as a line and as a fill. */
const STEM_TONE = ["text-data-2", "text-data-6", "text-data-5", "text-data-4"];
const STEM_BG = ["bg-data-2", "bg-data-6", "bg-data-5", "bg-data-4"];
const MOTION_TONE: Record<Motion, string> = { pitch: "text-data-6", speed: "text-data-3" };
const MOTION_BG: Record<Motion, string> = { pitch: "bg-data-6", speed: "bg-data-3" };
const MOTION_HINT: Record<Motion, string> = {
  pitch: `Bend each track's pitch, ±${PITCH_RANGE} semitones, without changing its tempo: click a line to add a point, drag it, double-click to remove. Middle is no change. A rough shift, best on sweeps.`,
  speed: `Speed each track up or down, ±${SPEED_RANGE * 100}%, without changing its pitch. While a speed move runs the beats are not locked: use it for a slow-down or a push into the next track.`,
};
const STEM_INDEX = Object.fromEntries(STEMS.map((s, i) => [s.id, i])) as Record<StemName, number>;
const STEM_LABEL = Object.fromEntries(STEMS.map(s => [s.id, s.label])) as Record<StemName, string>;

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

/** Tick spacings in seconds; the ruler takes the first that keeps it to about eight labels. */
const TICKS = [1, 2, 5, 10, 15, 30, 60];
/* Song time under a lane: the stretch [start, start + width] of the track, in seconds, labelled at round times. The labels
   at either end hold inside the box instead of hanging past it. */
function Ruler({ start, width, duration, edge, label }: { start: number; width: number; duration: number; edge: "top" | "bottom"; label: string }) {
  const step = TICKS.find(s => width / s <= 8) ?? 60;
  const ticks: number[] = [];
  for (let t = Math.ceil(Math.max(0, start) / step) * step; t <= Math.min(duration, start + width); t += step) ticks.push(t);
  return <div className="relative h-4 text-text-2" role="img" aria-label={`${label}: ${formatTime(Math.max(0, start))} to ${formatTime(Math.min(duration, start + width))}`}>
    {ticks.map(t => {
      const x = (t - start) / width;
      return <span key={t} className={cn("absolute left-(--x) flex type-micro tabular-nums", edge === "top" ? "bottom-0 items-end" : "top-0 items-start",
        x < 0.04 ? "" : x > 0.96 ? "-translate-x-full" : "-translate-x-1/2")} style={{ "--x": `${x * 100}%` } as React.CSSProperties}>
        {formatTime(t)}
      </span>;
    })}
  </div>;
}

type Side = "out" | "in";
/** A curve with one side's points replaced, kept in order and inside the transition. */
const withSide = (curve: CustomCurve, side: Side, points: CurvePoint[]): CustomCurve => ({ ...curve, [side]: [...points].sort((a, b) => a.t - b.t) });

/* The volume envelopes as handles over the transition's stretch of both lanes. Click a lane to add a point, drag a point
   to move it (left and right for timing, up and down for gain), double-click or Delete to remove it. The arrow keys
   move a focused point. Every change writes a "custom" curve; nothing here touches the audio until it is saved. */
function CurveLayer({ curve, left, width, decks, onDraft, onCommit, noun = "volume", tone, describe }: {
  curve: CustomCurve; left: number; width: number; decks: Record<Side, DeckId>;
  /** What the points shape, for their names; and a background class for their handles (a stem's own colour). */
  noun?: string; tone?: string;
  /** What a point's height means, as spoken text; the default reads it as a gain. */
  describe?: (g: number) => string;
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
    aria-label={`${noun[0].toUpperCase()}${noun.slice(1)} curves: click to add a point`} role="group"
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
        aria-label={`${side === "out" ? "Outgoing" : "Incoming"} ${noun} point`}
        aria-valuetext={`${describe ? describe(p.g) : `gain ${Math.round(p.g * 100)}%`} at ${Math.round(p.t * 100)}% of the transition. Arrows move it, Delete removes it.`}
        className={cn("absolute left-(--x) top-(--y) size-3 -translate-x-1/2 -translate-y-1/2 cursor-grab border border-text-1 focus-visible:outline-2 focus-visible:outline-focus active:cursor-grabbing", tone ?? "bg-data-1")}
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
  // What dragging on the waveforms does: move the points, shape the volume, or shape one stem.
  const [mode, setMode] = useState<"points" | "curve" | Motion | StemName>("points");
  const [draft, setDraft] = useState<CustomCurve | null>(null);
  const [stemDraft, setStemDraft] = useState<CustomCurve | null>(null);
  const [motionDraft, setMotionDraft] = useState<CustomCurve | null>(null);
  const shaping = mode !== "points";
  const motionMode: Motion | null = mode === "pitch" || mode === "speed" ? mode : null;
  const stemMode = mode !== "points" && mode !== "curve" && mode !== "pitch" && mode !== "speed" ? mode : null;
  const [data, setData] = useState<{ from: Float32Array; to: Float32Array } | null>(null);
  useEffect(() => {
    let alive = true;
    // Held while the editor draws them, so the cache cannot drop the pair under it; released when the pair changes or it closes.
    const a = holdSamples(from.id, from.blob), b = holdSamples(to.id, to.blob);
    void Promise.all([a.samples, b.samples]).then(([x, y]) => { if (alive) setData({ from: x, to: y }); }).catch(() => {});
    return () => { alive = false; a.release(); b.release(); };
  }, [from, to]);

  // What is drawn: the plan, or the curve being dragged, through the same functions the engine plays.
  const moves = stemMovesOf(plan);
  // A stem drawn by hand, or one that has a move, starts its curve from that move, as the volume curve starts from its preset.
  const stemCurveOf = (stem: StemName) => moves[stem] === "custom" ? plan.stemCurves?.[stem] ?? { out: [], in: [] } : seedStemCurve(moves[stem], swapPoint(plan));
  const withStemCurve = (stem: StemName, curve: CustomCurve): Partial<TransitionPlan> =>
    ({ stems: "custom", stemMoves: { ...moves, [stem]: "custom" }, stemCurves: { ...plan.stemCurves, [stem]: curve } });
  const volumeShown: TransitionPlan = draft ? { ...plan, volume: "custom", curve: draft } : plan;
  const shown: TransitionPlan = stemDraft && stemMode ? { ...volumeShown, ...withStemCurve(stemMode, stemDraft) } : volumeShown;
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
  // The stem being shaped is always drawn, full lines included, so there is a line to click on.
  const stemLines = stemmed && (movesStems(shown.stems) || stemMode) ? [0, 1, 2, 3].flatMap(i => {
    const probe = steps.map(t => stemsOf(shown, t)), picked = STEMS[i].id === stemMode;
    return [
      ...(picked || probe.some(p => p.out[i] !== 1) ? [{ lane: 0 as const, i, side: "out" as const, picked }] : []),
      ...(picked || probe.some(p => p.in[i] !== 1) ? [{ lane: 1 as const, i, side: "in" as const, picked }] : []),
    ];
  }) : [];

  // Pitch and speed lines: drawn when the plan moves them, and for the one being shaped (so there is a line to click on).
  const motionOf = (kind: Motion) => (motionMode === kind && motionDraft) || plan[kind] || null;
  const motionLines = (["pitch", "speed"] as const).flatMap(kind => {
    const c = motionOf(kind);
    return hasMotion(c ?? undefined) || motionMode === kind ? (["out", "in"] as const).map(side => ({ kind, side, curve: c ?? { out: [], in: [] } })) : [];
  });

  // The preview loops exactly the stretch drawn here, at the decks' tempo: the outgoing track for the lead-in, the
  // transition, then the incoming track alone. It plays on its own, so the set (and the decks) are not touched.
  const preview = useTransitionPreview();
  const previewInput: PreviewInput = {
    from, to, plan, aStart: plan.outAt - pad, bStart: plan.inAt - pad * k, aRate: fromRate || 1, bRate: (fromRate || 1) * k,
    lead: pad / (fromRate || 1), duration: length / (fromRate || 1), seconds: span / (fromRate || 1),
    aTrim: fromDeck ? decks[fromDeck].trim : autoTrim(from), bTrim: toDeck ? decks[toDeck].trim : autoTrim(to),
    beat: from.bpm ? 60 / from.bpm / (fromRate || 1) : undefined,
  };
  // The tracks are long blobs: the key names them by id.
  const previewKey = JSON.stringify({ ...previewInput, from: from.id, to: to.id });
  const previewLatest = useRef(previewInput);
  useEffect(() => { previewLatest.current = previewInput; });
  const previewing = preview.state !== "idle";
  // An edit while the loop plays is rendered and swapped in where the loop is, so each change is heard on the next pass.
  const { update: updatePreview } = preview;
  useEffect(() => {
    if (preview.state !== "playing") return;
    const id = window.setTimeout(() => void updatePreview(previewLatest.current), 120);
    return () => window.clearTimeout(id);
  }, [previewKey, preview.state, updatePreview]);

  // The DJ's own presets: a custom shape saved under a name, applied to any pair like a built-in one.
  const mine = useUserPresets();
  const [naming, setNaming] = useState<string | null>(null);
  // Shapes compare with "no stem move" spelled out, since a plan always names one and a saved shape may not.
  const shapeKey = (shape: TransitionShape) => JSON.stringify({ ...shape, stems: shape.stems ?? "none" });
  const planShape = shapeKey(shapeOfPlan(plan));
  const activeMine = mine.presets.find(p => shapeKey(p.shape) === planShape) ?? null;
  const saveMine = () => {
    const name = naming?.trim();
    if (!name) return;
    mine.add(name, shapeOfPlan(plan)); setNaming(null);
  };

  // The playheads read a media clock every frame; the deck state updates at 10 Hz and would trail the lines. A running
  // mix shares the outgoing deck's progress across both lanes: separate media elements report time at different
  // granularities, while the audio transition itself runs at one shared progress on the audio clock.
  const topHead = useRef<HTMLDivElement>(null), bottomHead = useRef<HTMLDivElement>(null);
  const frame = useRef({ topStart, topWidth: span, bottomStart, bottomWidth: span * k, topPlaying: false, bottomPlaying: false, syncPlayheads: false });
  useEffect(() => {
    frame.current = { topStart, topWidth: span, bottomStart, bottomWidth: span * k, topPlaying: fromPlaying, bottomPlaying: toPlaying, syncPlayheads };
  });
  const previewProgress = preview.progress;
  const previewPlaying = preview.state === "playing";
  useEffect(() => {
    let raf = 0;
    // Each head carries the song time it stands on, so the minute is read where the line is.
    const place = (el: HTMLDivElement | null, progress: number, playing: boolean, start: number, width: number) => {
      if (!el) return;
      const show = playing && progress >= 0 && progress <= 1;
      el.classList.toggle("hidden", !show);
      if (!show) return;
      el.style.left = `${progress * 100}%`;
      const tag = el.firstElementChild as HTMLElement | null;
      const text = formatTime(start + progress * width);
      if (tag && tag.textContent !== text) tag.textContent = text;
      // Past the middle the tag sits on the left of the line, so it never runs out of the box.
      tag?.classList.toggle("right-0", progress > 0.5);
      tag?.classList.toggle("left-0", progress <= 0.5);
    };
    const tick = () => {
      const f = frame.current;
      // The preview loop, while it plays, owns both heads: one line across the two lanes, at the same point of the loop.
      const looped = previewPlaying ? previewProgress() : null;
      if (looped !== null) {
        place(topHead.current, looped, true, f.topStart, f.topWidth);
        place(bottomHead.current, looped, true, f.bottomStart, f.bottomWidth);
        return;
      }
      const topProgress = (mediaTime(fromId) - f.topStart) / f.topWidth;
      const bottomProgress = f.syncPlayheads ? topProgress : (mediaTime(toId) - f.bottomStart) / f.bottomWidth;
      place(topHead.current, topProgress, f.topPlaying, f.topStart, f.topWidth);
      place(bottomHead.current, bottomProgress, f.bottomPlaying, f.bottomStart, f.bottomWidth);
    };
    // Nothing moves while both decks are stopped: draw once (which hides the heads) and do not keep a loop running.
    if (!fromPlaying && !toPlaying && !previewPlaying) { tick(); return; }
    const loop = () => { tick(); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [mediaTime, fromId, toId, fromPlaying, toPlaying, previewPlaying, previewProgress]);

  const set = (patch: Partial<TransitionPlan>) => { const next = { ...plan, ...patch }; onChange({ ...next, preset: presetOf(next) }); };
  const setCurve = (curve: CustomCurve) => set({ volume: "custom", curve });
  const chooseVolume = (v: VolumeCurve) => {
    if (v === "custom") { setCurve(plan.curve ?? seedCurve(plan.volume, swapPoint(plan))); setMode("curve"); return; }
    // A preset replaces the custom points.
    set({ volume: v, curve: undefined });
  };
  const applyPreset = (key: Exclude<TransitionPreset, "custom">) => {
    const p = PRESETS[key];
    onChange({ ...plan, volume: p.volume, curve: undefined, pitch: undefined, speed: undefined, eq: p.eq, effect: p.effect, stems: p.stems && stemmed ? p.stems : "none", preset: key });
  };
  /** A stem row: a move preset replaces the stem's drawn points; Custom keeps them (or starts them from the move it had)
      and opens that stem on the waveforms. Every stem on Blend is no stem move at all. */
  const moveStem = (stem: StemName, move: StemMove) => {
    if (move === "custom") { set(withStemCurve(stem, stemCurveOf(stem))); setMode(stem); return; }
    const next = { ...moves, [stem]: move };
    const curves = { ...plan.stemCurves }; delete curves[stem];
    if (Object.values(next).every(m => m === "blend")) set({ stems: "none", stemMoves: undefined, stemCurves: undefined });
    else set({ stems: "custom", stemMoves: next, stemCurves: Object.keys(curves).length ? curves : undefined });
  };
  /** A saved shape on this pair: its curves, eq, effect and stems; where the pair mixes stays as it is. */
  const applyMine = (shape: TransitionShape) => {
    const next: TransitionPlan = { ...plan, curve: undefined, pitch: undefined, speed: undefined, stemMoves: undefined, stemCurves: undefined, eqAt: undefined, intensity: undefined, echoBeats: undefined, ...shape,
      stems: shape.stems && movesStems(shape.stems) && !stemmed ? "none" : shape.stems ?? "none" };
    onChange({ ...next, preset: presetOf(next) });
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
      <p className="flex items-baseline gap-2 type-body">
        <span className="min-w-0 truncate">{track.title}</span>
        {/* Where the track is and how long it runs; a queued track has no position yet, only its length. */}
        <span className="shrink-0 type-code text-text-2 tabular-nums" aria-label={held ? `At ${formatTime(decks[deck].position)} of ${formatTime(track.duration)}` : `Length ${formatTime(track.duration)}`}>
          {held ? <><span className="text-text-1">{formatTime(decks[deck].position)}</span> / </> : null}{formatTime(track.duration)}
        </span>
      </p>
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
  const swapShown = plan.eq === "bass" || plan.volume === "cut" || (plan.stems === "custom" ? Object.values(moves).includes("swap") : swapsBassStem(plan.stems));
  const echoShown = plan.effect === "echo" || plan.effect === "dub";
  const intensity = plan.intensity ?? 1;
  // A set can run a track into itself (a looped one-track queue, a repeat), so the pair may name the same track twice:
  // list each track to split once.
  const missing = [from, to].filter((t, i, all) => !t.stems && all.findIndex(o => o.id === t.id) === i);
  const beatMs = from.bpm ? Math.round(60 / from.bpm * echoBeatsOf(plan) / (fromRate || 1) * 1000) : null;

  return <div className="flex flex-col gap-4 xl:flex-row">
    <div className="flex min-w-0 flex-1 flex-col gap-3">
      {row(from, fromId, !!fromDeck, "Out", outAt, "out")}
      <div className="flex flex-wrap items-center gap-2">
        <Hint label={previewing ? "Stop the preview" : "Loop this transition on its own, without touching the decks. Edits are heard on the next pass."}>
          <Button size="sm" variant={previewing ? "secondary" : "primary"} aria-pressed={previewing} pending={preview.state === "loading"} pendingLabel="Rendering"
            onClick={() => previewing ? preview.stop() : void preview.play(previewInput)}>
            <Icon icon={previewing ? Stop : Repeat}/>{previewing ? "Stop preview" : "Preview loop"}
          </Button>
        </Hint>
        <SegmentedControl size="sm" aria-label="What dragging on the waveforms does" value={mode} disabled={locked} onValueChange={v => setMode(v as typeof mode)}>
          <SegmentedControlItem value="points">Move points</SegmentedControlItem>
          <SegmentedControlItem value="curve">Volume</SegmentedControlItem>
          {STEMS.map(stem => <SegmentedControlItem key={stem.id} value={stem.id} disabled={!stemmed}>{stem.label}</SegmentedControlItem>)}
          <SegmentedControlItem value="pitch">Pitch</SegmentedControlItem>
          <SegmentedControlItem value="speed">Speed</SegmentedControlItem>
        </SegmentedControl>
        <span className="type-caption text-text-2">{motionMode ? MOTION_HINT[motionMode] : stemMode ? `Shape the ${STEM_LABEL[stemMode].toLowerCase()}: click its line to add a point, drag it, double-click to remove.`
          : mode === "curve" ? "Click a curve to add a point, drag it, double-click to remove." : "Drag a waveform to move where it leaves or enters."}</span>
        {preview.error && <span role="alert" className="type-caption text-fail-text">Preview failed: {preview.error}</span>}
        {motionMode ? hasMotion(plan[motionMode]) && <Button size="sm" variant="ghost" className="ms-auto" disabled={locked} onClick={() => set({ [motionMode]: undefined })}>Reset {motionMode}</Button>
          : stemMode ? moves[stemMode] !== "blend" && <Button size="sm" variant="ghost" className="ms-auto" disabled={locked} onClick={() => moveStem(stemMode, "blend")}>Reset {STEM_LABEL[stemMode].toLowerCase()}</Button>
          : plan.volume === "custom" && <Button size="sm" variant="ghost" className="ms-auto" disabled={locked} onClick={() => set({ volume: "smooth", curve: undefined })}>Reset curve</Button>}
      </div>
      <div className="flex flex-col gap-1">
      <Ruler start={topStart} width={span} duration={from.duration} edge="top" label="Outgoing track time"/>
      <div className="relative h-56 border border-line bg-well">
        <Lane peaks={peaksTop} locked={locked || shaping} label="Outgoing track, drag to move where it leaves" onDrag={(f, d) => move("out", f, d)}/>
        <Lane peaks={peaksBottom} locked={locked || shaping} label="Incoming track, drag to move where it enters" onDrag={(f, d) => move("in", f, d)}/>
        <svg viewBox="0 0 1000 200" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 size-full overflow-visible" aria-hidden>
          <rect x={x0} y={0} width={x1 - x0} height={200} fill="currentColor" fillOpacity={shaping ? 0.1 : 0.06} className="text-text-1"/>
          <line x1={x0} y1={0} x2={x0} y2={200} stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" className="text-line-control"/>
          <line x1={x1} y1={0} x2={x1} y2={200} stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" className="text-line-control"/>
          <line x1={0} y1={100} x2={1000} y2={100} stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" className="text-line"/>
          {plan.eq !== "none" && <>
            <path d={path(0, t => 1 + lowOf(plan, t).out / 24, 1, 1)} fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" className="text-data-5"/>
            <path d={path(1, t => 1 + lowOf(plan, t).in / 24, 0, 1)} fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" className="text-data-5"/>
          </>}
          {stemLines.map(l => <path key={`${l.side}${l.i}`} d={path(l.lane, t => stemsOf(shown, t)[l.side][l.i], l.side === "out" ? 1 : stemsOf(shown, 0).in[l.i], l.side === "out" ? stemsOf(shown, 1).out[l.i] : 1)}
            fill="none" stroke="currentColor" strokeWidth={l.picked ? 2 : 1} strokeDasharray={l.picked ? undefined : "1 3"} vectorEffect="non-scaling-stroke" className={STEM_TONE[l.i]}/>)}
          {colorOut && <path d={path(0, t => open(fxAt(t).outColor), 1, open(fxAt(1).outColor))} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" className="text-data-3"/>}
          {colorIn && <path d={path(1, t => open(fxAt(t).inColor), open(fxAt(0).inColor), 1)} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" className="text-data-3"/>}
          {sends && <path d={path(0, t => fxAt(t).amount, 0, 0)} fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray="2 3" vectorEffect="non-scaling-stroke" className="text-data-4"/>}
          {motionMode && <>
            <line x1={0} y1={laneY(0, 0.5)} x2={1000} y2={laneY(0, 0.5)} stroke="currentColor" strokeWidth={1} strokeDasharray="1 4" vectorEffect="non-scaling-stroke" className="text-line-control"/>
            <line x1={0} y1={laneY(1, 0.5)} x2={1000} y2={laneY(1, 0.5)} stroke="currentColor" strokeWidth={1} strokeDasharray="1 4" vectorEffect="non-scaling-stroke" className="text-line-control"/>
          </>}
          {motionLines.map(l => { const pts = motionSidePoints(l.side, l.curve[l.side]), lane = l.side === "out" ? 0 : 1;
            return <path key={`${l.kind}${l.side}`} d={path(lane, t => curveGain(pts, t), pts[0].g, pts.at(-1)!.g)} fill="none" stroke="currentColor" strokeWidth={motionMode === l.kind ? 2 : 1.5}
              strokeDasharray={l.kind === "speed" ? "7 3" : undefined} vectorEffect="non-scaling-stroke" className={MOTION_TONE[l.kind]}/>; })}
          <g data-deck={fromId}><path d={path(0, t => volumeOf(shown, t).out, 1, 0)} fill="none" stroke="currentColor" strokeWidth={2.5} vectorEffect="non-scaling-stroke" className="glow text-data-1"/></g>
          <g data-deck={toId}><path d={path(1, t => volumeOf(shown, t).in, 0, 1)} fill="none" stroke="currentColor" strokeWidth={2.5} vectorEffect="non-scaling-stroke" className="glow text-data-1"/></g>
        </svg>
        {mode === "curve" && !locked && <CurveLayer curve={editable} left={x0 / 10} width={(x1 - x0) / 10} decks={{ out: fromId, in: toId }} onDraft={setDraft} onCommit={setCurve}/>}
        {motionMode && !locked && <CurveLayer key={motionMode} curve={motionDraft ?? plan[motionMode] ?? { out: [], in: [] }} left={x0 / 10} width={(x1 - x0) / 10} decks={{ out: fromId, in: toId }}
          noun={motionMode} tone={MOTION_BG[motionMode]} describe={g => motionText(motionMode, motionValue(motionMode, g))} onDraft={setMotionDraft} onCommit={c => set({ [motionMode]: c })}/>}
        {stemMode && stemmed && !locked && <CurveLayer key={stemMode} curve={stemDraft ?? stemCurveOf(stemMode)} left={x0 / 10} width={(x1 - x0) / 10} decks={{ out: fromId, in: toId }}
          noun={STEM_LABEL[stemMode].toLowerCase()} tone={STEM_BG[STEM_INDEX[stemMode]]} onDraft={setStemDraft} onCommit={c => set(withStemCurve(stemMode, c))}/>}
        <div ref={topHead} className="pointer-events-none absolute top-0 z-(--z-raised) hidden h-1/2 w-px bg-text-1">
          <span className="absolute top-0 left-0 bg-text-1 px-1 type-micro text-text-inverse tabular-nums"/>
        </div>
        <div ref={bottomHead} className="pointer-events-none absolute bottom-0 z-(--z-raised) hidden h-1/2 w-px bg-text-1">
          <span className="absolute bottom-0 left-0 bg-text-1 px-1 type-micro text-text-inverse tabular-nums"/>
        </div>
      </div>
      <Ruler start={bottomStart} width={span * k} duration={to.duration} edge="bottom" label="Incoming track time"/>
      </div>
      {row(to, toId, !!toDeck, "In", inAt, "in")}
      <ul className="flex flex-wrap gap-x-4 gap-y-1 type-micro text-text-2" aria-label="Legend">
        <li className="flex items-center gap-1.5"><span className="h-0.5 w-3 bg-data-1"/>Volume</li>
        {plan.eq !== "none" && <li className="flex items-center gap-1.5"><span className="h-0.5 w-3 bg-data-5"/>Low band</li>}
        {(colorOut || colorIn) && <li className="flex items-center gap-1.5"><span className="h-0.5 w-3 bg-data-3"/>Filter</li>}
        {sends && <li className="flex items-center gap-1.5"><span className="h-0.5 w-3 bg-data-4"/>Effect send</li>}
        {(["pitch", "speed"] as const).filter(kind => motionLines.some(l => l.kind === kind)).map(kind => <li key={kind} className="flex items-center gap-1.5">
          <span className={cn("h-0.5 w-3", MOTION_BG[kind])}/>{kind === "pitch" ? "Pitch" : "Speed"}</li>)}
        {STEMS.filter((_, i) => stemLines.some(l => l.i === i)).map(stem => <li key={stem.id} className="flex items-center gap-1.5">
          <span className={cn("h-0.5 w-3", STEM_BG[STEM_INDEX[stem.id]])}/>{stem.label}</li>)}
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
      {group("My presets", <div className="flex flex-col gap-2">
        {mine.presets.length > 0 && <div className="flex flex-wrap gap-1.5" role="group" aria-label="My presets">
          {mine.presets.map(p => <span key={p.id} className="flex items-center">
            <Button size="sm" variant={activeMine?.id === p.id ? "secondary" : "ghost"} aria-pressed={activeMine?.id === p.id} disabled={locked}
              onClick={() => applyMine(p.shape)}>{p.name}</Button>
            <Button size="icon-sm" variant="ghost" onClick={() => mine.remove(p.id)} aria-label={`Delete the preset ${p.name}`}><Icon icon={Close}/></Button>
          </span>)}
        </div>}
        {naming !== null
          ? <form className="flex items-center gap-1.5" onSubmit={e => { e.preventDefault(); saveMine(); }}>
              <Input size="sm" value={naming} onValueChange={setNaming} placeholder="Preset name" aria-label="Preset name" autoComplete="off" autoFocus className="flex-1"
                onKeyDown={e => { if (e.key === "Escape") setNaming(null); }}/>
              <Button size="sm" type="submit" disabled={!naming.trim()}>Save</Button>
              <Button size="sm" variant="ghost" type="button" onClick={() => setNaming(null)}>Cancel</Button>
            </form>
          : <Button size="sm" variant="secondary" className="self-start" disabled={!!activeMine}
              onClick={() => setNaming("")}>
              Save as preset
            </Button>}
      </div>, activeMine ? `This transition is your preset ${activeMine.name}.` : mine.presets.length ? undefined : "Shape a transition (curves, eq, effect, stems), then save it to use on any pair.")}
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
      {group("Stems", <div className="flex flex-col gap-2">
        <Pick aria-label="Stem move" items={plan.stems === "custom" ? [...STEM_OPTIONS, { value: "custom" as const, label: "Per stem" }] : STEM_OPTIONS}
          value={plan.stems ?? "none"} disabled={locked || !stemmed} onValueChange={v => set({ stems: v as TransitionStems, stemMoves: undefined, stemCurves: undefined })} className="w-full"/>
        {/* One row per stem: a named move shows here as the rows it comes closest to, and changing any row makes the
            move per stem. Every row on Blend is no stem move at all. */}
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5" role="group" aria-label="Move per stem">
          {STEMS.map(stem => <Fragment key={stem.id}>
            <span className="type-label-sm text-text-2">{stem.label}</span>
            <SegmentedControl fill size="sm" aria-label={`${stem.label} move`} value={moves[stem.id]} disabled={locked || !stemmed}
              onValueChange={v => moveStem(stem.id, v as StemMove)}>
              {STEM_MOVE_OPTIONS.map(o => <SegmentedControlItem key={o.value} value={o.value}>{o.label}</SegmentedControlItem>)}
            </SegmentedControl>
          </Fragment>)}
        </div>
      </div>,
        !stemmed ? undefined : plan.stems === "custom" ? STEM_MOVE_HINT : `${STEM_OPTIONS.find(o => o.value === (plan.stems ?? "none"))?.hint ?? ""} ${STEM_MOVE_HINT}`.trim())}
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
  // The header's play is the set's own transport: it plays the queue with AutoMix mixing each track into the next, and
  // pauses whatever plays. Hearing one transition on its own is the editor's preview loop, which leaves the set alone.
  const setPlaying = dj.decks.A.playing || dj.decks.B.playing;
  const queueReady = dj.auto.queue.items.some(i => i.status !== "failed");
  const resumable = !!live?.trackId;
  const canPlaySet = setPlaying || resumable || queueReady;
  const setLabel = setPlaying ? "Pause the set" : resumable ? "Play the set: AutoMix mixes each track into the next" : "Play the queue from its next track";
  const playSet = () => {
    if (setPlaying) { (["A", "B"] as const).forEach(id => { if (dj.decks[id].playing) void dj.togglePlay(id); }); return; }
    if (resumable && liveDeck) { if (!dj.autoMix) dj.setAutoMix(true); void dj.togglePlay(liveDeck); return; }
    dj.auto.start();
  };
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
    {/* Title, state and meta share a row only where the 740px of actions and meta fit beside them; below that the meta
        drops to its own row and the actions wrap, so the header never pushes the page wider than the screen. */}
    <FrameHeader className="flex-wrap gap-y-1 py-1.5 lg:flex-nowrap lg:py-0">
      <FrameTitle>Transition{transitions > 1 ? ` ${sel + 1}/${transitions}` : ""}</FrameTitle>
      <FrameStatus>
        {locked ? <Status size="sm" status="running">Mixing {Math.round(running.progress * 100)}%</Status>
          : dj.armed && sel === 0 ? <Status size="sm" status="queued">Armed</Status>
          : plan?.by === "ai" ? <Tag size="sm" variant="outline">AI</Tag>
          : plan?.preset === "custom" ? <Tag size="sm" variant="outline">Custom</Tag> : null}
      </FrameStatus>
      {plan && from && <FrameValue meta className="order-last basis-full whitespace-normal lg:order-none lg:basis-auto lg:whitespace-nowrap">{strategyLabel} · {plan.bars} {plan.bars === 1 ? "bar" : "bars"} · {(spanOn(from, plan.bars) / ((fromDeck && dj.decks[fromDeck].rate) || 1)).toFixed(1)} s{rating ? ` · ${rating}` : ""}</FrameValue>}
      <FrameActions className="max-w-full flex-wrap justify-end">
        <Hint label={setLabel}>
          <Button size="icon-sm" variant="ghost" disabled={!canPlaySet} onClick={playSet} aria-label={setLabel}><Icon icon={setPlaying ? Pause : Play}/></Button>
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
