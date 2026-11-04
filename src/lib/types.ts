import type { Rhythm, Structure } from "@/lib/analysis-types";
export type { Rhythm, Structure };
export type DeckId = "A" | "B";
export type EffectName = "off" | "echo" | "reverb" | "filter" | "flanger" | "phaser" | "crush";
export const EFFECTS: { id: Exclude<EffectName, "off">; label: string }[] = [
  { id: "echo", label: "Echo" }, { id: "reverb", label: "Reverb" }, { id: "filter", label: "Filter" },
  { id: "flanger", label: "Flanger" }, { id: "phaser", label: "Phaser" }, { id: "crush", label: "Bitcrush" },
];
export type Waveform = number[];
export type StemName = "vocals" | "drums" | "bass" | "other";
/** Demucs stems, in the order their stereo pairs sit in a track's stems file. */
export const STEMS: { id: StemName; label: string }[] = [
  { id: "vocals", label: "Vocals" }, { id: "drums", label: "Drums" }, { id: "bass", label: "Bass" }, { id: "other", label: "Melody" },
];
export type VolumeCurve = "smooth" | "overlap" | "fade";
export type TransitionEq = "none" | "bass";
export type TransitionEffect = "none" | "lowpass" | "echo" | "rise" | "reverb" | "flanger" | "swap";
export type TransitionPreset = "auto" | "fade" | "rise" | "blend" | "space" | "custom";
/** What a transition does with stems: "vocals" takes the outgoing vocals out early and brings the incoming ones in late. */
export type TransitionStems = "none" | "vocals";
/** One transition between two tracks: where the outgoing one starts leaving, where the incoming one enters, how long
    it takes in bars of the outgoing track, and how volume, low end and effects move across it. */
export type TransitionPlan = {
  fromId: string; toId: string; outAt: number; inAt: number; bars: number;
  volume: VolumeCurve; eq: TransitionEq; effect: TransitionEffect; preset: TransitionPreset;
  stems?: TransitionStems;
  /** Who chose it, and why: one line per decision, read in the transition editor. */
  by?: "auto" | "ai";
  notes?: string[];
  /** The planner's own rating of the plan for this pair of tracks, 0..100. */
  score?: number;
  /** Smart AutoMix: the strategy the planner built it with, and how far the analysis behind the score can be trusted, 0..1. */
  strategy?: TransitionStrategy;
  confidence?: number;
  /** false: the incoming deck keeps its own tempo, with no stretch and no beat alignment. Unset, it is matched as before. */
  sync?: boolean;
};
/** How Smart AutoMix's planner builds a transition (lib/planner). */
export type TransitionStrategy = "smooth-blend" | "beatmatch" | "energy-boost" | "eq-transition" | "quick-cut" | "fallback";
export type TransitionState = { from: DeckId; to: DeckId; plan: TransitionPlan; progress: number };
export interface StoredTrack {
  id: string;
  title: string;
  artist: string;
  album?: string;
  year?: string;
  genre?: string;
  /** Embedded or user-chosen cover image. */
  cover?: Blob;
  blob: Blob;
  fileName: string;
  /** A stable identity of the file's content (lib/analyze fingerprintOf), so the same file is not imported twice. Older
      tracks have none until the library works one out in the background; nothing is removed on their account. */
  fingerprint?: string;
  duration: number;
  bpm: number | null;
  /** How clearly the beat stands out, from the analysis; under 3 there is no tempo. */
  pulse?: number;
  peaks: Waveform;
  addedAt: number;
  /** Seconds to the first beat of the grid. */
  firstBeat?: number;
  /** Median loudness, dBFS. */
  loudness?: number;
  /** Loudness per second, dBFS. */
  energy?: number[];
  /** Musical key, its Camelot code and how sure the analysis is of it, 0..1. */
  key?: string;
  camelot?: string;
  keyClarity?: number;
  /** Integrated loudness, LUFS. */
  lufs?: number;
  /** Power per second in the low, mid and high mixer bands, dB. */
  bands?: { low: number[]; mid: number[]; high: number[] };
  /** Which analysis produced bpm, firstBeat, loudness, key and bands. */
  analysis?: number;
  /** The analysis version a decode of this file failed under, so it is not tried again until the analysis changes. */
  analysisFailed?: number;
  /** Individual beats, downbeats and tempo confidence, versioned (RHYTHM_VERSION). */
  rhythm?: Rhythm;
  /** Sections, boundaries and phrase lengths, versioned (STRUCTURE_VERSION). */
  structure?: Structure;
  /** Level per second of each stem, dB, in STEMS order. */
  stemEnergy?: number[][];
  /** Demucs separation: one 8-channel FLAC, a stereo pair per stem in STEMS order. */
  stems?: Blob;
}
export interface Track extends StoredTrack { url: string; coverUrl?: string; stemsUrl?: string }
export interface StoredMix { id: string; title: string; blob: Blob; format: string; duration: number; createdAt: number; }
export interface DeckState {
  trackId: string | null;
  playing: boolean;
  position: number;
  duration: number;
  rate: number;
  cue: number;
  hotCues: (number | null)[];
  loopStart: number | null;
  loopEnd: number | null;
  loopBeats: number;
  volume: number;
  eq: { high: number; mid: number; low: number; };
  trim: number;
  color: number;
  fx: EffectName;
  fxAmount: number;
  /** Which stems sound, in STEMS order. Only a track with stems plays them apart. */
  stems: boolean[];
}
export const makeDeck = (): DeckState => ({
  trackId: null, playing: false, position: 0, duration: 0, rate: 1, cue: 0,
  hotCues: Array<number | null>(8).fill(null), loopStart: null, loopEnd: null, loopBeats: 4,
  volume: 0.82, eq: { high: 0, mid: 0, low: 0 }, trim: 0, color: 0, fx: "off", fxAmount: 0.45,
  stems: [true, true, true, true],
});
export function formatTime(value: number): string {
  if (!Number.isFinite(value)) return "00:00";
  const seconds = Math.floor(Math.max(0,value));
  return Math.floor(seconds/60).toString().padStart(2,"0") + ":" + (seconds%60).toString().padStart(2,"0");
}
/** One entry of the play queue. The same track may appear twice; the uid tells the entries apart. */
export interface QueueItem { uid: string; trackId: string; status?: "failed"; reason?: string; attempts?: number }
/** The play queue: what plays next, independent of the library. currentUid points at the entry now playing (null before
    any played). loop wraps the end to the start; smart keeps the entries after the current one in the order that
    mixes best (tempo, key, energy). */
export interface PlayQueue { items: QueueItem[]; currentUid: string | null; loop: boolean; smart: boolean }
/** Everything a project keeps of a session besides the audio: both decks, the mixer, saved plans, hot cues per track. */
export interface Session {
  decks: Record<DeckId, DeckState>;
  cross: number;
  master: number;
  activeDeck: DeckId;
  autoMix: boolean;
  plans: Record<string, TransitionPlan>;
  cues: Record<string, (number | null)[]>;
  selectedTrackId: string | null;
  queue?: PlayQueue;
  /** Each deck's own tempo, as the DJ set it, so a mix that matched tempo can hand it back. */
  naturalRates?: Record<DeckId, number>;
}
/** A set the DJ works on: its own tracks (by id, the audio is shared) and the last state of the session. */
export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  trackIds: string[];
  session: Session | null;
}
