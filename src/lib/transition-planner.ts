import { ANALYSIS_VERSION } from "@/lib/analyze";
import { gridBpm } from "@/lib/grid";
import {
  HARMONY_LABEL, autoTrim, barOf, bassOver, bodyEnd, foldMultiple, handsVocals, harmony, mainEntry, mainStart, meanDb, movesStems, outroStart,
  overlapShare, presetOf, snapToBar, spanOn, swapsBassStem, tempoGap, vocalsOver, type Harmony,
} from "@/lib/transition";
import { formatTime, type CustomCurve, type Track, type TransitionEffect, type TransitionEq, type TransitionPlan, type TransitionShape, type TransitionStems, type TransitionStrategy, type VolumeCurve } from "@/lib/types";

/* Smart AutoMix's transition planner. For a pair of tracks it builds candidate transitions (a strategy, a length, an out
   point and an in point), scores each from 0 to 100 against the analysis, and picks one.

   Everything comes from numbers the analysis measured: tempo and beat strength, Camelot key and its clarity, loudness per
   second, the low band and stem levels. Where a number is missing, the criterion that needs it drops out of the score and
   the confidence says so; nothing is filled in. The structure it reads is the loudness heuristics in lib/transition
   (where the level steps against the track's median), not detected verses, choruses or downbeats.

   Pure and deterministic: no randomness, no clock, no model. The plan it returns is an ordinary TransitionPlan, so mix(),
   the curves in lib/transition and the editor's draggable points all work on it unchanged. */

export const STRATEGIES: TransitionStrategy[] = ["smooth-blend", "beatmatch", "energy-boost", "eq-transition", "quick-cut", "fallback"];

type Spec = {
  label: string;
  /** Lengths tried, in bars of the outgoing track, longest first. */
  bars: number[];
  /** "sync": tempo-matched and beat-aligned, so it needs a tempo on both tracks. "grid": placed on bar lines, so it needs
      a tempo on both, but may leave the incoming deck at its own tempo. "none": works without a tempo. */
  tempo: "sync" | "grid" | "none";
  /** Largest tempo change, as a fraction, a synced plan of this strategy stretches the incoming track by. */
  maxGap: number;
  /** Tempo change at which the tempo score of a synced plan reaches 0. Unsynced, a change of UNSYNCED_TOLERANCE does. */
  tolerance: number;
  /** How much a key clash counts against it, 0..1: a long overlap exposes a clash, a cut barely does. */
  harmony: number;
  /** Where it wants the heard level to go across the transition. */
  energy: EnergyTarget;
  summary: string;
};
type EnergyTarget = "level" | "rise" | "fall" | "any";

export const STRATEGY: Record<TransitionStrategy, Spec> = {
  "smooth-blend": { label: "Smooth Blend", bars: [16], tempo: "sync", maxGap: 0.04, tolerance: 0.04, harmony: 1, energy: "level",
    summary: "A 16-bar equal-power blend, beat-matched, for keys that sit together and a tempo that barely moves." },
  beatmatch: { label: "Beatmatch", bars: [8, 4], tempo: "sync", maxGap: 0.08, tolerance: 0.08, harmony: 0.8, energy: "level",
    summary: "A beat-matched blend with the bass swapped at the middle, so two kicks and bass lines never stack." },
  "energy-boost": { label: "Energy Boost", bars: [8, 4], tempo: "sync", maxGap: 0.08, tolerance: 0.08, harmony: 0.6, energy: "rise",
    summary: "The new track comes in early at full level behind an opening high pass, for a lift in energy." },
  "eq-transition": { label: "EQ Transition", bars: [8, 4], tempo: "sync", maxGap: 0.08, tolerance: 0.08, harmony: 0.5, energy: "any",
    summary: "A bass swap and a filter swap: the old track thins out under a rising high pass while the new one opens from a low pass, which hides the mids." },
  "quick-cut": { label: "Quick Cut", bars: [2, 1], tempo: "grid", maxGap: 0.08, tolerance: 0.12, harmony: 0.25, energy: "any",
    summary: "A 1 or 2-bar change on a bar line, with an echo out when the tempo or keys would show." },
  fallback: { label: "Smart Fallback", bars: [8, 4, 2, 1], tempo: "none", maxGap: 0.08, tolerance: 0.08, harmony: 0.25, energy: "any",
    summary: "A plain crossfade that does not lean on the beat grid, for when the analysis cannot back anything bolder." },
};

/** Beat strength (the analysis pulse) under which a beat grid is too weak to hold a long locked overlap. */
export const WEAK_PULSE = 4;
/** A side carries bass when its low band over the overlap is within this many dB of its median; it sings when the vocals
    stem is up for more than this share of the overlap. */
const BASS_FLOOR = -6, VOCALS_SHARE = 0.3;
/** Tempo change at which an unsynced plan's tempo score reaches 0: the jump is heard at the cut, not stretched. */
const UNSYNCED_TOLERANCE = 0.3;
/** Share of a transition's length both sides play near full level, by volume curve; other curves are measured. */
const OVERLAP_SHARE: Partial<Record<VolumeCurve, number>> = { smooth: 0.5, overlap: 0.75, fade: 0.2 };
const shareOf = (shape: Pick<Shape, "volume" | "curve" | "eqAt">) => OVERLAP_SHARE[shape.volume] ?? overlapShare(shape);

/* ── what the planner knows about a pair ─────────────────────────────────────────────────────────────────────────── */

export type Pair = {
  from: Track; to: Track;
  /** Tempo change the incoming track needs, half and double time folded; null without a tempo on both. */
  gap: number | null;
  relation: Harmony;
  /** How far the keys can be trusted, 0..1: their clarity against 0.1, 0.5 for a key stored without a clarity. */
  keyTrust: number;
  /** The weaker of the two beat strengths, when both tracks have a tempo and a stored pulse. */
  pulse: number | null;
  /** The weaker of the two beat tracker's tempo confidences, 0..1, when both tracks have a tempo and beats tracked. */
  beats: number | null;
  /** The beat tracker found only a weak pulse on a track: some beats, not enough to lock a long overlap on. */
  weakGrid: boolean;
  stems: boolean;
};

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const round = (v: number, places = 0) => Math.round(v * 10 ** places) / 10 ** places;
export const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** The tracks a tempo match cannot lean on: no tempo at all, or one the beats prove moves (never stretched to a constant rate). */
const noTempo = (pair: Pair) => [pair.from, pair.to].filter(t => !gridBpm(t)).map(t => t.bpm ? `${t.title} (its tempo moves)` : t.title).join(" and ");

function keyTrustOf(from: Track, to: Track) {
  if (harmony(from.camelot, to.camelot) === "unknown") return 0;
  if (from.keyClarity === undefined || to.keyClarity === undefined) return 0.5;
  return clamp01(Math.min(from.keyClarity, to.keyClarity) / 0.1);
}

export function pairOf(from: Track, to: Track): Pair {
  const tracked = (t: Track) => t.bpm && t.rhythm && t.rhythm.grid !== "none" ? t.rhythm : null;
  const a = tracked(from), b = tracked(to);
  return {
    from, to, gap: tempoGap(from, to), relation: harmony(from.camelot, to.camelot), keyTrust: keyTrustOf(from, to),
    pulse: from.bpm && to.bpm && from.pulse !== undefined && to.pulse !== undefined ? Math.min(from.pulse, to.pulse) : null,
    beats: a && b ? Math.min(a.tempo.confidence, b.tempo.confidence) : null,
    weakGrid: from.rhythm?.grid === "weak" || to.rhythm?.grid === "weak",
    stems: !!from.stemEnergy?.length && !!to.stemEnergy?.length,
  };
}

/** How far a beat grid can be trusted, 0..1: from the pulse, 0.4 for a weak one up to 1 for a strong one (0.6 when it was
    not stored); with the beat tracker's confidence for the pair too, the mean of the two. 0 without a tempo. */
function gridTrust(pair: Pair) {
  if (pair.gap === null) return 0;
  const pulse = pair.pulse === null ? 0.6 : 0.4 + 0.6 * clamp01((pair.pulse - 3) / 5);
  return pair.beats === null ? pulse : (pulse + 0.3 + 0.7 * pair.beats) / 2;
}

/** How far a track's bars and phrases can be trusted, 0..1: a downbeat the tracker had cues for, and a phrase grid or
    section changes the structure analysis found evidence of. 0 without a usable beat grid. */
function barsTrust(t: Track) {
  const r = t.rhythm, s = t.structure;
  if (!r || (r.grid !== "steady" && r.grid !== "variable")) return 0;
  const downbeat = r.downbeat.assumed ? 0.3 : 0.5 + 0.5 * clamp01(r.downbeat.confidence);
  const phrases = s ? Math.max(s.phrases[0]?.confidence ?? 0, 0.6 * s.confidence) : 0;
  return 0.5 * downbeat + 0.5 * phrases;
}

/* ── options ─────────────────────────────────────────────────────────────────────────────────────────────────────── */

export type Criterion = "tempo" | "harmony" | "energy" | "structure" | "bass" | "vocals" | "grid" | "fit" | "continuity";
export const CRITERIA: Criterion[] = ["tempo", "harmony", "energy", "structure", "bass", "vocals", "grid", "fit", "continuity"];
export type PlannerWeights = Record<Criterion, number>;
/** The default weights. fit reads only the durations; continuity is a stated preference for long beat-matched blends
    over cuts, the one criterion that is a taste rather than a measurement, and it can be weighted down to zero. */
export const DEFAULT_WEIGHTS: PlannerWeights = {
  tempo: 0.14, harmony: 0.16, energy: 0.12, structure: 0.14, bass: 0.08, vocals: 0.04, grid: 0.1, fit: 0.1, continuity: 0.12,
};
/** The criteria read from the analysis, the ones the confidence covers. */
const ANALYSIS_CRITERIA: Criterion[] = ["tempo", "grid", "harmony", "energy", "structure", "bass", "vocals"];

export type TempoMatching = "standard" | "gentle" | "off";
export type EnergyFlow = "auto" | "maintain" | "build" | "relax";
export type PlannerOptions = {
  weights?: Partial<PlannerWeights>;
  /** Under this score the planner takes Smart Fallback instead of its best candidate (auto strategy only). Default 45. */
  minScore?: number;
  /** Under this analysis confidence, 0..1, the planner takes Smart Fallback (auto strategy only). Default 0.3. */
  minConfidence?: number;
  /** Points the DJ placed, tried as out and in points beside the planner's own. */
  anchors?: { outAt?: number; inAt?: number };
  /** A strategy chosen by hand, or "auto". One the pair cannot support gives Smart Fallback, and the result says why. */
  strategy?: TransitionStrategy | "auto";
  /** A length chosen by hand, in bars of the outgoing track. */
  bars?: number;
  /** "standard": each strategy's own stretch limit. "gentle": synced plans stretch at most 4%. "off": the incoming track
      keeps its own tempo, so only Quick Cut and Smart Fallback can play. */
  tempo?: TempoMatching;
  /** Where the heard level should go: "auto" lets each strategy want its own, the others hold every strategy to level,
      a rise or a fall. */
  energy?: EnergyFlow;
};
const DEFAULTS = { minScore: 45, minConfidence: 0.3 };

/** The DJ's settings for Smart AutoMix, as the interface holds them: "auto" leaves the choice to the planner.
    volume, eq, effect and stems override what the planner's strategy picks; template is a whole transition shape the DJ
    saved from the transition editor, applied to every planned transition (its fields lose to the explicit overrides). */
export type SmartStyle = {
  strategy: TransitionStrategy | "auto"; bars: number | "auto"; tempo: TempoMatching; energy: EnergyFlow;
  volume?: Exclude<VolumeCurve, "custom"> | "auto"; eq?: TransitionEq | "auto"; effect?: TransitionEffect | "auto"; stems?: TransitionStems | "auto";
  intensity?: number;
  template?: TransitionShape | null;
  /** AutoMix asks the local AI model for each pair it is about to play. Does not change the planner's own plans. */
  ai?: boolean;
  /** AutoMix splits the tracks it is about to play into stems with Demucs, so stem moves can run. */
  autoStems?: boolean;
};
export const DEFAULT_SMART_STYLE: SmartStyle = { strategy: "auto", bars: "auto", tempo: "standard", energy: "auto", volume: "auto", eq: "auto", effect: "auto", stems: "auto", template: null, ai: false, autoStems: false };
export const styleOptions = (style: SmartStyle): PlannerOptions => ({
  strategy: style.strategy, bars: style.bars === "auto" ? undefined : style.bars, tempo: style.tempo, energy: style.energy,
});
/** A key for caching plans by style. */
export const styleKey = (s: SmartStyle) => `${s.strategy}/${s.bars}/${s.tempo}/${s.energy}/${s.volume ?? "auto"}/${s.eq ?? "auto"}/${s.effect ?? "auto"}/${s.stems ?? "auto"}/${s.intensity ?? 1}/${s.template ? JSON.stringify(s.template) : ""}`;
/** Whether a style changes anything about the planner's shapes. */
export const styleShapes = (s: SmartStyle) => !!s.template || [s.volume, s.eq, s.effect, s.stems].some(v => v && v !== "auto") || (s.intensity ?? 1) !== 1;

const EQ_WORD: Record<TransitionEq, string> = { none: "no eq move", bass: "a bass swap", gradual: "a gradual low cut" };
/**
 * The planner's result with the DJ's AutoMix style laid over its shape: the saved template first, then each explicit
 * override. Where the plan sits (out and in points, length, tempo sync) stays the planner's. A stem move needs stems on
 * both tracks; without them the bass part of it falls back to an eq bass swap. The plan is rated again as it now stands.
 */
export function withStyle(result: PlannerResult, from: Track, to: Track, style: SmartStyle): PlannerResult {
  if (!styleShapes(style)) return result;
  const base = result.plan, said: string[] = [];
  const next: TransitionPlan = { ...base };
  const t = style.template;
  if (t) {
    Object.assign(next, { volume: t.volume, eq: t.eq, effect: t.effect, curve: t.curve, eqAt: t.eqAt, intensity: t.intensity, echoBeats: t.echoBeats });
    if (t.stems !== undefined) next.stems = t.stems;
    said.push("Your saved transition template sets the curves, eq, effect and stems.");
  }
  if (style.volume && style.volume !== "auto") { next.volume = style.volume; next.curve = undefined; }
  if (style.eq && style.eq !== "auto") next.eq = style.eq;
  if (style.effect && style.effect !== "auto") next.effect = style.effect;
  if (style.stems && style.stems !== "auto") next.stems = style.stems;
  if (style.intensity !== undefined && style.intensity !== 1) next.intensity = style.intensity;
  const stemmed = !!from.stems && !!to.stems;
  if (movesStems(next.stems) && !stemmed) {
    if (swapsBassStem(next.stems) && next.eq === "none") next.eq = "bass";
    said.push("Stem moves need both tracks split into stems; until then the bass swaps on the eq.");
    next.stems = "none";
  }
  // A cut or a short blend has no room for a vocal handover's gap.
  if (handsVocals(next.stems) && next.bars < 4) next.stems = "none";
  if (!t) said.push(`Your AutoMix style sets ${[style.volume && style.volume !== "auto" ? `the ${style.volume} curve` : null,
    style.eq && style.eq !== "auto" ? EQ_WORD[style.eq] : null, style.effect && style.effect !== "auto" ? `the ${style.effect} effect` : null,
    style.stems && style.stems !== "auto" ? `stems: ${style.stems}` : null, (style.intensity ?? 1) !== 1 ? `effect intensity ${Math.round((style.intensity ?? 1) * 100)}%` : null]
    .filter(Boolean).join(", ") || "the shape"}.`);
  next.preset = presetOf(next);
  const evaluation = scorePlan(from, to, next, styleOptions(style));
  const notes = base.notes ?? [];
  const plan: TransitionPlan = { ...next, score: evaluation.score, confidence: evaluation.confidence, notes: [notes[0], ...said, ...notes.slice(1)].filter(Boolean) };
  return { ...result, plan, score: evaluation.score, selected: { ...result.selected, ...evaluation, plan } };
}

export function weightsOf(partial?: Partial<PlannerWeights>): PlannerWeights {
  const out = { ...DEFAULT_WEIGHTS };
  for (const k of CRITERIA) {
    const v = partial?.[k];
    if (v !== undefined) out[k] = Number.isFinite(v) && v > 0 ? v : 0;
  }
  return CRITERIA.some(k => out[k] > 0) ? out : { ...DEFAULT_WEIGHTS };
}

/* ── where a transition can sit ──────────────────────────────────────────────────────────────────────────────────── */

/** Whether a length fits: a blend takes at most a third of either track, so a short one keeps a body to play. */
const fits = (pair: Pair, bars: number) => spanOn(pair.from, bars) <= pair.from.duration / 3 && spanOn(pair.to, bars) <= pair.to.duration / 3;

export type OutPoint = "outro" | "earlier" | "latest" | "anchor";
export type InPoint = "main" | "intro" | "anchor";
const OUT_LABEL: Record<OutPoint, string> = { outro: "where its body ends", earlier: "8 bars before its body ends", latest: "the last bar that fits", anchor: "your out point" };
const IN_LABEL: Record<InPoint, string> = { main: "timed so its body arrives as the blend ends", intro: "from its first beat", anchor: "your in point" };

/** Out points worth trying: where the outro heuristic puts it, 8 bars before that (counted on the beat grid, not a
    detected phrase), the last bar that fits, and the DJ's own point when given. */
export function outPoints(track: Track, bars: number, anchor?: number): { at: number; kind: OutPoint }[] {
  const span = spanOn(track, bars), outro = outroStart(track, bars);
  const list: { at: number; kind: OutPoint }[] = [];
  if (anchor !== undefined) list.push({ at: anchor, kind: "anchor" });
  list.push({ at: outro, kind: "outro" });
  // Only on a beat grid: 8 bars means nothing in seconds, and before half the track it would cut the body short.
  const tempo = gridBpm(track);
  if (tempo && outro - 8 * barOf(track) >= track.duration / 2) list.push({ at: outro - 8 * barOf(track), kind: "earlier" });
  list.push({ at: snapToBar(track, Math.max(0, track.duration - span - 1), "floor"), kind: "latest" });
  return dedupe(list.filter(p => p.at >= 0 && p.at + span <= track.duration + 1e-6));
}

/** In points worth trying: the one that brings the incoming body in as the blend ends, its first beat (an intro mix),
    and the DJ's own point when given. */
export function inPoints(track: Track, bars: number, anchor?: number): { at: number; kind: InPoint }[] {
  const span = spanOn(track, bars);
  const list: { at: number; kind: InPoint }[] = [];
  if (anchor !== undefined) list.push({ at: anchor, kind: "anchor" });
  list.push({ at: mainEntry(track, bars), kind: "main" });
  list.push({ at: snapToBar(track, track.firstBeat ?? 0), kind: "intro" });
  return dedupe(list.filter(p => p.at >= 0 && p.at + span <= track.duration + 1e-6));
}

function dedupe<T extends { at: number }>(list: T[]) {
  return list.filter((p, i) => list.findIndex(q => Math.abs(q.at - p.at) < 0.05) === i);
}

/** What the analysis says about the stretch a transition covers. */
export type Overlap = {
  outSpan: number; inSpan: number;
  /** The lows of each side across the overlap, dB against their own median low band; null without bands. */
  bassOut: number | null; bassIn: number | null;
  /** Share of the overlap each side sings in; null without stems on both. */
  vocalsOut: number | null; vocalsIn: number | null;
  /** Change in heard level, dB, from the 8 s before the out point (outgoing) to the 8 s after the blend (incoming), each
      with the trim it gets on load. Null without a loudness series on both. */
  delta: number | null;
};

export function overlapOf(pair: Pair, outAt: number, inAt: number, bars: number): Overlap {
  const { from, to } = pair;
  const outSpan = spanOn(from, bars), inSpan = spanOn(to, bars);
  const before = meanDb(from.energy, Math.max(0, outAt - 8), Math.max(1, outAt));
  const after = meanDb(to.energy, inAt + inSpan, inAt + inSpan + 8);
  return {
    outSpan, inSpan,
    bassOut: bassOver(from, outAt, outAt + outSpan), bassIn: bassOver(to, inAt, inAt + inSpan),
    vocalsOut: pair.stems ? vocalsOver(from, outAt, outAt + outSpan) : null, vocalsIn: pair.stems ? vocalsOver(to, inAt, inAt + inSpan) : null,
    delta: before === null || after === null ? null : (after + autoTrim(to)) - (before + autoTrim(from)),
  };
}

/* ── what each strategy does over a given stretch ───────────────────────────────────────────────────────────────── */

export type Shape = { volume: VolumeCurve; curve?: CustomCurve; eqAt?: number; eq: TransitionEq; effect: TransitionEffect; stems: TransitionStems; sync: boolean; why: string[] };

const bothBass = (o: Overlap) => o.bassOut !== null && o.bassIn !== null && o.bassOut > BASS_FLOOR && o.bassIn > BASS_FLOOR;
const bothSing = (o: Overlap) => o.vocalsOut !== null && o.vocalsIn !== null && o.vocalsOut > VOCALS_SHARE && o.vocalsIn > VOCALS_SHARE;

/** The curves, eq, effect, stem move and tempo sync a strategy uses over a stretch. */
export function shapeOf(strategy: TransitionStrategy, pair: Pair, bars: number, o: Overlap, tempo: TempoMatching = "standard"): Shape {
  const why: string[] = [];
  // A vocal handover needs room: under 4 bars there is no gap to leave between the voices.
  const handover = bars >= 4 && bothSing(o);
  const stems: TransitionStems = handover ? "vocals" : "none";
  if (handover) why.push("Both tracks sing across the overlap, so the outgoing vocals leave early and the new ones come in late.");
  const gap = pair.gap === null ? null : Math.abs(pair.gap);
  const syncable = gap !== null && tempo !== "off";
  switch (strategy) {
    case "smooth-blend": {
      // The bass swaps only when both sides carry it; without a band analysis it swaps anyway, the safe side of a long overlap.
      const unknown = o.bassOut === null || o.bassIn === null;
      if (unknown) why.push("The low band is not analyzed, so the bass swaps at the middle as a precaution.");
      return { volume: "smooth", eq: unknown || bothBass(o) ? "bass" : "none", effect: "none", stems, sync: true, why };
    }
    case "beatmatch": return { volume: "smooth", eq: "bass", effect: "none", stems, sync: true, why };
    case "energy-boost": return { volume: "overlap", eq: "bass", effect: "rise", stems, sync: true, why };
    case "eq-transition": return { volume: "smooth", eq: "bass", effect: "swap", stems, sync: true, why };
    case "quick-cut": {
      // Past the stretch limit the incoming track would stay stretched after the cut, so it keeps its own tempo and an echo covers the change.
      const sync = syncable && gap! <= limitOf("quick-cut", tempo);
      const echo = !sync || pair.relation === "clash";
      if (!sync && gap !== null) why.push(tempo === "off" ? "Tempo matching is off, so the incoming track keeps its own tempo and the old one echoes out."
        : `The tempo moves ${pct(gap)}, so the incoming track keeps its own tempo and the old one echoes out.`);
      else if (echo) why.push("The keys clash, so the old track echoes out instead of overlapping.");
      return { volume: sync ? "overlap" : "fade", eq: "none", effect: echo ? "echo" : "none", stems: "none", sync, why };
    }
    case "fallback": {
      if (gap === null) {
        why.push(`No tempo estimate for ${noTempo(pair)}, so nothing is matched or placed on a bar: an equal-power crossfade of about ${Math.round(o.outSpan)} s.`);
        return { volume: "smooth", eq: "none", effect: "none", stems: "none", sync: false, why };
      }
      // Both tempos known but not to be leaned on: a short fade that barely overlaps.
      const sync = syncable && gap <= limitOf("fallback", tempo) && (pair.pulse === null || pair.pulse >= WEAK_PULSE);
      why.push(sync ? "A short fade with little overlap and a low pass on the old track, beat-matched."
        : "A short fade with little overlap; the incoming track keeps its own tempo and the old one echoes out.");
      return { volume: "fade", eq: "none", effect: sync ? "lowpass" : "echo", stems: "none", sync, why };
    }
  }
}

/** The stretch limit a strategy works to under a tempo-matching setting. */
const limitOf = (strategy: TransitionStrategy, tempo: TempoMatching) => tempo === "gentle" ? Math.min(0.04, STRATEGY[strategy].maxGap) : STRATEGY[strategy].maxGap;

/* ── scoring ─────────────────────────────────────────────────────────────────────────────────────────────────────── */

export type CriterionResult = {
  /** 0..1, or null when the analysis has no data for it ("missing") or the strategy does not use it ("n/a"). */
  value: number | null;
  /** The weight it carried in the score: the configured weight, scaled by the key's clarity for harmony; 0 when null. */
  weight: number;
  status: "ok" | "missing" | "n/a";
  note: string;
};
type Raw = { value: number | null; status: CriterionResult["status"]; note: string; scale: number; trust: number };
const ok = (value: number, note: string, trust = 1, scale = 1): Raw => ({ value: clamp01(value), status: "ok", note, scale, trust });
const missing = (note: string): Raw => ({ value: null, status: "missing", note, scale: 0, trust: 0 });
const na = (note: string): Raw => ({ value: null, status: "n/a", note, scale: 0, trust: 0 });

export type Evaluation = {
  strategy: TransitionStrategy; label: string;
  /** 0..100: the weighted mean of the criteria that have data. */
  score: number;
  /** 0..1: how far the analysis behind this score can be trusted. It never changes the score. */
  confidence: number;
  criteria: Record<Criterion, CriterionResult>;
  /** Hard limits the plan breaks. A planner candidate with any is not chosen; a plan the DJ made is still played. */
  rejected: string[];
};

type Placed = { bars: number; outAt: number; inAt: number; overlap: Overlap; shape: Shape };
type Context = { pair: Pair; weights: PlannerWeights; tempo: TempoMatching; energy: EnergyFlow };

function tempoOf({ pair }: Context, spec: Spec, p: Placed): Raw {
  if (pair.gap === null) return spec.tempo === "none" ? na(`Not matched: no steady tempo for ${noTempo(pair)}, so nothing is stretched or placed on a bar.`) : missing(`No tempo estimate for ${noTempo(pair)}.`);
  const g = Math.abs(pair.gap), tolerance = p.shape.sync ? spec.tolerance : UNSYNCED_TOLERANCE;
  // A track read an octave from the other (64 into 128) is matched beat for every other beat, not stretched to twice its speed.
  const octave = foldMultiple(gridBpm(pair.from)!, gridBpm(pair.to)!) !== 1 ? " (half or double time, matched beat for every other beat)" : "";
  const bpm = `Tempo ${pair.from.bpm!.toFixed(1)} into ${pair.to.bpm!.toFixed(1)} bpm${octave}`;
  return ok(1 - Math.max(0, g - 0.01) / (tolerance - 0.01), p.shape.sync ? `${bpm}: the incoming deck stretches ${pct(g)}.`
    : `${bpm}: the incoming deck keeps its own tempo, a ${pct(g)} change at the cut.`, gridTrust(pair));
}

function gridOf({ pair }: Context, p: Placed): Raw {
  if (!p.shape.sync) return na("Not beat-matched, so the beat grid does not have to hold.");
  if (pair.gap === null) return missing("No beat grid without a tempo.");
  if (pair.pulse === null && pair.beats === null) return missing("Beat strength is not stored in this analysis.");
  // The weaker of the two readings of the grid: the pulse of the tempo estimate and the beat tracker's confidence.
  const r = Math.min(...[pair.pulse === null ? null : clamp01((pair.pulse - 3) / 4), pair.beats].filter((v): v is number => v !== null));
  const need = Math.min(1, p.bars / 8);
  const read = [pair.pulse === null ? null : `Beat strength ${pair.pulse.toFixed(1)}`, pair.beats === null ? null : `beat tracking ${pct(pair.beats)} sure`].filter(Boolean).join(", ");
  return ok(1 - need * (1 - r), `${read} on the weaker track${r < 0.5 && need > 0.5 ? ", a loose grid for a long locked overlap" : ""}.`, gridTrust(pair));
}

function harmonyOf({ pair }: Context, strategy: TransitionStrategy): Raw {
  const { from, to, relation, keyTrust } = pair;
  if (relation === "unknown") return missing(`Keys: ${HARMONY_LABEL.unknown}.`);
  const base = relation === "same" ? 1 : relation === "relative" || relation === "adjacent" ? 0.9
    : relation === "boost" ? (strategy === "energy-boost" ? 1 : 0.7) : 0.1;
  const guess = keyTrust < 0.5 ? ", but the keys are a guess (clarity under 0.05), so they count for less" : "";
  return ok(1 - STRATEGY[strategy].harmony * (1 - base), `Keys ${from.key ?? from.camelot} (${from.camelot}) into ${to.key ?? to.camelot} (${to.camelot}): ${HARMONY_LABEL[relation]}${guess}.`, keyTrust, keyTrust);
}

function energyOf(ctx: Context, spec: Spec, p: Placed): Raw {
  const d = p.overlap.delta;
  if (d === null) return missing("No loudness series on both tracks, so the energy flow is unknown.");
  const target: EnergyTarget = ctx.energy === "maintain" ? "level" : ctx.energy === "build" ? "rise" : ctx.energy === "relax" ? "fall" : spec.energy;
  const value = target === "level" ? 1 - Math.max(0, Math.abs(d) - 1) / 4 : target === "rise" ? (d + 1) / 4
    : target === "fall" ? (1 - d) / 4 : 1 - Math.max(0, Math.abs(d) - 3) / 9;
  const move = Math.abs(d) < 1 ? `stays level (${d >= 0 ? "+" : ""}${d.toFixed(1)} dB)` : `${d > 0 ? "rises" : "falls"} ${Math.abs(d).toFixed(1)} dB`;
  return ok(value, `Heard level ${move} from the 8 s before the out point to the 8 s after the blend, with load trims.`);
}

/** Change in level across a time, dB: the 4 s after against the 4 s before. */
function levelStep(series: number[] | undefined, at: number) {
  const before = meanDb(series, Math.max(0, at - 4), at), after = meanDb(series, at, at + 4);
  return before === null || after === null || at < 4 ? null : after - before;
}

function structureOf({ pair }: Context, p: Placed): Raw {
  const { from, to } = pair;
  const parts: number[] = [], said: string[] = [];
  if (from.energy?.length && bodyEnd(from) !== null) {
    const off = Math.abs(p.outAt - outroStart(from, p.bars)) / barOf(from), step = levelStep(from.energy, p.outAt);
    parts.push(Math.min(1, clamp01(1 - off / 16) + (step !== null && Math.abs(step) >= 3 ? 0.2 : 0)));
    said.push(`out ${off < 0.5 ? "where the outgoing body ends" : `${off.toFixed(0)} bars from where the outgoing body ends`}${step !== null && Math.abs(step) >= 3 ? `, on a ${Math.abs(step).toFixed(1)} dB level step` : ""}`);
  }
  const main = mainStart(to);
  if (to.energy?.length && main !== null) {
    const off = Math.abs(p.inAt + p.overlap.inSpan - main) / barOf(to);
    parts.push(clamp01(1 - off / 16));
    said.push(off < 0.5 ? "the incoming body arrives as the blend ends" : `the incoming body arrives ${off.toFixed(0)} bars ${p.inAt + p.overlap.inSpan < main ? "after" : "before"} the blend ends`);
  }
  if (!parts.length) return missing("No loudness series to read either track's structure from.");
  const note = `By the loudness heuristic (body = within 1.5 dB of the median level): ${said.join("; ")}.`;
  return ok(parts.reduce((a, b) => a + b, 0) / parts.length, note, parts.length === 2 ? 0.7 : 0.35);
}

function bassOf(_: Context, p: Placed): Raw {
  const { bassOut, bassIn } = p.overlap;
  if (bassOut === null || bassIn === null) return missing("The low band is not analyzed on both tracks.");
  const levels = `${bassOut.toFixed(1)} and ${bassIn.toFixed(1)} dB against their medians`;
  if (!bothBass(p.overlap)) return ok(1, `One side has little bass in the overlap (${levels}), so the lows can cross.`);
  if (p.shape.eq === "bass") return ok(1, `Both carry bass through the overlap (${levels}), so the lows swap at the middle.`);
  if (swapsBassStem(p.shape.stems)) return ok(1, `Both carry bass through the overlap (${levels}), so the bass stems swap.`);
  if (p.shape.eq === "gradual") return ok(0.85, `Both carry bass through the overlap (${levels}); the lows ease across, so a little of them stacks.`);
  const stacked = p.bars * shareOf(p.shape);
  return ok(1 - stacked / 4, `Both carry bass (${levels}) and nothing swaps it: about ${stacked.toFixed(1)} bars of stacked low end.`);
}

function vocalsOf({ pair }: Context, p: Placed): Raw {
  if (!pair.stems) return na("No stems on both tracks, so vocal overlap is not measured.");
  const { vocalsOut, vocalsIn } = p.overlap;
  if (vocalsOut === null || vocalsIn === null) return missing("No vocal levels for the overlap.");
  if (!bothSing(p.overlap)) return ok(1, "At most one side sings across the overlap.");
  if (handsVocals(p.shape.stems)) return ok(1, "Both sing across the overlap, and the vocals hand over.");
  if (p.shape.stems === "acapella") return ok(1, "Both sing across the overlap; the incoming vocals wait until the old acapella is done.");
  const stacked = p.bars * shareOf(p.shape);
  return ok(1 - stacked / 4, `Both sing across the overlap (${pct(vocalsOut)} and ${pct(vocalsIn)} of it): about ${stacked.toFixed(1)} bars of two voices.`);
}

function fitOf({ pair }: Context, p: Placed): Raw {
  const { from, to } = pair;
  if (from.duration <= 0 || to.duration <= 0) return ok(0, "A track length is unknown.");
  const share = Math.max(p.overlap.outSpan / from.duration, p.overlap.inSpan / to.duration);
  const tail = Math.max(0, from.duration - p.outAt - p.overlap.outSpan), head = p.inAt;
  const value = ((share <= 1 / 3 ? 1 : clamp01(1 - (share - 1 / 3) * 6))
    + clamp01(1 - tail / from.duration / 0.4) + clamp01(1 - Math.max(0, head / to.duration - 0.15) / 0.35)) / 3;
  return ok(value, `${p.overlap.outSpan.toFixed(1)} s long (${pct(share)} of the shorter fit); ${tail.toFixed(0)} s of the old track left unplayed, ${head.toFixed(0)} s of the new one skipped.`);
}

function continuityOf(_: Context, p: Placed): Raw {
  if (!p.shape.sync) return ok(0, "Not beat-matched, so the change is a seam rather than a blend.");
  const value = Math.min(1, Math.log2(Math.max(1, p.bars)) / 4) * (p.shape.effect === "none" ? 1 : 0.85);
  return ok(value, `${plural(p.bars, "beat-matched bar")}${p.shape.effect === "none" ? "" : " under an effect"}.`);
}

/** Hard limits a placed plan breaks for a strategy. Smart Fallback has none: it always plays. */
function rejectionsOf(ctx: Context, strategy: TransitionStrategy, p: Placed): string[] {
  if (strategy === "fallback") return [];
  const { pair } = ctx, spec = STRATEGY[strategy], out: string[] = [];
  if (pair.gap === null) out.push(`${spec.label} needs a tempo estimate on both tracks, and ${noTempo(pair)} has none.`);
  else if (p.shape.sync && ctx.tempo === "off") out.push(`${spec.label} matches tempo, and tempo matching is off.`);
  else if (p.shape.sync && Math.abs(pair.gap) > limitOf(strategy, ctx.tempo) + 1e-9) {
    out.push(`The tempo moves ${pct(Math.abs(pair.gap))}, over the ${pct(limitOf(strategy, ctx.tempo))} ${spec.label} stretches${ctx.tempo === "gentle" ? " with gentle tempo matching" : ""}.`);
  }
  if (p.shape.sync && pair.pulse !== null && pair.pulse < WEAK_PULSE && p.bars >= 8) {
    out.push(`Beat strength ${pair.pulse.toFixed(1)} is under ${WEAK_PULSE}, too loose a grid to hold ${p.bars} locked bars.`);
  } else if (p.shape.sync && pair.weakGrid && p.bars >= 8) {
    out.push(`The beat tracker found only a weak pulse on one track, too loose a grid to hold ${p.bars} locked bars.`);
  }
  if (strategy === "smooth-blend") {
    const together = pair.relation === "same" || pair.relation === "adjacent" || pair.relation === "relative";
    if (pair.relation === "unknown") out.push("Smooth Blend needs keys known to sit together, and the keys are not analyzed.");
    else if (!together) out.push(`Smooth Blend needs keys that sit together, and these are ${HARMONY_LABEL[pair.relation]}.`);
    else if (pair.keyTrust < 0.5) out.push("Smooth Blend needs keys known to sit together, and these keys are a guess (clarity under 0.05).");
  }
  if (strategy === "energy-boost") {
    const d = p.overlap.delta, keyBoost = pair.relation === "boost" && pair.keyTrust >= 0.5;
    if (!keyBoost && (d === null || d < 1)) out.push(d === null
      ? "Energy Boost needs a measured rise in level or a boost move on the Camelot wheel, and neither is analyzed."
      : `Energy Boost needs a rise in heard level or a boost move on the Camelot wheel, and the level ${d >= 0 ? "rises only" : "falls"} ${Math.abs(d).toFixed(1)} dB.`);
  }
  const { from, to } = pair;
  if (p.outAt < 0 || p.inAt < 0 || p.outAt + p.overlap.outSpan > from.duration + 0.01 || p.inAt + p.overlap.inSpan > to.duration + 0.01) {
    out.push("The transition runs past the start or end of a track.");
  } else if (p.overlap.outSpan > from.duration / 2 || p.overlap.inSpan > to.duration / 2) out.push("The transition takes more than half of a track.");
  return out;
}

function evaluate(ctx: Context, strategy: TransitionStrategy, p: Placed, extra: string[] = []): Evaluation {
  const spec = STRATEGY[strategy];
  const raw: Record<Criterion, Raw> = {
    tempo: tempoOf(ctx, spec, p), harmony: harmonyOf(ctx, strategy), energy: energyOf(ctx, spec, p), structure: structureOf(ctx, p),
    bass: bassOf(ctx, p), vocals: vocalsOf(ctx, p), grid: gridOf(ctx, p), fit: fitOf(ctx, p), continuity: continuityOf(ctx, p),
  };
  let num = 0, den = 0, trusted = 0, covered = 0;
  const criteria = {} as Record<Criterion, CriterionResult>;
  for (const k of CRITERIA) {
    const r = raw[k], weight = r.value === null ? 0 : ctx.weights[k] * r.scale;
    criteria[k] = { value: r.value === null ? null : round(r.value, 3), weight: round(weight, 4), status: r.status, note: r.note };
    if (r.value !== null && weight > 0) { num += weight * r.value; den += weight; }
    if (ANALYSIS_CRITERIA.includes(k) && r.status !== "n/a") { trusted += ctx.weights[k] * r.trust; covered += ctx.weights[k]; }
  }
  return {
    strategy, label: spec.label, score: den > 0 ? round(100 * num / den, 1) : 0, confidence: covered > 0 ? round(trusted / covered, 2) : 0,
    criteria, rejected: [...extra, ...rejectionsOf(ctx, strategy, p)],
  };
}

/* ── how sure the analysis is ────────────────────────────────────────────────────────────────────────────────────── */

export type AnalysisConfidence = { value: number; level: "high" | "medium" | "low"; factors: { name: string; value: number; weight: number; note: string }[] };

/** How far the analysis of a pair can be trusted, 0..1, from what each track's analysis holds and how strong it is. */
export function analysisConfidence(pair: Pair): AnalysisConfidence {
  const { from, to } = pair;
  const both = (has: (t: Track) => boolean) => (has(from) ? 0.5 : 0) + (has(to) ? 0.5 : 0);
  const pulses = from.pulse !== undefined && to.pulse !== undefined ? `, beat strength ${from.pulse.toFixed(1)} and ${to.pulse.toFixed(1)}` : ", beat strength not stored";
  // Bars and phrases count once either track has a beat tracker result; tracks stored before it keep the original five factors.
  const phrased = !!(from.rhythm || to.rhythm);
  const factors = [
    { name: "Tempo and beat grid", weight: 0.35, value: gridTrust(pair),
      note: pair.gap === null ? `No tempo estimate for ${noTempo(pair)}.` : `${from.bpm!.toFixed(1)} and ${to.bpm!.toFixed(1)} bpm${pulses}.` },
    { name: "Key", weight: 0.2, value: pair.keyTrust,
      note: pair.relation === "unknown" ? "No key on one or both tracks." : from.keyClarity !== undefined && to.keyClarity !== undefined
        ? `Key clarity ${from.keyClarity.toFixed(2)} and ${to.keyClarity.toFixed(2)} (0.1 and up is clear).` : "Keys stored without a clarity." },
    { name: "Loudness over time", weight: 0.2, value: both(t => !!t.energy?.length), note: "Per-second loudness, for energy flow and structure." },
    { name: "Low band", weight: 0.15, value: both(t => !!t.bands?.low.length), note: "Per-second low band, for the bass swap." },
    ...(phrased ? [{ name: "Bars and phrases", weight: 0.15, value: (barsTrust(from) + barsTrust(to)) / 2,
      note: `Downbeats and phrase grid: ${pct(barsTrust(from))} and ${pct(barsTrust(to))} sure.` }] : []),
    { name: "Analysis version", weight: 0.1, value: both(t => (t.analysis ?? 0) >= ANALYSIS_VERSION), note: `Analysis ${from.analysis ?? "unknown"} and ${to.analysis ?? "unknown"}; current is ${ANALYSIS_VERSION}.` },
  ].map(f => ({ ...f, value: round(f.value, 2) }));
  const total = factors.reduce((sum, f) => sum + f.weight, 0);
  const value = round(factors.reduce((sum, f) => sum + f.weight * f.value, 0) / total, 2);
  return { value, level: value >= 0.7 ? "high" : value >= 0.4 ? "medium" : "low", factors };
}

/* ── candidates ──────────────────────────────────────────────────────────────────────────────────────────────────── */

export type Candidate = Evaluation & {
  id: string; bars: number; outAt: number; inAt: number; out: OutPoint; in: InPoint;
  eligible: boolean; plan: TransitionPlan;
};

/** Lengths a strategy can use on a pair: its own, or the one chosen by hand, that fit. Smart Fallback keeps only the
    longest that fits, and one bar when none does, so it can always play. */
function lengthsFor(strategy: TransitionStrategy, pair: Pair, forced?: number): number[] {
  // Without a tempo on both, Smart Fallback's lengths are nominal 120 bpm bars: 16, 8, 4 or 2 s.
  const own = strategy === "fallback" && pair.gap !== null ? [4, 2, 1] : STRATEGY[strategy].bars;
  if (strategy === "fallback") return [[...(forced ? [forced] : []), ...own].find(n => fits(pair, n)) ?? 1];
  return (forced ? [forced] : own).filter(n => fits(pair, n));
}

function candidatesOf(ctx: Context, options: PlannerOptions): Candidate[] {
  const { pair } = ctx, out: Candidate[] = [];
  const add = (strategy: TransitionStrategy, bars: number, o: { at: number; kind: OutPoint }, i: { at: number; kind: InPoint }, extra: string[] = []) => {
    const overlap = overlapOf(pair, o.at, i.at, bars);
    const placed: Placed = { bars, outAt: o.at, inAt: i.at, overlap, shape: shapeOf(strategy, pair, bars, overlap, ctx.tempo) };
    const evaluation = evaluate(ctx, strategy, placed, extra);
    const plan = planOf(pair, strategy, placed, evaluation);
    out.push({ ...evaluation, id: `${strategy}:${bars}:${o.kind}:${i.kind}`, bars, outAt: o.at, inAt: i.at, out: o.kind, in: i.kind, eligible: !evaluation.rejected.length, plan });
  };
  for (const strategy of STRATEGIES) {
    const lengths = lengthsFor(strategy, pair, options.bars);
    if (!lengths.length) {
      // Nothing fits: one candidate at the last possible point, carrying the reason.
      const bars = options.bars ?? STRATEGY[strategy].bars.at(-1)!;
      const shortest = Math.min(pair.from.duration, pair.to.duration);
      add(strategy, bars, { at: Math.max(0, pair.from.duration - spanOn(pair.from, bars)), kind: "latest" }, { at: 0, kind: "intro" },
        [`${plural(bars, "bar")} (${spanOn(pair.from, bars).toFixed(1)} s) do not fit within a third of a ${shortest.toFixed(1)} s track.`]);
      continue;
    }
    for (const bars of lengths) {
      const outs = outPoints(pair.from, bars, options.anchors?.outAt), ins = inPoints(pair.to, bars, options.anchors?.inAt);
      // A track too short for even its last bar still gets Smart Fallback, from its start.
      const o = outs.length ? outs : [{ at: Math.max(0, pair.from.duration - spanOn(pair.from, bars)), kind: "latest" as const }];
      const i = ins.length ? ins : [{ at: 0, kind: "intro" as const }];
      for (const a of o) for (const b of i) add(strategy, bars, a, b);
    }
  }
  return out;
}

/** The plan a candidate plays, in the shape mix() and the editor read. sync is written only when it is off, so a plan
    that matches tempo looks as plans always have. */
function planOf(pair: Pair, strategy: TransitionStrategy, p: Placed, e: Evaluation): TransitionPlan {
  return {
    fromId: pair.from.id, toId: pair.to.id, outAt: p.outAt, inAt: p.inAt, bars: p.bars,
    volume: p.shape.volume, eq: p.shape.eq, effect: p.shape.effect, stems: p.shape.stems, preset: "auto", by: "auto",
    strategy, score: e.score, confidence: e.confidence, ...(p.shape.sync ? {} : { sync: false }),
    notes: notesOf(e, p),
  };
}

/** One line per decision, for the editor: the headline, what the strategy does, then what each criterion read. */
function notesOf(e: Evaluation, p: Placed): string[] {
  const read = (["tempo", "harmony", "energy", "structure", "bass", "vocals"] as Criterion[]).filter(k => e.criteria[k].status === "ok").map(k => e.criteria[k].note);
  const unknown = CRITERIA.filter(k => e.criteria[k].status === "missing").map(k => k);
  return [
    `${e.label}: ${e.score.toFixed(0)}/100, analysis confidence ${(e.confidence * 100).toFixed(0)}%.`,
    STRATEGY[e.strategy].summary, ...p.shape.why, ...read,
    ...(unknown.length ? [`Not in the analysis, so left out of the score: ${unknown.join(", ")}.`] : []),
  ];
}

/** Playable first; among those Smart Fallback last, since rules choose it rather than its score; then by score. */
const order = (a: Candidate, b: Candidate) =>
  Number(b.eligible) - Number(a.eligible) || Number(a.strategy === "fallback") - Number(b.strategy === "fallback") || b.score - a.score || b.confidence - a.confidence
  || STRATEGIES.indexOf(a.strategy) - STRATEGIES.indexOf(b.strategy) || b.bars - a.bars || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/* ── choosing ────────────────────────────────────────────────────────────────────────────────────────────────────── */

export type PlannerResult = {
  /** The plan to play: the selected candidate's, with the reasons it was chosen at the top of its notes. */
  plan: TransitionPlan;
  selected: Candidate;
  /** The selected score, 0..100. */
  score: number;
  /** Every playable candidate, best first, then for each strategy with none its best rejected one, so the reason shows. */
  candidates: Candidate[];
  confidence: AnalysisConfidence;
  weights: PlannerWeights;
  /** Why the selected candidate won, one line each. */
  reasons: string[];
  /** Why Smart Fallback was taken over the best candidate, when it was. */
  fallback: string | null;
};

export function planTransition(from: Track, to: Track, options: PlannerOptions = {}): PlannerResult {
  const pair = pairOf(from, to), weights = weightsOf(options.weights);
  const ctx: Context = { pair, weights, tempo: options.tempo ?? "standard", energy: options.energy ?? "auto" };
  const forced = options.strategy && options.strategy !== "auto" ? options.strategy : null;
  const all = candidatesOf(ctx, options).sort(order);
  const confidence = analysisConfidence(pair);

  const pool = all.filter(c => c.eligible && c.strategy !== "fallback" && (!forced || c.strategy === forced));
  const minScore = options.minScore ?? DEFAULTS.minScore, minConfidence = options.minConfidence ?? DEFAULTS.minConfidence;
  const reasons: string[] = [];
  let fallback: string | null = null;
  if (forced === "fallback") reasons.push("Smart Fallback was chosen by hand.");
  else if (!pool.length) {
    fallback = forced ? `${STRATEGY[forced].label} was chosen, but it cannot play this pair.` : "No other strategy can play this pair.";
    for (const s of STRATEGIES) {
      if (s === "fallback" || (forced && s !== forced)) continue;
      const best = all.find(c => c.strategy === s);
      if (best?.rejected.length) reasons.push(`${STRATEGY[s].label}: ${best.rejected[0]}`);
    }
  } else if (!forced && pool[0].score < minScore) {
    fallback = `The best candidate, ${pool[0].label} at ${pool[0].score.toFixed(0)}/100, is under the ${minScore} minimum.`;
  } else if (!forced && confidence.value < minConfidence) {
    fallback = `Analysis confidence ${(confidence.value * 100).toFixed(0)}% is under the ${(minConfidence * 100).toFixed(0)}% minimum, too little to lean on ${pool[0].label}.`;
  }
  const selected = forced === "fallback" || fallback ? all.find(c => c.strategy === "fallback") ?? all[0] : pool[0];
  if (!fallback && forced !== "fallback") {
    const playable = all.filter(c => c.eligible).length;
    reasons.push(forced ? `${selected.label} was chosen by hand; this is its best placement of ${pool.length}.`
      : `Best of ${playable} playable candidates.`);
    const next = all.find(c => c.eligible && c.strategy !== selected.strategy && c.strategy !== "fallback");
    if (next && !forced) reasons.push(`Next best: ${next.label} at ${next.score.toFixed(0)}/100.`);
  }
  reasons.push(`Out at ${formatTime(selected.outAt)} (${OUT_LABEL[selected.out]}), in at ${formatTime(selected.inAt)} (${IN_LABEL[selected.in]}).`);

  const notes = selected.plan.notes ?? [];
  const plan: TransitionPlan = { ...selected.plan, notes: [notes[0], ...(fallback ? [fallback] : []), ...reasons, ...notes.slice(1)] };
  // Every playable candidate, then the best rejected one of each strategy that has nothing playable.
  const shown = all.filter(c => c.eligible);
  for (const s of STRATEGIES) if (!shown.some(c => c.strategy === s)) { const best = all.find(c => c.strategy === s); if (best) shown.push(best); }
  return { plan, selected, score: selected.score, candidates: shown, confidence, weights, reasons, fallback };
}

/** Which strategy a plan made elsewhere (by hand, by the AI, or before the planner) reads as. */
export function strategyOf(plan: Pick<TransitionPlan, "strategy" | "bars" | "volume" | "effect" | "sync">, pair: Pair): TransitionStrategy {
  if (plan.strategy) return plan.strategy;
  if (pair.gap === null) return "fallback";
  if (plan.bars <= 2) return "quick-cut";
  if (plan.effect === "rise" || plan.volume === "overlap") return "energy-boost";
  if (plan.effect !== "none") return "eq-transition";
  return plan.bars >= 16 ? "smooth-blend" : "beatmatch";
}

/** Rates any plan for a pair, such as one with points the DJ dragged, against the same criteria as the planner's own
    candidates. Its rejected list reads as warnings: the DJ's plan still plays as it is. */
export function scorePlan(from: Track, to: Track, plan: TransitionPlan, options: Pick<PlannerOptions, "weights" | "tempo" | "energy"> = {}): Evaluation {
  const pair = pairOf(from, to);
  const ctx: Context = { pair, weights: weightsOf(options.weights), tempo: options.tempo ?? "standard", energy: options.energy ?? "auto" };
  const overlap = overlapOf(pair, plan.outAt, plan.inAt, plan.bars);
  const shape: Shape = { volume: plan.volume, curve: plan.curve, eqAt: plan.eqAt, eq: plan.eq, effect: plan.effect, stems: plan.stems ?? "none", sync: plan.sync !== false && pair.gap !== null && ctx.tempo !== "off", why: [] };
  return evaluate(ctx, strategyOf(plan, pair), { bars: plan.bars, outAt: plan.outAt, inAt: plan.inAt, overlap, shape });
}
