import { STEMS } from "@/lib/types";

/* Pure helpers of the four-track studio: where a clip starts playing for a given playhead, how recorded voice is
   lined up with what the singer heard, which lanes sound, and the WAV encoding of a mixdown or a take. */

export const STUDIO_LANES = 4;
/** The timeline is never shorter than this, so a voice can be recorded over an empty project. */
export const MIN_TIMELINE = 60;

/** Where a clip that sits at `offset` seconds on the timeline starts, when playback begins at `pos`:
    `delay` seconds from now and `bufferOffset` seconds into the clip. Null when the clip is already over. */
export function clipWindow(offset: number, length: number, pos: number): { delay: number; bufferOffset: number } | null {
  if (pos >= offset + length) return null;
  if (pos <= offset) return { delay: offset - pos, bufferOffset: 0 };
  return { delay: 0, bufferOffset: pos - offset };
}

/** Timeline position of the first recorded sample. The singer reacts to what came out of the speakers
    `latency` seconds after the playhead passed it, so the take is pulled earlier by that much. */
export function takeOffset(startPos: number, latency: number): number {
  return startPos - latency;
}

/** Whether lane `k` sounds: not muted and, when any lane is soloed, one of the soloed. */
export function audible(mute: boolean[], solo: boolean[], k: number): boolean {
  return solo.some(Boolean) ? solo[k] : !mute[k];
}

/** Seconds from 0 to the end of the last clip, never under MIN_TIMELINE. */
export function timelineLength(clips: { offset: number; duration: number }[]): number {
  return Math.max(MIN_TIMELINE, ...clips.map(c => c.offset + c.duration));
}

/** Joins the chunks a recorder collected into one mono signal. */
export function joinChunks(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** Stereo copy of stem `k` from a stems file already decoded to eight channels. */
export function stemChannels(channels: Float32Array[], k: number): [Float32Array, Float32Array] {
  if (channels.length < STEMS.length * 2) throw new Error("Not a stems file");
  return [channels[2 * k], channels[2 * k + 1]];
}

type PcmSource = { numberOfChannels: number; length: number; sampleRate: number; getChannelData(c: number): Float32Array };

/** 16-bit PCM WAV of an audio buffer (mono or stereo; more channels are dropped past the second). */
export function encodeWav(audio: PcmSource): Blob {
  const channels = Math.min(2, audio.numberOfChannels), frames = audio.length;
  const data = frames * channels * 2, view = new DataView(new ArrayBuffer(44 + data));
  const text = (at: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, 36 + data, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, audio.sampleRate, true); view.setUint32(28, audio.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, data, true);
  const planes = Array.from({ length: channels }, (_, c) => audio.getChannelData(c));
  let at = 44;
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) {
    const s = Math.max(-1, Math.min(1, planes[c][i]));
    view.setInt16(at, s < 0 ? s * 0x8000 : s * 0x7fff, true); at += 2;
  }
  return new Blob([view.buffer], { type: "audio/wav" });
}
