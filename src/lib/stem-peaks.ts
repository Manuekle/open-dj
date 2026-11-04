import { STEMS } from "@/lib/types";

/* Waveform overview of each stem in a track's stems file (8-channel FLAC, a stereo pair per stem in STEMS order).
   Each stem becomes `buckets` min/max pairs, so a lane can be drawn at any width without keeping the decoded audio. */

export type StemPeaks = { min: Float32Array; max: Float32Array };

/** Min and max of both channels of one stem over `buckets` equal slices of its length. */
export function peaksOf(left: Float32Array, right: Float32Array, buckets: number): StemPeaks {
  const min = new Float32Array(buckets), max = new Float32Array(buckets);
  const size = left.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * size), to = Math.max(from + 1, Math.min(left.length, Math.floor((b + 1) * size)));
    let lo = 0, hi = 0;
    for (let i = from; i < to; i++) {
      const l = left[i], r = right[i];
      if (l < lo) lo = l; else if (l > hi) hi = l;
      if (r < lo) lo = r; else if (r > hi) hi = r;
    }
    min[b] = lo; max[b] = hi;
  }
  return { min, max };
}

/** Decodes the stems file once, reads the peaks of every stem and lets the decoded audio go. */
export async function stemPeaks(blob: Blob, buckets = 2400): Promise<StemPeaks[]> {
  const audio = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(await blob.arrayBuffer());
  if (audio.numberOfChannels < STEMS.length * 2) throw new Error("Not a stems file");
  const left = new Float32Array(audio.length), right = new Float32Array(audio.length);
  return STEMS.map((_, k) => {
    audio.copyFromChannel(left, 2 * k);
    audio.copyFromChannel(right, 2 * k + 1);
    return peaksOf(left, right, buckets);
  });
}
