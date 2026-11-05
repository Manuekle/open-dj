import { ANALYSIS_VERSION, analyzeFile, fingerprintOf, inferName, probeDuration, type Analysis } from "@/lib/analyze";
import { readTags, shrinkCover } from "@/lib/tags";
import { saveTrack } from "@/lib/storage";
import type { StoredTrack } from "@/lib/types";

/* Adds one audio file to the library from a page that has no decks (the Stems page), the way the decks page's import
   does it: the same file twice is one entry (its content is the identity), tags and cover are read, and the analysis runs
   before the track is stored. The decks page keeps its own import, which also loads the result onto a deck. */

export type LibraryImport = { track: StoredTrack; duplicate: boolean };

export async function importToLibrary(file: File, library: StoredTrack[]): Promise<LibraryImport> {
  const fingerprint = await fingerprintOf(file).catch(() => undefined);
  const existing = fingerprint ? library.find(t => t.fingerprint === fingerprint) : undefined;
  if (existing) return { track: existing, duplicate: true };
  const guess = inferName(file.name);
  const tags = await readTags(file);
  if (tags.cover) tags.cover = await shrinkCover(tags.cover);
  let analysis: Partial<Analysis> & Pick<StoredTrack, "analysisFailed"> & { duration: number; peaks: number[]; bpm: number | null };
  try { analysis = await analyzeFile(file); } catch {
    analysis = { duration: await probeDuration(file), peaks: [], bpm: null, analysisFailed: ANALYSIS_VERSION };
  }
  const track: StoredTrack = {
    id: crypto.randomUUID(), title: tags.title ?? guess.title, artist: tags.artist ?? guess.artist, album: tags.album, year: tags.year, genre: tags.genre,
    cover: tags.cover, blob: file, fileName: file.name, addedAt: Date.now(), ...analysis, fingerprint,
  };
  await saveTrack(track);
  return { track, duplicate: false };
}
