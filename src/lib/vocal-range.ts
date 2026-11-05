import { detectPitch, hzToMidi, NOTE_NAMES } from "@/lib/autotune";

/* A singer's range and a song's, and the key change that puts the song in the singer's range.
   - The singer's: a short take on the microphone, low to high and back, read by the same YIN as lib/autotune.
   - The song's: the vocals stem (Demucs), read whole. Its tessitura, where the voice spends most of its time, is the
     10th to 90th percentile of the voiced frames; a high note held for a second counts more than one touched in passing.
   - fitKey tries every shift up to a fourth either way, also an octave apart (a low voice sings a high song an octave
     down without any change), and keeps the one that leaves the least of the song outside the singer's range. */

/** Lowest and highest note, as MIDI numbers with a fraction (60 = C4). */
export type VocalRange = { low: number; high: number };

export const noteName = (midi: number) => {
  const n = Math.round(midi);
  return `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
};
export const rangeLabel = (r: VocalRange) => `${noteName(r.low)} to ${noteName(r.high)}`;

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return NaN;
  const at = Math.max(0, Math.min(sorted.length - 1, p * (sorted.length - 1)));
  const lo = Math.floor(at), hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

/**
 * The range in a pitch track (Hz per frame, 0 where unvoiced). Only runs of at least `run` voiced frames that move less
 * than a semitone frame to frame count, which drops octave slips, breaths and bleed from the other stems. Null when
 * fewer than `least` frames are left.
 */
export function rangeOf(f0: ArrayLike<number>, { low = 0.1, high = 0.9, run = 6, least = 20 } = {}): VocalRange | null {
  const kept: number[] = [];
  let start = 0;
  const flush = (end: number) => {
    if (end - start >= run) for (let i = start; i < end; i++) kept.push(hzToMidi(f0[i]));
  };
  for (let i = 0; i < f0.length; i++) {
    const voiced = f0[i] > 0;
    const steady = voiced && i > start && f0[i - 1] > 0 && Math.abs(hzToMidi(f0[i]) - hzToMidi(f0[i - 1])) < 1;
    if (voiced && (i === start || steady)) continue;
    flush(i);
    start = voiced ? i : i + 1;
  }
  flush(f0.length);
  if (kept.length < least) return null;
  kept.sort((a, b) => a - b);
  return { low: percentile(kept, low), high: percentile(kept, high) };
}

export type KeyFit = {
  /** Semitones to move the song. */
  shift: number;
  /** -1: sing an octave below the original singer, 1: above, 0: where they sing. */
  octave: -1 | 0 | 1;
  /** Semitones of the song's tessitura still outside the singer's range after the shift. 0 when it fits. */
  outside: number;
};

/** The key change, within `max` semitones, that best puts the song's tessitura inside the singer's range. */
export function fitKey(voice: VocalRange, song: VocalRange, max = 5): KeyFit {
  const centre = (voice.low + voice.high) / 2;
  let best: KeyFit & { cost: number } = { shift: 0, octave: 0, outside: Infinity, cost: Infinity };
  for (const octave of [0, -1, 1] as const) {
    for (let shift = -max; shift <= max; shift++) {
      const move = shift + 12 * octave, low = song.low + move, high = song.high + move;
      const outside = Math.max(0, voice.low - low) + Math.max(0, high - voice.high);
      // Out of range costs most, then being off centre; a smaller shift sounds better, and singing where the original
      // singer sings is the expected way.
      const cost = outside * 4 + Math.abs((low + high) / 2 - centre) + Math.abs(shift) * 0.25 + Math.abs(octave) * 2;
      if (cost < best.cost - 1e-9) best = { shift, octave, outside: Math.round(outside * 10) / 10, cost };
    }
  }
  const { shift, octave, outside } = best;
  return { shift, octave, outside };
}

/** The tessitura of the vocals stem: the first stereo pair of the 8-channel stems file, read at a low rate. */
export async function songRange(stems: Blob, onProgress?: (p: number) => void): Promise<VocalRange | null> {
  const RATE = 16000;
  // Decoding resamples to the context's rate, so a 16 kHz context keeps eight channels of a long song small.
  const ctx = new OfflineAudioContext(1, 1, RATE);
  const buffer = await ctx.decodeAudioData(await stems.arrayBuffer());
  onProgress?.(0.15);
  const left = buffer.getChannelData(0), right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  const mono = new Float32Array(left.length);
  for (let i = 0; i < mono.length; i++) mono[i] = (left[i] + right[i]) / 2;
  const track = await detectPitch(mono, buffer.sampleRate, p => onProgress?.(0.15 + p * 0.85));
  onProgress?.(1);
  return rangeOf(track.f0);
}

/** The voiced pitch in one block of microphone input, Hz, or 0. */
export async function pitchOfBlock(block: Float32Array, sampleRate: number): Promise<number> {
  const { f0 } = await detectPitch(block, sampleRate);
  const voiced = [...f0].filter(v => v > 0).sort((a, b) => a - b);
  return voiced.length >= Math.max(1, f0.length / 2) ? voiced[voiced.length >> 1] : 0;
}

const VOICE_KEY = "open-dj:voice-range";
const SONG_KEY = (id: string) => `open-dj:song-range:v1:${id}`;

function read(key: string): VocalRange | null {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null") as unknown;
    if (v && typeof v === "object" && Number.isFinite((v as VocalRange).low) && Number.isFinite((v as VocalRange).high)) return { low: (v as VocalRange).low, high: (v as VocalRange).high };
  } catch { /* storage blocked or bad value */ }
  return null;
}
function write(key: string, value: VocalRange | null) {
  try { if (value) localStorage.setItem(key, JSON.stringify(value)); else localStorage.removeItem(key); } catch { /* storage blocked */ }
}
export const loadVoiceRange = () => read(VOICE_KEY);
export const saveVoiceRange = (r: VocalRange | null) => write(VOICE_KEY, r);
export const loadSongRange = (id: string) => read(SONG_KEY(id));
export const saveSongRange = (id: string, r: VocalRange) => write(SONG_KEY(id), r);
