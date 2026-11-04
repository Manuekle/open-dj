import { STEMS, type Track } from "@/lib/types";
import { barOf } from "@/lib/transition";

/* What /api/mix gives the local model about a track: the analysis, cut down to a few hundred numbers. Series are one
   value per bar (rounded dB), so a phrase boundary or a breakdown shows as a step a model can read. */

export type MixFeatures = {
  title: string; artist: string; genre?: string;
  duration: number; bpm: number | null; firstBeat: number; barSeconds: number;
  key?: string; camelot?: string; keyClarity?: number; lufs?: number;
  /** Per bar from firstBeat: overall loudness, the low band, and each stem when the track has stems. The mid and high
      bands stay out: they add a third to the prompt, a minute on a CPU, and the bass is what decides a swap. */
  perBar: { loudness: number[]; low?: number[]; stems?: Record<string, number[]> };
};

function perBar(series: number[] | undefined, track: Track): number[] | undefined {
  if (!series?.length) return undefined;
  const bar = barOf(track), start = track.firstBeat ?? 0, out: number[] = [];
  for (let t = start; t < track.duration; t += bar) {
    const slice = series.slice(Math.floor(t), Math.max(Math.floor(t) + 1, Math.floor(t + bar)));
    const power = slice.reduce((sum, db) => sum + 10 ** (db / 10), 0) / Math.max(1, slice.length);
    out.push(Math.round(10 * Math.log10(1e-12 + power)));
  }
  return out;
}

export function mixFeatures(track: Track): MixFeatures {
  const stems = track.stemEnergy && Object.fromEntries(STEMS.map((s, i) => [s.id, perBar(track.stemEnergy![i], track) ?? []]));
  return {
    title: track.title, artist: track.artist, genre: track.genre,
    duration: Math.round(track.duration * 100) / 100, bpm: track.bpm, firstBeat: track.firstBeat ?? 0, barSeconds: Math.round(barOf(track) * 1000) / 1000,
    key: track.key, camelot: track.camelot, keyClarity: track.keyClarity, lufs: track.lufs,
    perBar: { loudness: perBar(track.energy, track) ?? [], low: perBar(track.bands?.low, track), stems },
  };
}
