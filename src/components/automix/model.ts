import { harmony, planRatio, spanOn, tempoGap, type Harmony } from "@/lib/transition";
import { EFFECT_OPTIONS, EQ_OPTIONS, STEM_OPTIONS, VOLUME_OPTIONS } from "@/lib/transition-options";
import type { AutoPhase, AutoSnapshot } from "@/lib/automix";
import type { StatusValue } from "@/components/sodium/ui/status";
import type { EnergyFlow, TempoMatching as TempoMatch } from "@/lib/transition-planner";
import type { DeckId, PlayQueue, QueueItem, Track, TransitionPlan, TransitionStrategy } from "@/lib/types";

/* What the AutoMix panel reads, and the pure functions that turn the engine's state into what it shows. The panel never
   decides anything: phases, the queue, the plan and its score come from the Auto DJ engine (use-dj, lib/automix) and the
   transition planner (lib/planner); this file only names and formats them. */

export type { AutoPhase };

/** The engine's AutoMix snapshot (dj.auto): the panel reads exactly what the controller publishes. */
export type AutoView = AutoSnapshot;
/** The engine's queue edits (dj.queue). */
export type QueueActions = {
  add: (trackIds: string[], where?: "end" | "next" | number) => void;
  remove: (uid: string) => void;
  move: (uid: string, delta: number) => void;
  playNext: (uid: string) => void;
  /** Mixes into a queued entry now, whatever its place in the queue. */
  jumpTo?: (uid: string) => void;
  clear: () => void;
  setLoop: (on: boolean) => void;
  setSmart: (on: boolean) => void;
  retryFailed: () => void;
};
/** The engine's AutoMix controls (dj.auto). */
export type AutoControls = { start: () => void; enable: () => void; stop: () => void; pause: () => void; resume: () => void; skip: () => void };

/** The planner's rating of the plan that will play (dj.planScore), as far as the panel reads it. */
export type CriterionView = { value: number | null; status: "ok" | "missing" | "n/a"; note: string };
export type ScoreView = { score: number; confidence: number; criteria: Partial<Record<"tempo" | "harmony" | "energy", CriterionView>> };

/** The planner's style override (dj.smartStyle): strategy, length in bars, tempo matching and energy flow. */
export type { EnergyFlow, SmartStyle, TempoMatching as TempoMatch } from "@/lib/transition-planner";

/** Each phase as a Sodium status: colour only for an outcome (ready, recovering, error), a running mark while mixing. */
export const PHASE: Record<AutoPhase | "off", { status: StatusValue; label: string }> = {
  off: { status: "idle", label: "Off" },
  idle: { status: "idle", label: "Idle" },
  analyzing: { status: "queued", label: "Analyzing" },
  preparing: { status: "queued", label: "Preparing" },
  ready: { status: "ok", label: "Ready" },
  mixing: { status: "running", label: "Mixing" },
  recovering: { status: "warn", label: "Recovering" },
  paused: { status: "paused", label: "Paused" },
  error: { status: "fail", label: "Error" },
};
/** What the panel calls the engine's phase. The engine reports enabled false in error too, and an error must still show. */
export const phaseOf = (auto: Pick<AutoView, "enabled" | "phase">): AutoPhase | "off" =>
  auto.phase === "error" ? "error" : auto.enabled ? auto.phase : "off";

/** Transition styles, in the planner's strategy names. */
export const STYLES: { value: TransitionStrategy | "auto"; label: string }[] = [
  { value: "auto", label: "Auto" }, { value: "smooth-blend", label: "Smooth" }, { value: "beatmatch", label: "Beatmatch" },
  { value: "energy-boost", label: "Energy" }, { value: "eq-transition", label: "EQ" }, { value: "quick-cut", label: "Quick cut" },
];
/** Transition lengths in beats; the planner counts bars of the outgoing track, four beats each. */
export const DURATIONS: { value: string; label: string; bars: number | "auto" }[] = [
  { value: "auto", label: "Auto", bars: "auto" }, { value: "4", label: "4", bars: 1 }, { value: "8", label: "8", bars: 2 },
  { value: "16", label: "16", bars: 4 }, { value: "32", label: "32", bars: 8 },
];
export const durationValue = (bars: number | "auto") => bars === "auto" ? "auto" : String(bars * 4);
export const TEMPO: { value: TempoMatch; label: string }[] = [{ value: "off", label: "Off" }, { value: "gentle", label: "Gentle" }, { value: "standard", label: "Standard" }];
/** The shape overrides the AutoMix settings offer: "auto" leaves each to the planner's strategy. */
export const AUTO_VOLUME = [{ value: "auto", label: "Auto" }, ...VOLUME_OPTIONS.filter(o => o.value !== "custom")];
export const AUTO_EQ = [{ value: "auto", label: "Auto" }, ...EQ_OPTIONS];
export const AUTO_EFFECT = [{ value: "auto", label: "Auto" }, ...EFFECT_OPTIONS];
export const AUTO_STEMS = [{ value: "auto", label: "Auto" }, ...STEM_OPTIONS];
export const ENERGY: { value: EnergyFlow; label: string }[] = [{ value: "auto", label: "Auto" }, { value: "maintain", label: "Maintain" }, { value: "build", label: "Build" }, { value: "relax", label: "Relax" }];

export const STRATEGY_LABEL: Record<TransitionStrategy, string> = {
  "smooth-blend": "Smooth blend", beatmatch: "Beatmatch", "energy-boost": "Energy boost", "eq-transition": "EQ transition",
  "quick-cut": "Quick cut", fallback: "Smart fallback",
};
export const HARMONY_SHORT: Record<Harmony, string> = {
  same: "Same key", adjacent: "Adjacent", relative: "Relative", boost: "Energy boost", clash: "Clash", unknown: "Unknown",
};
const EFFECT_LABEL: Record<TransitionPlan["effect"], string | null> = {
  none: null, lowpass: "low pass", rise: "high pass in", hpout: "high pass out", lpin: "low pass in", echo: "echo out", dub: "dub echo",
  reverb: "reverb wash", flanger: "flanger", swap: "filter swap",
};
const STEM_LABEL: Record<NonNullable<TransitionPlan["stems"]>, string | null> = {
  none: null, vocals: "vocal handover", bass: "bass stem swap", drums: "drums first", acapella: "acapella over", full: "stem blend",
};

/** A deck as the panel needs it: which track and at what rate. Position is read from the media clock, never from here. */
export type DeckLite = { trackId: string | null; rate: number; playing: boolean };

/** One side of the pair: the track, its deck and its tempo as heard. */
export type Side = { track: Track; deck: DeckId | null; bpm: number | null };

/** The pair the next transition runs between, the tempo and key relation, and how long it takes. */
export type PairView = {
  from: Side | null; to: Side | null;
  /** Tempo change the incoming track needs, as a fraction, half and double time folded. Null without both tempos. */
  gap: number | null;
  relation: Harmony;
  /** Seconds the transition takes on the outgoing deck, at its rate, and its length in beats. */
  seconds: number | null; beats: number | null;
  /** The transition's name: its strategy, then its effect and whether the bass swaps. */
  type: string | null;
  bassSwap: boolean;
};

const deckHolding = (decks: Record<DeckId, DeckLite>, trackId: string | undefined): DeckId | null =>
  !trackId ? null : decks.A.trackId === trackId ? "A" : decks.B.trackId === trackId ? "B" : null;

/** Everything the pair readout shows, from the plan the engine will run and the tracks it names. */
export function pairView(plan: TransitionPlan | null, tracks: ReadonlyMap<string, Track>, decks: Record<DeckId, DeckLite>, live: DeckId, nextTrackId: string | null): PairView {
  const fromTrack = plan ? tracks.get(plan.fromId) : tracks.get(decks[live].trackId ?? "");
  const toTrack = plan ? tracks.get(plan.toId) : nextTrackId ? tracks.get(nextTrackId) : undefined;
  const side = (track: Track | undefined): Side | null => {
    if (!track) return null;
    const deck = deckHolding(decks, track.id);
    return { track, deck, bpm: track.bpm ? track.bpm * (deck ? decks[deck].rate : 1) : null };
  };
  const from = side(fromTrack), to = side(toTrack);
  const fromRate = from?.deck ? decks[from.deck].rate : 1;
  const seconds = plan && fromTrack ? spanOn(fromTrack, plan.bars) / (fromRate || 1) : null;
  const effect = plan ? EFFECT_LABEL[plan.effect] : null;
  const type = !plan ? null : [plan.strategy ? STRATEGY_LABEL[plan.strategy] : plan.by === "ai" ? "AI plan" : plan.preset === "custom" ? "Edited" : "Auto", effect,
    plan.eq === "bass" ? "bass swap" : plan.eq === "gradual" ? "gradual lows" : null, STEM_LABEL[plan.stems ?? "none"], plan.volume === "custom" ? "custom curve" : null]
    .filter(Boolean).join(" · ");
  return {
    from, to,
    gap: fromTrack && toTrack ? tempoGap({ ...fromTrack, bpm: from?.bpm ?? fromTrack.bpm }, toTrack) : null,
    relation: harmony(fromTrack?.camelot, toTrack?.camelot),
    seconds, beats: plan ? plan.bars * 4 : null, type, bassSwap: plan?.eq !== undefined && plan.eq !== "none",
  };
}

/** Where the transition sits on each deck's own track: the outgoing deck leaves between out and outEnd, the incoming one
    enters at in and is fully up by inEnd, read through the same tempo ratio the engine plays it at. */
export function mixMarks(plan: TransitionPlan | null, tracks: ReadonlyMap<string, Track>, decks: Record<DeckId, DeckLite>) {
  if (!plan) return null;
  const from = tracks.get(plan.fromId), to = tracks.get(plan.toId);
  if (!from || !to) return null;
  const fromDeck = deckHolding(decks, from.id), toDeck = deckHolding(decks, to.id);
  const k = planRatio(plan, from, to, fromDeck ? decks[fromDeck].rate : 1, toDeck ? decks[toDeck].rate : 1);
  const span = spanOn(from, plan.bars);
  return { fromId: from.id, toId: to.id, out: [plan.outAt, plan.outAt + span] as [number, number], in: [plan.inAt, plan.inAt + span * k] as [number, number] };
}

/** Seconds of the live deck's media left before the mix point, as heard at its rate. */
export const dueIn = (outAt: number, position: number, rate: number) => (outAt - position) / (rate || 1);

/** A countdown as heard: m:ss, under ten seconds with a tenth, and "Now" once due. */
export function formatDue(seconds: number) {
  if (!Number.isFinite(seconds)) return "-";
  if (seconds <= 0) return "Now";
  if (seconds < 10) return `0:0${seconds.toFixed(1)}`;
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
export const formatGap = (gap: number | null) => gap === null ? "-" : `${gap >= 0 ? "+" : ""}${(gap * 100).toFixed(1)}%`;
export const confidenceWord = (c: number) => c >= 0.7 ? "High" : c >= 0.4 ? "Medium" : "Low";

/** A queue row: the entry, its track, where it stands. */
export type QueueRow = { item: QueueItem; track: Track | undefined; state: "current" | "next" | "upcoming" | "played" | "failed" };

/** The queue as the panel lists it: the entry playing, then what comes after it in play order (wrapping with loop on),
    then failed entries at the end so they can be retried. Played entries drop out unless loop brings them round again. */
export function queueRows(queue: PlayQueue, tracks: ReadonlyMap<string, Track>, nextUid: string | null): QueueRow[] {
  const at = queue.items.findIndex(i => i.uid === queue.currentUid);
  const current = at >= 0 ? queue.items[at] : null;
  const after = queue.items.slice(at + 1), before = at >= 0 ? queue.items.slice(0, at) : [];
  const order = queue.loop ? [...after, ...before] : after;
  const rows: QueueRow[] = [];
  if (current) rows.push({ item: current, track: tracks.get(current.trackId), state: current.status === "failed" ? "failed" : "current" });
  for (const item of order) {
    if (item.status === "failed") continue;
    rows.push({ item, track: tracks.get(item.trackId), state: item.uid === nextUid ? "next" : "upcoming" });
  }
  for (const item of queue.items) if (item.status === "failed" && item !== current) rows.push({ item, track: tracks.get(item.trackId), state: "failed" });
  return rows;
}
