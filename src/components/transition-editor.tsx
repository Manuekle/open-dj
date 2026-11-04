"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/sodium/utils";
import { formatTime, type DeckId, type DeckState, type Track, type TransitionEffect, type TransitionEq, type TransitionPlan, type TransitionPreset, type TransitionStems, type VolumeCurve } from "@/lib/types";
import { PRESETS, barOf, effectAt, lowAt, planRatio, snapToBeat, spanOn, stepBars, volumeAt } from "@/lib/transition";
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
import { Field, FieldLabel } from "@/components/sodium/ui/field";
import { Progress, ProgressLabel, ProgressValue } from "@/components/sodium/ui/progress";
import { Hint } from "@/components/hint";
import { AutoHeight, TextSwap } from "@/components/motion";
import { MIX_KEY } from "@/hooks/use-shortcuts";
import { AudioWave, ChevronLeft, ChevronRight, Icon, Play, Renew, Sparkles } from "@/components/sodium/icon";

const VOLUME: { value: VolumeCurve; label: string; hint: string }[] = [
  { value: "smooth", label: "Crossfade", hint: "Smooth crossfade: both tracks cross on equal-power curves, so the level holds steady." },
  { value: "overlap", label: "Overlap", hint: "The new track comes in early at full level; the old one leaves at the end." },
  { value: "fade", label: "Fade", hint: "Fade in fade out: the old track fades out first, then the new one fades in, with a short gap." },
];
const EQ: { value: TransitionEq; label: string }[] = [{ value: "none", label: "None" }, { value: "bass", label: "Bass swap" }];
const EFFECT: { value: TransitionEffect; label: string }[] = [
  { value: "none", label: "None" }, { value: "lowpass", label: "Low pass" }, { value: "rise", label: "High pass" }, { value: "echo", label: "Echo" },
  { value: "reverb", label: "Reverb" }, { value: "flanger", label: "Flanger" }, { value: "swap", label: "Filter swap" },
];
const EFFECT_HINT: Record<TransitionEffect, string | undefined> = {
  none: undefined,
  lowpass: "A low pass closes on the old track as it leaves.",
  rise: "A high pass opens on the new track as it arrives.",
  echo: "The old track feeds an echo that grows over the second half.",
  reverb: "The old track closes behind a low pass and washes out into reverb.",
  flanger: "A flanger sweeps over the old track to the middle and clears.",
  swap: "The old track thins out under a rising high pass and reverb while the new one opens from a closed low pass.",
};
const STEM_MOVES: { value: TransitionStems; label: string }[] = [{ value: "none", label: "None" }, { value: "vocals", label: "Vocal handover" }];
const BARS = [1, 2, 4, 8, 16];
const BINS = 220;

function presetOf(plan: Pick<TransitionPlan, "volume" | "eq" | "effect">): TransitionPreset {
  const hit = (Object.keys(PRESETS) as (keyof typeof PRESETS)[]).find(k => PRESETS[k].volume === plan.volume && PRESETS[k].eq === plan.eq && PRESETS[k].effect === plan.effect);
  return hit ?? "custom";
}

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

type EditorProps = { mediaTime: (id: DeckId) => number; plan: TransitionPlan; from: Track; to: Track; fromId: DeckId; toId: DeckId; decks: Record<DeckId, DeckState>; locked: boolean; onChange: (plan: TransitionPlan) => void };
function Editor({ mediaTime, plan, from, to, fromId, toId, decks, locked, onChange }: EditorProps) {
  const [drag, setDrag] = useState<{ outAt: number; inAt: number } | null>(null);
  const [data, setData] = useState<{ from: Float32Array; to: Float32Array } | null>(null);
  useEffect(() => {
    let alive = true;
    // Held while the editor draws them, so the cache cannot drop the pair under it; released when the pair changes or it closes.
    const a = holdSamples(from.id, from.blob), b = holdSamples(to.id, to.blob);
    void Promise.all([a.samples, b.samples]).then(([x, y]) => { if (alive) setData({ from: x, to: y }); }).catch(() => {});
    return () => { alive = false; a.release(); b.release(); };
  }, [from, to]);

  const outAt = drag?.outAt ?? plan.outAt, inAt = drag?.inAt ?? plan.inAt;
  const length = spanOn(from, plan.bars);
  const pad = Math.max(barOf(from), length * 0.35);
  const span = length + pad * 2;
  // The same overlap the engine plays: the incoming deck stretches to the outgoing tempo, held to what a deck can stretch to.
  const k = planRatio(plan, from, to, decks[fromId].rate, decks[toId].rate);
  const topStart = outAt - pad, bottomStart = inAt - pad * k;
  const peaksTop = data && regionPeaks(data.from, topStart, topStart + span, BINS);
  const peaksBottom = data && regionPeaks(data.to, bottomStart, bottomStart + span * k, BINS);

  const x0 = pad / span * 1000, x1 = (pad + length) / span * 1000;
  const steps = Array.from({ length: 41 }, (_, i) => i / 40);
  // Each line is flat until the transition starts, follows the curve across it, and steps to where the engine leaves it.
  const path = (lane: 0 | 1, value: (t: number) => number, before: number, after: number) => {
    const y = (g: number) => lane * 100 + 94 - g * 86;
    return `M0 ${y(before)} L${x0} ${y(before)} ` + steps.map(t => `L${x0 + (x1 - x0) * t} ${y(value(t))}`).join(" ") + ` L${x1} ${y(after)} L1000 ${y(after)}`;
  };
  // Filter openness: 1 with the filter wide open, falling as a low pass closes or a high pass rises.
  const open = (c: number) => 1 - Math.min(1, Math.abs(c));
  const fxAt = (t: number) => effectAt(plan.effect, t);
  const colorOut = plan.effect === "lowpass" || plan.effect === "reverb" || plan.effect === "swap";
  const colorIn = plan.effect === "rise" || plan.effect === "swap";
  const sends = plan.effect === "echo" || plan.effect === "reverb" || plan.effect === "flanger" || plan.effect === "swap";

  // The playheads read the media clock every frame; the deck state they came from updates at 10 Hz and would trail the lines.
  const topHead = useRef<HTMLDivElement>(null), bottomHead = useRef<HTMLDivElement>(null);
  const frame = useRef({ topStart, topWidth: span, bottomStart, bottomWidth: span * k, topPlaying: false, bottomPlaying: false });
  useEffect(() => {
    frame.current = { topStart, topWidth: span, bottomStart, bottomWidth: span * k, topPlaying: decks[fromId].playing, bottomPlaying: decks[toId].playing };
  });
  useEffect(() => {
    let raf = 0;
    const place = (el: HTMLDivElement | null, id: DeckId, start: number, width: number, playing: boolean) => {
      if (!el) return;
      const p = (mediaTime(id) - start) / width;
      const show = playing && p >= 0 && p <= 1;
      el.classList.toggle("hidden", !show);
      if (show) el.style.left = `${p * 100}%`;
    };
    const tick = () => {
      const f = frame.current;
      place(topHead.current, fromId, f.topStart, f.topWidth, f.topPlaying);
      place(bottomHead.current, toId, f.bottomStart, f.bottomWidth, f.bottomPlaying);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mediaTime, fromId, toId]);

  const set = (patch: Partial<TransitionPlan>) => { const next = { ...plan, ...patch }; onChange({ ...next, preset: presetOf(next) }); };
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
  const row = (track: Track, deck: DeckId, label: string, at: number, lane: "out" | "in") => <div data-deck={deck} className="flex items-center gap-3">
    <span className="size-2 shrink-0 bg-data-1" aria-hidden/>
    <div className="min-w-0 flex-1">
      <p className="type-body truncate">{track.title}</p>
      <p className="type-body-sm text-text-2 truncate">{track.artist} · Deck {deck === "A" ? 1 : 2} · {track.bpm ? `${track.bpm.toFixed(1)} bpm` : "no tempo"}</p>
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

  return <div className="flex flex-col gap-4 xl:flex-row">
    <div className="flex min-w-0 flex-1 flex-col gap-3">
      {row(from, fromId, "Out", outAt, "out")}
      <div className="relative h-56 border border-line bg-well">
        <Lane peaks={peaksTop} locked={locked} label="Outgoing track, drag to move where it leaves" onDrag={(f, d) => move("out", f, d)}/>
        <Lane peaks={peaksBottom} locked={locked} label="Incoming track, drag to move where it enters" onDrag={(f, d) => move("in", f, d)}/>
        <svg viewBox="0 0 1000 200" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 size-full overflow-visible" aria-hidden>
          <rect x={x0} y={0} width={x1 - x0} height={200} fill="currentColor" fillOpacity={0.06} className="text-text-1"/>
          <line x1={x0} y1={0} x2={x0} y2={200} stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" className="text-line-control"/>
          <line x1={x1} y1={0} x2={x1} y2={200} stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" className="text-line-control"/>
          <line x1={0} y1={100} x2={1000} y2={100} stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" className="text-line"/>
          {plan.eq === "bass" && <>
            <path d={path(0, t => 1 + lowAt("bass", t).out / 24, 1, 1)} fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" className="text-data-5"/>
            <path d={path(1, t => 1 + lowAt("bass", t).in / 24, 0, 1)} fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" className="text-data-5"/>
          </>}
          {colorOut && <path d={path(0, t => open(fxAt(t).outColor), 1, open(fxAt(1).outColor))} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" className="text-data-3"/>}
          {colorIn && <path d={path(1, t => open(fxAt(t).inColor), open(fxAt(0).inColor), 1)} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" className="text-data-3"/>}
          {sends && <path d={path(0, t => fxAt(t).amount, 0, 0)} fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray="2 3" vectorEffect="non-scaling-stroke" className="text-data-4"/>}
          <g data-deck={fromId}><path d={path(0, t => volumeAt(plan.volume, t).out, 1, 0)} fill="none" stroke="currentColor" strokeWidth={2.5} vectorEffect="non-scaling-stroke" className="glow text-data-1"/></g>
          <g data-deck={toId}><path d={path(1, t => volumeAt(plan.volume, t).in, 0, 1)} fill="none" stroke="currentColor" strokeWidth={2.5} vectorEffect="non-scaling-stroke" className="glow text-data-1"/></g>
        </svg>
        <div ref={topHead} className="absolute top-0 hidden h-1/2 w-px bg-text-1"/>
        <div ref={bottomHead} className="absolute bottom-0 hidden h-1/2 w-px bg-text-1"/>
      </div>
      {row(to, toId, "In", inAt, "in")}
      {!!plan.notes?.length && <div className="flex flex-col border-t border-line-faint pt-3">
        <span className="type-label-sm text-text-2">{plan.by === "ai" ? "Why the AI chose this" : "Why this plan"}</span>
        <ul className="flex flex-col">
          {plan.notes.map(note => <li key={note} className="rule-row py-1.5 type-body-sm text-text-2">{note}</li>)}
        </ul>
      </div>}
    </div>

    <div className="flex flex-col gap-3 xl:w-112 xl:shrink-0">
      {group("Length", <SegmentedControl fill size="sm" aria-label="Transition length" value={String(plan.bars)} disabled={locked} onValueChange={v => set({ bars: Number(v) })}>
        {BARS.map(n => <SegmentedControlItem key={n} value={String(n)}>{n} {n === 1 ? "bar" : "bars"}</SegmentedControlItem>)}
      </SegmentedControl>)}
      {group("Volume", <SegmentedControl fill size="sm" aria-label="Volume curve" value={plan.volume} disabled={locked} onValueChange={v => set({ volume: v as VolumeCurve })}>
        {VOLUME.map(o => <SegmentedControlItem key={o.value} value={o.value}>{o.label}</SegmentedControlItem>)}
      </SegmentedControl>, VOLUME.find(o => o.value === plan.volume)?.hint)}
      {group("Eq", <SegmentedControl fill size="sm" aria-label="Eq" value={plan.eq} disabled={locked} onValueChange={v => set({ eq: v as TransitionEq })}>
        {EQ.map(o => <SegmentedControlItem key={o.value} value={o.value}>{o.label}</SegmentedControlItem>)}
      </SegmentedControl>)}
      {group("Effects", <SegmentedControl fill size="sm" aria-label="Effect" value={plan.effect} disabled={locked} onValueChange={v => set({ effect: v as TransitionEffect })}>
        {EFFECT.map(o => <SegmentedControlItem key={o.value} value={o.value}>{o.label}</SegmentedControlItem>)}
      </SegmentedControl>, EFFECT_HINT[plan.effect])}
      {group("Stems", <SegmentedControl fill size="sm" aria-label="Stems" value={plan.stems ?? "none"} disabled={locked || !from.stems || !to.stems}
        onValueChange={v => set({ stems: v as TransitionStems })}>
        {STEM_MOVES.map(o => <SegmentedControlItem key={o.value} value={o.value}>{o.label}</SegmentedControlItem>)}
      </SegmentedControl>, !from.stems || !to.stems ? "Split both tracks into stems to hand the vocals over." : plan.stems === "vocals" ? "The old vocals leave by 40% and the new ones come in from 60%, so two voices never overlap." : undefined)}
      {group("Preset", <SegmentedControl fill size="sm" aria-label="Preset" value={plan.preset === "custom" ? "" : plan.preset} disabled={locked}
        onValueChange={v => { const p = PRESETS[v as keyof typeof PRESETS]; if (p) onChange({ ...plan, volume: p.volume, eq: p.eq, effect: p.effect, preset: v as TransitionPreset }); }}>
        {(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map(key => <SegmentedControlItem key={key} value={key}>{PRESETS[key].label}</SegmentedControlItem>)}
      </SegmentedControl>)}
    </div>
  </div>;
}

/** The transition between the live deck and the other one, edited in place. Every change applies at once. */
export function TransitionPanel({ dj }: { dj: DJ }) {
  const running = dj.transition;
  const plan = running?.plan ?? dj.plan;
  const from = plan && dj.tracks.find(t => t.id === plan.fromId);
  const to = plan && dj.tracks.find(t => t.id === plan.toId);
  const fromId: DeckId = plan && dj.decks.B.trackId === plan.fromId ? "B" : "A";
  const toId: DeckId = fromId === "A" ? "B" : "A";
  const label = plan ? (plan.preset === "custom" ? "Custom" : PRESETS[plan.preset].label) : "";
  // What the plan actually is and how the same criteria the planner uses rate it: the strategy, its length, and the score
  // with the confidence behind it. A running mix has no fresh evaluation, so it shows the plan's own stored numbers.
  const strategyLabel = plan?.strategy ? STRATEGY[plan.strategy].label : label;
  const rated = running ? null : dj.planScore;
  const rating = rated ? `${Math.round(rated.score)}/100 · ${Math.round(rated.confidence * 100)}% confidence`
    : plan?.score !== undefined ? `${Math.round(plan.score)}/100${plan.confidence !== undefined ? ` · ${Math.round(plan.confidence * 100)}% confidence` : ""}` : null;
  const hint = running ? "Stop the mix to edit it."
    : dj.armed ? "Preview armed: the mix starts at the out point."
    : !plan ? (dj.autoMix ? "Auto mix follows the queue: it plans the next pair as soon as one is ready." : "Turn on auto mix to follow the queue and start each mix at its out point.")
    : dj.autoMix ? "Auto mix starts at the out point and keeps any edit you make here. Drag a waveform to move it."
    : "Drag a waveform to move its point; times snap to the beat.";

  return <Frame aria-label="Transition" id="transition">
    <FrameHeader>
      <FrameTitle>Transition</FrameTitle>
      <FrameStatus>
        {running ? <Status size="sm" status="running">Mixing {Math.round(running.progress * 100)}%</Status>
          : dj.armed ? <Status size="sm" status="queued">Armed</Status>
          : plan?.by === "ai" ? <Tag size="sm" variant="outline">AI</Tag>
          : plan?.preset === "custom" ? <Tag size="sm" variant="outline">Custom</Tag> : null}
      </FrameStatus>
      {plan && from && <FrameValue meta>{strategyLabel} · {plan.bars} {plan.bars === 1 ? "bar" : "bars"} · {(spanOn(from, plan.bars) / (dj.decks[fromId].rate || 1)).toFixed(1)} s{rating ? ` · ${rating}` : ""}</FrameValue>}
      <FrameActions>
        <Hint label="Preview from two bars before the out point">
          <Button size="icon-sm" variant="ghost" disabled={!plan || !!running} onClick={() => plan && void dj.preview(plan)} aria-label="Preview from two bars before the out point"><Icon icon={Play}/></Button>
        </Hint>
        <Hint label={dj.aiAvailable === false ? "AI transitions need Ollama running on this machine with the model pulled" : "Plan this transition with the local AI model"}>
          <Button size="sm" variant="secondary" disabled={!plan || !!running || !dj.aiAvailable || !from?.bpm || !to?.bpm}
            pending={!!dj.planning} pendingLabel="Planning" onClick={() => void dj.aiPlan()}><Icon icon={Sparkles}/>AI plan</Button>
        </Hint>
        <Hint label="Reset points and curves to auto">
          <Button size="icon-sm" variant="ghost" disabled={!from || !to || !!running} onClick={() => from && to && dj.resetPlan(from.id, to.id)} aria-label="Reset points and curves to auto"><Icon icon={Renew}/></Button>
        </Hint>
      </FrameActions>
    </FrameHeader>
    {/* Card resize: the region eases between its one-row empty state, the editor and the running mix's progress. */}
    <AutoHeight>
    {plan && from && to
      ? <FrameBody><Editor mediaTime={dj.mediaTime} plan={plan} from={from} to={to} fromId={fromId} toId={toId} decks={dj.decks} locked={!!running} onChange={dj.savePlan}/></FrameBody>
      // Empty, the region keeps to one row: a tall hole between the decks and the console is what it would add.
      : <FrameBody padding="none">
          <Empty variant="plain" size="sm" reason="empty" className="flex-row items-center">
            <EmptyIcon icon={AudioWave}/>
            <EmptyHeader><EmptyTitle>No transition yet</EmptyTitle><EmptyDescription>Load a track on both decks to plan how one mixes into the other.</EmptyDescription></EmptyHeader>
          </Empty>
        </FrameBody>}
    {running && <FrameBody>
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
        : <Hint label="Mix into the other deck now" keys={MIX_KEY}><Button size="sm" disabled={!plan} onClick={() => plan && void dj.mix(plan, true)}>Mix now</Button></Hint>}
    </FrameFooter>
  </Frame>;
}
