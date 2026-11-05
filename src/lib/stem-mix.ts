import { foldMultiple } from "@/lib/transition";

/* The model of the Stems page, kept apart from the audio so it can be tested: a timeline that holds one track (edit) or
   two (mix), each track a layer with a strip per stem, the stretches where a stem is silenced, and a loop.

   Times come in two units. A layer's own seconds are its media time; the timeline's seconds are the first layer's media
   time. A layer starts `offset` timeline seconds in and runs `ratio` of its own seconds per timeline second, so a second
   track synced to the first one's tempo has ratio = its tempo change. Silenced stretches are kept in the layer's own
   seconds, so they move with the layer when it is dragged along the timeline. */

export type Grid = { beat: number; first: number } | null;

/** One stem's channel: level 0..1, mute, solo, a one-knob filter (-1 low pass .. +1 high pass) and pan (-1 .. +1). */
export type Strip = { level: number; mute: boolean; solo: boolean; filter: number; pan: number };
export const makeStrip = (): Strip => ({ level: 1, mute: false, solo: false, filter: 0, pan: 0 });

/** A stretch where one stem is silent, in the layer's own seconds. */
export type Cut = { id: string; stem: number; from: number; to: number };

/** The deck-style controls of a whole layer: volume, three-band EQ in dB, color filter, effect. */
export type LayerMix = { volume: number; eq: [number, number, number]; color: number; fx: string; fxAmount: number };
export const makeLayerMix = (): LayerMix => ({ volume: 1, eq: [0, 0, 0], color: 0, fx: "off", fxAmount: 0.5 });

/** A point of a layer's volume curve: `t` in the layer's own seconds, gain `g` 0..1. */
export type VolumePoint = { t: number; g: number };

/** What the page keeps for one track, whichever mode it is shown in. `volume` is empty while the curve is flat. */
export type TrackEdit = {
  strips: Strip[]; cuts: Cut[]; mix: LayerMix; volume?: VolumePoint[];
  /** A volume curve per stem, in STEMS order, under the layer's own; empty where the stem is not automated. */
  stemVolume?: VolumePoint[][];
};
export const makeTrackEdit = (): TrackEdit => ({ strips: [0, 1, 2, 3].map(makeStrip), cuts: [], mix: makeLayerMix(), volume: [] });

/** How the mix fades A out and B in over the stretch both cover; "custom" is a curve drawn by hand. */
export type FadeShape = "smooth" | "linear" | "cut" | "custom";
export const FADE_OPTIONS = [
  { value: "smooth", label: "Smooth" },
  { value: "linear", label: "Linear" },
  { value: "cut", label: "Cut" },
  { value: "custom", label: "Custom" },
] as const;

/** A volume curve's gain at the layer's own time `local`: flat outside its first and last points, straight between. */
export function envelopeAt(points: VolumePoint[] | undefined, local: number) {
  if (!points?.length) return 1;
  if (local <= points[0].t) return points[0].g;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (local <= b.t) return b.t - a.t < 1e-9 ? b.g : a.g + (b.g - a.g) * (local - a.t) / (b.t - a.t);
  }
  return points[points.length - 1].g;
}

/** A curve with one point moved, kept between its neighbours, or added when `index` is past the end. Sorted by time. */
export function setPoint(points: VolumePoint[], index: number, point: VolumePoint): VolumePoint[] {
  const g = Math.max(0, Math.min(1, point.g));
  const lo = (points[index - 1]?.t ?? -Infinity) + 0.005, hi = (points[index + 1]?.t ?? Infinity) - 0.005;
  const next = points.map(p => ({ ...p }));
  next[index] = { t: Math.max(lo, Math.min(hi, point.t)), g };
  return next;
}

/** A curve with a point inserted where `t` falls; returns the curve and the new point's index. */
export function insertPoint(points: VolumePoint[], point: VolumePoint): [VolumePoint[], number] {
  const index = points.findIndex(p => p.t > point.t);
  const at = index < 0 ? points.length : index;
  return [[...points.slice(0, at), { t: point.t, g: Math.max(0, Math.min(1, point.g)) }, ...points.slice(at)], at];
}

/**
 * The volume curves of a two-track blend over the timeline stretch `span`: A goes from full to silent and B the other
 * way. Smooth keeps the summed power level (cosine and sine), linear is two straight lines, cut switches at `at`.
 * Each curve is in its own layer's seconds, so B's moves with B. Without a span both are flat.
 */
export function crossfade(pa: Placement, pb: Placement, shape: Exclude<FadeShape, "custom">, span: Loop | null, at?: number): [VolumePoint[], VolumePoint[]] {
  if (!span) return [[], []];
  const curve = (xs: number[], gain: (x: number) => number, p: Placement) => xs.map(x => ({ t: localTime(p, span.from + x * (span.to - span.from)), g: gain(x) }));
  if (shape === "cut") {
    const c = Math.max(span.from + 0.01, Math.min(span.to, at ?? (span.from + span.to) / 2));
    return [[{ t: localTime(pa, c - 0.01), g: 1 }, { t: localTime(pa, c), g: 0 }], [{ t: localTime(pb, c - 0.01), g: 0 }, { t: localTime(pb, c), g: 1 }]];
  }
  if (shape === "linear") return [curve([0, 1], x => 1 - x, pa), curve([0, 1], x => x, pb)];
  const xs = Array.from({ length: 9 }, (_, i) => i / 8);
  return [curve(xs, x => Math.cos(x * Math.PI / 2), pa), curve(xs, x => Math.sin(x * Math.PI / 2), pb)];
}

/** A track placed on the timeline. */
export type Placement = { offset: number; ratio: number; duration: number };

export type Loop = { from: number; to: number };

/** How long a cut's edges take to close and open, in beats; 0 cuts straight. */
export const EDGE_OPTIONS = [
  { value: "0", label: "Hard cut" },
  { value: "0.25", label: "Short fade" },
  { value: "1", label: "Beat fade" },
  { value: "4", label: "Bar fade" },
] as const;

/** What a drag snaps to, in beats; 0 is free. */
export const SNAP_OPTIONS = [
  { value: "0", label: "Free" },
  { value: "0.25", label: "1/4 beat" },
  { value: "1", label: "Beat" },
  { value: "4", label: "Bar" },
  { value: "16", label: "4 bars" },
] as const;

export const localTime = (p: Placement, t: number) => (t - p.offset) * p.ratio;
export const timelineTime = (p: Placement, local: number) => p.offset + local / p.ratio;
export const endOf = (p: Placement) => p.offset + p.duration / p.ratio;
export const lengthOf = (ps: Placement[]) => ps.reduce((m, p) => Math.max(m, endOf(p)), 0);
/** Whether a layer has media under timeline time `t`. */
export const covers = (p: Placement, t: number) => { const l = localTime(p, t); return l >= 0 && l < p.duration; };

/** The nearest point of `grid` every `beats` beats; free time without a grid or with beats = 0. */
export function snapTo(x: number, grid: Grid, beats: number) {
  if (!grid || beats <= 0) return x;
  const step = grid.beat * beats;
  return grid.first + Math.round((x - grid.first) / step) * step;
}

/** The grid point at or before `x`, every `beats` beats. */
export function floorTo(x: number, grid: Grid, beats: number) {
  if (!grid || beats <= 0) return x;
  const step = grid.beat * beats;
  return grid.first + Math.floor((x - grid.first) / step + 1e-6) * step;
}

/** A layer's grid as the timeline sees it: its beats mapped through its placement. */
export function gridOnTimeline(grid: Grid, p: Placement): Grid {
  if (!grid) return null;
  return { beat: grid.beat / p.ratio, first: timelineTime(p, grid.first) };
}

/** The ratio that puts a track of `own` bpm on a `target` bpm, half and double time folded. 1 without both tempos. */
export function syncRatio(target: number | null | undefined, own: number | null | undefined) {
  if (!target || !own || target <= 0 || own <= 0) return 1;
  return target / (own * foldMultiple(target, own));
}

/** The offset nearest `desired` that puts the layer's beats on the first layer's grid, every `beats` beats. */
export function alignOffset(desired: number, base: Grid, own: Grid, ratio: number, beats: number) {
  if (!base || !own) return desired;
  const firstBeat = own.first / ratio;
  return snapTo(desired + firstBeat, base, beats) - firstBeat;
}

/** Gain 0..1 that the cuts leave a stem at, at the layer's own time `local`. Edges ramp over `fade` seconds. */
export function cutGain(cuts: Cut[], stem: number, local: number, fade: number) {
  let g = 1;
  for (const c of cuts) {
    if (c.stem !== stem || local < c.from || local > c.to) continue;
    const inside = Math.min(local - c.from, c.to - local);
    const here = fade > 0 ? 1 - Math.min(1, inside / fade) : 0;
    if (here < g) g = here;
  }
  return g;
}

/** Whether a stem sounds by its buttons alone: solo anywhere wins over mute. */
export const audible = (s: Strip, anySolo: boolean) => anySolo ? s.solo : !s.mute;

/** The gain one stem gets at timeline time `t`: its level, its buttons, its cuts, the layer's volume and its curve. */
export function stemGain(edit: TrackEdit, p: Placement, stem: number, t: number, anySolo: boolean, fade: number) {
  const s = edit.strips[stem];
  if (!audible(s, anySolo)) return 0;
  const local = localTime(p, t);
  return s.level * edit.mix.volume * envelopeAt(edit.volume, local) * envelopeAt(edit.stemVolume?.[stem], local) * cutGain(edit.cuts, stem, local, fade);
}

/** Adds a cut, joined with the cuts of the same stem it touches. Shorter than 10 ms it is ignored. */
export function addCut(cuts: Cut[], cut: Cut): Cut[] {
  let from = Math.min(cut.from, cut.to), to = Math.max(cut.from, cut.to);
  if (to - from < 0.01) return cuts;
  const keep: Cut[] = [];
  for (const c of cuts) {
    if (c.stem === cut.stem && c.from <= to && c.to >= from) { from = Math.min(from, c.from); to = Math.max(to, c.to); }
    else keep.push(c);
  }
  return [...keep, { ...cut, from, to }].sort((a, b) => a.stem - b.stem || a.from - b.from);
}

/** The cut of `stem` under `local`, if any. */
export const cutAt = (cuts: Cut[], stem: number, local: number) => cuts.find(c => c.stem === stem && local >= c.from && local <= c.to);

/** A loop from two times in any order, at least `min` long. */
export function loopOf(a: number, b: number, min = 0.05): Loop | null {
  const from = Math.min(a, b), to = Math.max(a, b);
  return to - from >= min ? { from, to } : null;
}

/** A loop of `bars` bars from the bar under `t`; `seconds` long from `t` without a grid. */
export function barLoop(t: number, grid: Grid, bars: number): Loop {
  if (!grid) return { from: t, to: t + bars * 2 };
  const from = floorTo(t, grid, 4);
  return { from, to: from + bars * 4 * grid.beat };
}

/** Bar number (1-based) under timeline time `t`, or null without a grid. */
export const barNumber = (t: number, grid: Grid) => grid ? Math.floor((t - grid.first) / (grid.beat * 4) + 1e-6) + 1 : null;

/**
 * A stem swap between the two layers at timeline time `at`, like a transition's stem move: from `at` on, the first
 * layer's stem is silent; until `at`, the second layer's is. Earlier cuts on those stems are replaced.
 */
export function swapStem(a: TrackEdit, pa: Placement, b: TrackEdit, pb: Placement, stem: number, at: number, id: () => string): [TrackEdit, TrackEdit] {
  const fromA = localTime(pa, at), toB = localTime(pb, at);
  const nextA = fromA < pa.duration ? addCut(a.cuts.filter(c => c.stem !== stem), { id: id(), stem, from: Math.max(0, fromA), to: pa.duration }) : a.cuts.filter(c => c.stem !== stem);
  const nextB = toB > 0 ? addCut(b.cuts.filter(c => c.stem !== stem), { id: id(), stem, from: 0, to: Math.min(pb.duration, toB) }) : b.cuts.filter(c => c.stem !== stem);
  return [{ ...a, cuts: nextA }, { ...b, cuts: nextB }];
}

/** The part of the timeline both layers cover, or null. */
export function overlap(pa: Placement, pb: Placement): Loop | null {
  const from = Math.max(pa.offset, pb.offset), to = Math.min(endOf(pa), endOf(pb));
  return to > from ? { from, to } : null;
}

/** Visible window of the timeline: `from` and `span` in timeline seconds, kept inside 0..total. */
export type View = { from: number; span: number };
export function clampView(v: View, total: number, minSpan = 2): View {
  const span = Math.max(Math.min(minSpan, total || minSpan), Math.min(total || v.span, v.span));
  return { from: Math.max(0, Math.min(Math.max(0, total - span), v.from)), span };
}
/** Zooms by `factor` (below 1 zooms in) keeping timeline time `at` under the same point of the view. */
export function zoomView(v: View, factor: number, at: number, total: number): View {
  const span = v.span * factor, k = (at - v.from) / v.span;
  return clampView({ from: at - k * span, span }, total);
}
