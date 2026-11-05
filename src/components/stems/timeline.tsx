"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/sodium/utils";
import { STEMS, formatTime, type StoredTrack } from "@/lib/types";
import { addCut, alignOffset, audible, cutAt, endOf, envelopeAt, gridOnTimeline, insertPoint, localTime, loopOf, setPoint, snapTo, timelineTime, zoomView, type Cut, type Grid, type Loop, type Placement, type Strip, type TrackEdit, type View, type VolumePoint } from "@/lib/stem-mix";
import type { StemPeaks } from "@/lib/stem-peaks";
import { Button } from "@/components/sodium/ui/button";
import { Slider } from "@/components/sodium/ui/slider";

export type { Grid } from "@/lib/stem-mix";

/** Chart series tokens per stem, in STEMS order. */
export const LANE_COLORS = ["--data-1", "--data-6", "--data-2", "--data-5"];
const BAR_STEPS = [1, 2, 4, 8, 16, 32, 64];

export const gridOf = (t: StoredTrack): Grid => t.bpm && t.bpm > 0 ? { beat: 60 / t.bpm, first: t.firstBeat ?? 0 } : null;
export const token = (name: string) => getComputedStyle(document.body).getPropertyValue(name).trim();
const first = (v: number | readonly number[]) => Array.isArray(v) ? v[0] : v as number;

/** Canvas sized to its box at the display's pixel ratio, redrawn through `draw` when the size or `deps` change. */
export function useCanvas(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, deps: unknown[]) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el || !size.w || !size.h) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.round(size.w * dpr); el.height = Math.round(size.h * dpr);
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    draw(ctx, size.w, size.h);
    // draw is rebuilt every render; deps names what it actually reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, ...deps]);
  return ref;
}

/** Each beat of `grid` inside the view, with whether it starts a bar and its bar index. */
function* beats(grid: Grid, view: View) {
  if (!grid) return;
  const start = Math.max(0, Math.ceil((view.from - grid.first) / grid.beat));
  for (let n = start; ; n++) {
    const t = grid.first + n * grid.beat;
    if (t > view.from + view.span) return;
    if (t < 0) continue;
    yield { t, bar: n % 4 === 0, index: n / 4 };
  }
}

/** Bar numbers (or minutes without a grid) over the timeline, for the part of it in `view` (all of it when omitted). */
export function Ruler({ duration, grid, view }: { duration: number; grid: Grid; view?: View }) {
  const v = view ?? { from: 0, span: duration };
  const ref = useCanvas((ctx, w, h) => {
    if (!duration || !v.span) return;
    const line = token("--line"), text = token("--text-3"), mono = token("--font-mono");
    ctx.font = `11px ${mono}`; ctx.textBaseline = "top"; ctx.fillStyle = text; ctx.strokeStyle = line; ctx.lineWidth = 1;
    const px = w / v.span, x = (t: number) => (t - v.from) * px;
    const tick = (at: number, tall: boolean) => { ctx.beginPath(); ctx.moveTo(Math.round(at) + 0.5, h - (tall ? 12 : 5)); ctx.lineTo(Math.round(at) + 0.5, h); ctx.stroke(); };
    if (grid) {
      const barPx = grid.beat * 4 * px;
      const every = BAR_STEPS.find(s => s * barPx >= 44) ?? BAR_STEPS[BAR_STEPS.length - 1];
      for (const b of beats(grid, v)) {
        if (b.bar) { tick(x(b.t), true); if (b.index % every === 0) ctx.fillText(String(b.index + 1), x(b.t) + 4, 3); }
        else if (grid.beat * px >= 8) tick(x(b.t), false);
      }
    } else {
      const every = [1, 2, 5, 10, 15, 30, 60, 120].find(s => s * px >= 56) ?? 120;
      for (let t = Math.ceil(v.from / every) * every; t <= Math.min(duration, v.from + v.span); t += every) { tick(x(t), true); ctx.fillText(formatTime(t), x(t) + 4, 3); }
    }
  }, [duration, grid, v.from, v.span]);
  return <canvas ref={ref} className="block h-7 w-full" aria-hidden="true"/>;
}

/** One stem's waveform where its layer sits on the timeline, over the layer's beat lines. */
function Wave({ peaks, color, dim, placement, grid, view }: { peaks: StemPeaks | undefined; color: string; dim: boolean; placement: Placement; grid: Grid; view: View }) {
  const ref = useCanvas((ctx, w, h) => {
    if (!view.span) return;
    const faint = token("--line-faint"), strong = token("--line");
    const px = w / view.span, xOf = (t: number) => (t - view.from) * px;
    for (const b of beats(grid, view)) {
      if (!b.bar && grid!.beat * px < 8) continue;
      ctx.strokeStyle = b.bar ? strong : faint; ctx.lineWidth = 1;
      const x = Math.round(xOf(b.t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    if (!peaks) return;
    const mid = h / 2, amp = mid - 4, n = peaks.max.length, d = placement.duration;
    const from = Math.max(0, Math.floor(xOf(placement.offset))), to = Math.min(w, Math.ceil(xOf(endOf(placement))));
    ctx.fillStyle = token(color); ctx.globalAlpha = dim ? 0.25 : 1;
    // One column per pixel, each the extremes of the buckets it covers.
    for (let x = from; x < to; x++) {
      const a = localTime(placement, view.from + x / px), b = localTime(placement, view.from + (x + 1) / px);
      const i0 = Math.max(0, Math.floor(a / d * n)), i1 = Math.min(n, Math.max(i0 + 1, Math.floor(b / d * n)));
      let lo = 0, hi = 0;
      for (let i = i0; i < i1; i++) { if (peaks.min[i] < lo) lo = peaks.min[i]; if (peaks.max[i] > hi) hi = peaks.max[i]; }
      const top = mid - hi * amp, bottom = mid - lo * amp;
      ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
    ctx.globalAlpha = 1;
  }, [peaks, color, dim, placement.offset, placement.ratio, placement.duration, grid, view.from, view.span]);
  return <canvas ref={ref} className="pointer-events-none absolute inset-0 block size-full" aria-hidden="true"/>;
}

/** Media time of one layer (minutes and seconds) under the timeline, so a second track shows where in itself it is. */
function TimeRuler({ placement, view }: { placement: Placement; view: View }) {
  const ref = useCanvas((ctx, w, h) => {
    if (!view.span) return;
    const line = token("--line"), text = token("--text-3"), mono = token("--font-mono");
    ctx.font = `11px ${mono}`; ctx.textBaseline = "bottom"; ctx.fillStyle = text; ctx.strokeStyle = line; ctx.lineWidth = 1;
    const px = w / view.span, perLocal = px / placement.ratio;
    const every = [1, 2, 5, 10, 15, 30, 60, 120].find(s => s * perLocal >= 64) ?? 120;
    const a = Math.max(0, localTime(placement, view.from)), b = Math.min(placement.duration, localTime(placement, view.from + view.span));
    for (let l = Math.ceil(a / every) * every; l <= b; l += every) {
      const x = Math.round((timelineTime(placement, l) - view.from) * px) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 8); ctx.stroke();
      ctx.fillText(formatTime(l), x + 4, h - 3);
    }
  }, [placement.offset, placement.ratio, placement.duration, view.from, view.span]);
  return <canvas ref={ref} className="block h-7 w-full" aria-hidden="true"/>;
}

/** The whole track's waveform from its stems: the widest stem at each point. */
export function summed(peaks: StemPeaks[] | undefined): StemPeaks | undefined {
  if (!peaks?.length) return undefined;
  const n = peaks[0].max.length, min = new Float32Array(n), max = new Float32Array(n);
  for (const p of peaks) for (let i = 0; i < n; i++) { if (p.min[i] < min[i]) min[i] = p.min[i]; if (p.max[i] > max[i]) max[i] = p.max[i]; }
  return { min, max };
}

/** Space above and below a volume curve, as a fraction of the lane's height, so full and silent stay visible. */
const PAD = 0.08;
const yOf = (g: number) => PAD + (1 - g) * (1 - 2 * PAD);
const gOf = (y: number) => 1 - (y - PAD) / (1 - 2 * PAD);

/** One layer's volume curve over its lane: a line in the view and a square handle per point. */
function CurveLine({ points, placement, view, stroke, handles }: { points: VolumePoint[]; placement: Placement; view: View; stroke: string; handles: boolean }) {
  const from = Math.max(view.from, placement.offset), to = Math.min(view.from + view.span, endOf(placement));
  if (to <= from) return null;
  const x = (t: number) => (t - view.from) / view.span * 1000;
  const inside = points.map(p => ({ t: timelineTime(placement, p.t), g: p.g })).filter(p => p.t > from && p.t < to);
  const line = [{ t: from, g: envelopeAt(points, localTime(placement, from)) }, ...inside, { t: to, g: envelopeAt(points, localTime(placement, to)) }];
  return <>
    <svg viewBox="0 0 1000 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
      <polyline points={line.map(p => `${x(p.t)},${yOf(p.g) * 100}`).join(" ")} fill="none" stroke={`var(${stroke})`} strokeWidth={2} vectorEffect="non-scaling-stroke"/>
    </svg>
    {handles && inside.map((p, i) => <span key={i} aria-hidden="true" style={{ "--l": `${x(p.t) / 10}%`, "--t": `${yOf(p.g) * 100}%`, "--c": `var(${stroke})` } as React.CSSProperties}
      className="pointer-events-none absolute left-(--l) top-(--t) size-2.5 -translate-1/2 border border-(--c) bg-panel"/>)}
  </>;
}

export type TimelineLayer = {
  key: string; name: string | null; track: StoredTrack; placement: Placement; edit: TrackEdit;
  peaks: StemPeaks[] | undefined; grid: Grid; movable: boolean;
  /** Token of the layer's volume curve. */
  curve: string;
};
export type Tool = "move" | "loop" | "cut" | "volume";

type Drag =
  | { kind: "scrub" }
  | { kind: "loop"; a: number; b: number }
  | { kind: "cut"; layer: number; stem: number; a: number; b: number; hit: Cut | undefined; moved: boolean }
  | { kind: "clip"; layer: number; x: number; offset: number }
  | { kind: "ruler"; a: number; b: number; x: number; moved: boolean }
  | { kind: "point"; layer: number; stem: number | null; index: number; points: VolumePoint[] };

/** Where a stretch of timeline time sits in the view, as a left and a width in percent, or null when it is out of it. */
function box(from: number, to: number, view: View) {
  const l = (from - view.from) / view.span, r = (to - view.from) / view.span;
  if (r <= 0 || l >= 1) return null;
  const left = Math.max(0, l), right = Math.min(1, r);
  return { "--l": `${left * 100}%`, "--w": `${(right - left) * 100}%` } as React.CSSProperties;
}

/**
 * The playlist: a ruler, then per layer a clip row and one lane per stem, each lane with its channel (mute, solo, level,
 * filter, pan) at the left. What a drag on the lanes does depends on the tool: move the playhead, draw the loop, or draw
 * a cut (a stretch where that stem is silent; a click on a cut removes it). A drag on the ruler always draws the loop,
 * a click on it moves the playhead. The clip row of a movable layer drags the whole layer along the timeline.
 */
export function Timeline({ layers, total, view, onView, baseGrid, tool, snapBeats, loop, loopOn, playhead, onSeek, onLoop, onCuts, onOffset, onStrip, onVolume }: {
  layers: TimelineLayer[]; total: number; view: View; onView: (v: View) => void; baseGrid: Grid;
  tool: Tool; snapBeats: number; loop: Loop | null; loopOn: boolean; playhead: React.RefObject<HTMLDivElement | null>;
  onSeek: (t: number) => void; onLoop: (loop: Loop | null) => void;
  onCuts: (layer: number, update: (cuts: Cut[]) => Cut[]) => void;
  onOffset: (layer: number, offset: number) => void;
  onStrip: (layer: number, stem: number, patch: Partial<Strip>) => void;
  /** A layer's curve (stem null) or one stem's curve. */
  onVolume: (layer: number, points: VolumePoint[], stem: number | null) => void;
}) {
  const area = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const anySolo = layers.some(l => l.edit.strips.some(s => s.solo));
  const peakKey = layers.map(l => l.peaks).join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const summedPeaks = useMemo(() => layers.map(l => summed(l.peaks)), [peakKey, layers.length]);
  const viewRef = useRef({ view, total, onView });
  useEffect(() => { viewRef.current = { view, total, onView }; });

  // Ctrl or Cmd and the wheel zoom around the pointer; a sideways or Shift wheel scrolls.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      const { view: v, total: len, onView: set } = viewRef.current;
      const box = el.getBoundingClientRect(), at = v.from + (e.clientX - box.left) / box.width * v.span;
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); set(zoomView(v, Math.exp(e.deltaY * 0.01), at, len)); return; }
      const dx = e.shiftKey ? e.deltaY : e.deltaX;
      if (Math.abs(dx) < 1 || v.span >= len) return;
      e.preventDefault();
      set(zoomView({ from: v.from + dx / box.width * v.span, span: v.span }, 1, 0, len));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  const timeAt = (e: React.PointerEvent) => {
    const b = area.current!.getBoundingClientRect();
    return view.from + Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)) * view.span;
  };
  const snapLoop = (t: number) => snapTo(t, baseGrid, snapBeats);
  const layerGrid = (i: number) => gridOnTimeline(layers[i].grid, layers[i].placement);

  const down = (e: React.PointerEvent, start: Drag) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag(start);
    if (start.kind === "scrub") onSeek(timeAt(e));
  };
  const move = (e: React.PointerEvent) => {
    if (!drag || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const t = timeAt(e);
    if (drag.kind === "scrub") onSeek(t);
    else if (drag.kind === "loop") setDrag({ ...drag, b: snapLoop(t) });
    else if (drag.kind === "ruler") setDrag({ ...drag, b: snapLoop(t), moved: drag.moved || Math.abs(e.clientX - drag.x) > 4 });
    else if (drag.kind === "cut") setDrag({ ...drag, b: snapTo(t, layerGrid(drag.layer), snapBeats), moved: true });
    else if (drag.kind === "point") {
      const l = layers[drag.layer], lane = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const local = localTime(l.placement, snapTo(t, layerGrid(drag.layer), snapBeats));
      setDrag({ ...drag, points: setPoint(drag.points, drag.index, { t: Math.max(0, Math.min(l.placement.duration, local)), g: gOf((e.clientY - lane.top) / lane.height) }) });
    }
    else if (drag.kind === "clip") {
      const l = layers[drag.layer], w = area.current!.clientWidth;
      const raw = Math.max(-l.placement.duration / l.placement.ratio + 1, drag.offset + (e.clientX - drag.x) / w * view.span);
      onOffset(drag.layer, alignOffset(raw, baseGrid, l.grid, l.placement.ratio, snapBeats));
    }
  };
  const up = (e: React.PointerEvent) => {
    if (!drag) return;
    if (drag.kind === "loop") onLoop(loopOf(drag.a, drag.b));
    if (drag.kind === "point") onVolume(drag.layer, drag.points, drag.stem);
    if (drag.kind === "ruler") { if (drag.moved) onLoop(loopOf(drag.a, drag.b)); else onSeek(timeAt(e)); }
    if (drag.kind === "cut") {
      const p = layers[drag.layer].placement;
      if (!drag.moved && drag.hit) { const hit = drag.hit; onCuts(drag.layer, cuts => cuts.filter(c => c.id !== hit.id)); }
      else if (drag.moved) {
        const from = Math.max(0, localTime(p, Math.min(drag.a, drag.b))), to = Math.min(p.duration, localTime(p, Math.max(drag.a, drag.b)));
        if (to > from) { const stem = drag.stem; onCuts(drag.layer, cuts => addCut(cuts, { id: crypto.randomUUID(), stem, from, to })); }
      }
    }
    setDrag(null);
  };
  const handlers = { onPointerMove: move, onPointerUp: up, onPointerCancel: () => setDrag(null) };

  const laneDown = (e: React.PointerEvent, layer: number, stem: number) => {
    const t = timeAt(e);
    if (tool === "move") down(e, { kind: "scrub" });
    else if (tool === "loop") down(e, { kind: "loop", a: snapLoop(t), b: snapLoop(t) });
    else if (tool === "volume") curveDown(e, layer, stem);
    else {
      const l = layers[layer], s = snapTo(t, layerGrid(layer), snapBeats);
      down(e, { kind: "cut", layer, stem, a: s, b: s, hit: cutAt(l.edit.cuts, stem, localTime(l.placement, t)), moved: false });
    }
  };

  /** The volume lane of a layer: the tool decides between moving the playhead or the layer, the loop, and the curve. */
  const blendDown = (e: React.PointerEvent, layer: number) => {
    const t = timeAt(e), l = layers[layer];
    if (tool === "loop") { down(e, { kind: "loop", a: snapLoop(t), b: snapLoop(t) }); return; }
    if (tool !== "volume") {
      if (l.movable && tool === "move") down(e, { kind: "clip", layer, x: e.clientX, offset: l.placement.offset });
      else down(e, { kind: "scrub" });
      return;
    }
    curveDown(e, layer, null);
  };
  const curveOf = (layer: number, stem: number | null) => (stem === null ? layers[layer].edit.volume : layers[layer].edit.stemVolume?.[stem]) ?? [];
  /** The Volume tool on a lane: a press near a handle takes it, anywhere else adds a point there. */
  const curveDown = (e: React.PointerEvent, layer: number, stem: number | null) => {
    const l = layers[layer], lane = e.currentTarget.getBoundingClientRect(), points = curveOf(layer, stem), t = timeAt(e);
    const near = points.findIndex(p => Math.abs((timelineTime(l.placement, p.t) - view.from) / view.span * lane.width - (e.clientX - lane.left)) < 8
      && Math.abs(yOf(p.g) * lane.height - (e.clientY - lane.top)) < 10);
    if (near >= 0) { down(e, { kind: "point", layer, stem, index: near, points }); return; }
    const local = localTime(l.placement, snapTo(t, layerGrid(layer), snapBeats));
    if (local < 0 || local > l.placement.duration) return;
    const [next, index] = insertPoint(points, { t: local, g: gOf((e.clientY - lane.top) / lane.height) });
    down(e, { kind: "point", layer, stem, index, points: next });
  };
  /** Double-click on a handle removes it. */
  const curveDouble = (e: React.MouseEvent, layer: number, stem: number | null) => {
    if (tool !== "volume") return;
    const l = layers[layer], lane = e.currentTarget.getBoundingClientRect(), points = curveOf(layer, stem);
    const near = points.findIndex(p => Math.abs((timelineTime(l.placement, p.t) - view.from) / view.span * lane.width - (e.clientX - lane.left)) < 8);
    if (near >= 0) onVolume(layer, points.filter((_, i) => i !== near), stem);
  };

  const loopShown = drag?.kind === "loop" || (drag?.kind === "ruler" && drag.moved) ? loopOf(drag.a, drag.b) : loop;
  const loopBox = loopShown ? box(loopShown.from, loopShown.to, view) : null;
  const cursor = tool === "move" ? "cursor-text" : tool === "loop" ? "cursor-col-resize" : "cursor-crosshair";
  const mix = layers.length > 1;
  const blendCursor = (l: TimelineLayer) => tool === "volume" ? "cursor-crosshair" : tool === "loop" ? "cursor-col-resize" : l.movable && tool === "move" ? "cursor-grab active:cursor-grabbing" : "cursor-text";
  const pointsOf = (i: number, stem: number | null = null) => drag?.kind === "point" && drag.layer === i && drag.stem === stem ? drag.points : curveOf(i, stem);

  return <div className="flex">
    {/* Channels: one per stem lane, in the same rows as the lanes. */}
    <div className="w-60 shrink-0 border-e border-line">
      <div className="h-7 border-b border-line"/>
      {layers.map(l => <div key={l.key} className="flex h-28 flex-col justify-center gap-1 border-b border-line px-3">
        <div className="flex items-center gap-2">
          <span className="size-(--marker) shrink-0 bg-(--swatch)" style={{ "--swatch": `var(${l.curve})` } as React.CSSProperties} aria-hidden="true"/>
          {l.name && <span className="type-label-sm text-text-1">{l.name}</span>}
          <span className="min-w-0 truncate type-body-sm text-text-1">{l.track.title}</span>
        </div>
        <span className="type-body-sm text-text-3">{l.track.bpm ? `${(l.track.bpm * l.placement.ratio).toFixed(1)} bpm` : "No tempo"}{(l.edit.volume?.length ?? 0) > 0 ? ` · ${l.edit.volume!.length} volume points` : ""}</span>
      </div>)}
      {mix && <div className="h-7 border-b border-line"/>}
      {layers.map((l, i) => <div key={l.key}>
        <div className="flex h-8 items-center gap-2 border-b border-line px-3">
          <span className="type-label-sm text-text-3">{l.name ? `${l.name} stems` : "Stems"}</span>
        </div>
        {STEMS.map((s, k) => {
          const strip = l.edit.strips[k], on = audible(strip, anySolo);
          return <div key={s.id} className="flex h-24 flex-col justify-center gap-1.5 border-b border-line-faint px-3">
            <div className="flex items-center gap-2">
              <span className={cn("size-(--marker) shrink-0 bg-(--swatch)", !on && "opacity-30")} style={{ "--swatch": `var(${LANE_COLORS[k]})` } as React.CSSProperties} aria-hidden="true"/>
              <span className="min-w-0 flex-1 truncate type-label text-text-1">{s.label}</span>
              <Button size="icon-sm" variant={strip.mute ? "primary" : "secondary"} aria-pressed={strip.mute} aria-label={`Mute ${l.name ?? ""} ${s.label}`}
                onClick={() => onStrip(i, k, { mute: !strip.mute })}><span className="type-label-sm">M</span></Button>
              <Button size="icon-sm" variant={strip.solo ? "primary" : "secondary"} aria-pressed={strip.solo} aria-label={`Solo ${l.name ?? ""} ${s.label}`}
                onClick={() => onStrip(i, k, { solo: !strip.solo })}><span className="type-label-sm">S</span></Button>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-8 type-micro text-text-3">Lvl</span>
              <Slider className="flex-1" aria-label={`${s.label} level`} min={0} max={150} value={Math.round(strip.level * 100)}
                onValueChange={v => onStrip(i, k, { level: first(v) / 100 })}/>
              <span className="w-9 text-end type-code-sm text-text-2">{Math.round(strip.level * 100)}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-8 type-micro text-text-3">{Math.abs(strip.filter) < 0.02 ? "Flt" : strip.filter < 0 ? "LP" : "HP"}</span>
              <Slider className="flex-1" aria-label={`${s.label} filter`} min={-100} max={100} value={Math.round(strip.filter * 100)}
                onValueChange={v => { const x = first(v) / 100; onStrip(i, k, { filter: Math.abs(x) < 0.04 ? 0 : x }); }}/>
              <span className="w-8 type-micro text-text-3">Pan</span>
              <Slider className="w-14" aria-label={`${s.label} pan`} min={-100} max={100} value={Math.round(strip.pan * 100)}
                onValueChange={v => { const x = first(v) / 100; onStrip(i, k, { pan: Math.abs(x) < 0.06 ? 0 : x }); }}/>
            </div>
          </div>;
        })}
      </div>)}
    </div>

    <div ref={area} className="relative min-w-0 flex-1 touch-none select-none">
      <div className="cursor-col-resize border-b border-line"
        onPointerDown={e => { const t = snapLoop(timeAt(e)); down(e, { kind: "ruler", a: t, b: t, x: e.clientX, moved: false }); }} {...handlers}>
        <Ruler duration={total} grid={baseGrid} view={view}/>
      </div>
      {layers.map((l, i) => <div key={l.key} className={cn("relative h-28 border-b border-line", blendCursor(l))}
        onPointerDown={e => blendDown(e, i)} onDoubleClick={e => curveDouble(e, i, null)} {...handlers}>
        <Wave peaks={summedPeaks[i]} color="--line-control" dim={false} placement={l.placement} grid={layerGrid(i)} view={view}/>
        <CurveLine points={pointsOf(i)} placement={l.placement} view={view} stroke={l.curve} handles={tool === "volume"}/>
      </div>)}
      {mix && <div className="border-b border-line"><TimeRuler placement={layers[layers.length - 1].placement} view={view}/></div>}
      {layers.map((l, i) => {
        return <div key={l.key}>
          <div className="relative h-8 border-b border-line">
            {(() => { const clip = box(l.placement.offset, endOf(l.placement), view); return clip && <div className="pointer-events-none absolute inset-y-1 left-(--l) flex w-(--w) items-center overflow-hidden border border-line-faint px-2" style={clip}>
              <span className="truncate type-label-sm text-text-3">{l.name ? `${l.name} · ` : ""}{l.track.title}</span>
            </div>; })()}
          </div>
          {STEMS.map((s, k) => {
            const strip = l.edit.strips[k];
            const preview = drag?.kind === "cut" && drag.layer === i && drag.stem === k && drag.moved ? box(Math.min(drag.a, drag.b), Math.max(drag.a, drag.b), view) : null;
            return <div key={s.id} className={cn("relative h-24 border-b border-line-faint", cursor)}
              onPointerDown={e => laneDown(e, i, k)} onDoubleClick={e => curveDouble(e, i, k)} {...handlers}>
              <Wave peaks={l.peaks?.[k]} color={LANE_COLORS[k]} dim={!audible(strip, anySolo)} placement={l.placement} grid={layerGrid(i)} view={view}/>
              {l.edit.cuts.filter(c => c.stem === k).map(c => {
                const style = box(timelineTime(l.placement, c.from), timelineTime(l.placement, c.to), view);
                return style && <div key={c.id} style={style} title={tool === "cut" ? "Click to remove this cut" : undefined}
                  className="pointer-events-none absolute inset-y-0 left-(--l) w-(--w) border-x border-line-control bg-scrim">
                  <span className="absolute start-1 top-1 type-micro text-text-2">Muted</span>
                </div>;
              })}
              {(tool === "volume" || pointsOf(i, k).length > 0) && <CurveLine points={pointsOf(i, k)} placement={l.placement} view={view} stroke="--text-1" handles={tool === "volume"}/>}
              {preview && <div style={preview} className="pointer-events-none absolute inset-y-0 left-(--l) w-(--w) border-x border-accent-edge bg-scrim"/>}
            </div>;
          })}
        </div>;
      })}
      {loopBox && <div style={loopBox} aria-hidden="true"
        className={cn("pointer-events-none absolute inset-y-0 left-(--l) w-(--w) border-x border-accent-edge", loopOn || drag ? "bg-selected/35" : "bg-selected/15")}/>}
      <div ref={playhead} className="pointer-events-none absolute inset-y-0 left-0 w-px bg-accent-edge" aria-hidden="true"/>
    </div>
  </div>;
}
