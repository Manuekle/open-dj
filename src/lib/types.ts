export type DeckId = "A" | "B";
export type EffectName = "off" | "echo" | "reverb" | "filter" | "flanger" | "phaser" | "crush";
export type Waveform = number[];
export interface StoredTrack {
  id: string;
  title: string;
  artist: string;
  blob: Blob;
  fileName: string;
  duration: number;
  bpm: number | null;
  peaks: Waveform;
  addedAt: number;
}
export interface Track extends StoredTrack { url: string }
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
  loopBeats: 4 | 8 | 16;
  volume: number;
  eq: { high: number; mid: number; low: number; };
  fx: EffectName;
  fxAmount: number;
}
export const makeDeck = (): DeckState => ({
  trackId: null, playing: false, position: 0, duration: 0, rate: 1, cue: 0,
  hotCues: [null,null,null,null], loopStart: null, loopEnd: null, loopBeats: 8,
  volume: 0.82, eq: { high: 0, mid: 0, low: 0 }, fx: "off", fxAmount: 0.45
});
export function formatTime(value: number): string {
  if (!Number.isFinite(value)) return "00:00";
  const seconds = Math.floor(Math.max(0,value));
  return Math.floor(seconds/60).toString().padStart(2,"0") + ":" + (seconds%60).toString().padStart(2,"0");
}
