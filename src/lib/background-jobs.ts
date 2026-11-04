import { useSyncExternalStore } from "react";
import { analyzeStems } from "@/lib/analyze";
import { loadTracks, saveTrack } from "@/lib/storage";
import { toast } from "@/components/sodium/ui/toast";
import type { Lyrics } from "@/lib/lyrics";

/* Work that must outlive the page that started it. Stem separation and link downloads run here, at module level, not
   inside a component: a Next client navigation keeps this module alive while the page that asked for the job unmounts.
   Each job owns one toast that never times out while it runs (loading), follows the progress, then becomes the result.
   Pages react to the outcome through subscribe functions, and closing the tab while a job runs asks for confirmation. */

type StemsDone = { trackId: string; blob: Blob; stemEnergy: Awaited<ReturnType<typeof analyzeStems>> | undefined };
type StemJobInput = { id: string; title: string; blob: Blob; fileName: string };

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const percent = (p: number) => `${Math.round(Math.min(1, Math.max(0, p)) * 100)}%`;

async function failure(res: Response, fallback = "Stem separation failed") {
  const body = await res.json().then((b: { error?: string }) => b, () => undefined);
  return new Error(body?.error ?? fallback);
}

// ---- running-job registry, readable from React ----
const progress = new Map<string, number>();
const running = new Map<string, Promise<void>>();
let snapshot: Record<string, number> = {};
const listeners = new Set<() => void>();
const publish = () => { snapshot = Object.fromEntries(progress); listeners.forEach(l => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** Progress (0..1) of every stem job running now, by track id. Survives page changes. */
export function useStemProgress(): Record<string, number> {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

const doneListeners = new Set<(done: StemsDone) => void>();
/** Called when a stem job finished and its result is saved. Returns the unsubscribe. */
export function onStemsDone(listener: (done: StemsDone) => void) {
  doneListeners.add(listener);
  return () => { doneListeners.delete(listener); };
}

// ---- leaving the tab with work running ----
const active = new Set<string>();
let guarded = false;
const guard = (e: BeforeUnloadEvent) => { if (active.size) { e.preventDefault(); e.returnValue = ""; } };
function hold(key: string) {
  active.add(key);
  if (!guarded && typeof window !== "undefined") { window.addEventListener("beforeunload", guard); guarded = true; }
}
function release(key: string) {
  active.delete(key);
  if (!active.size && guarded) { window.removeEventListener("beforeunload", guard); guarded = false; }
}

export const stemToastId = (trackId: string) => `stems-${trackId}`;

/** Starts (or joins) the separation of one track. Resolves when the job is over; failures end in the toast, never throw. */
export function startStemJob(input: StemJobInput): Promise<void> {
  const existing = running.get(input.id);
  if (existing) return existing;
  const job = runStemJob(input).finally(() => { running.delete(input.id); progress.delete(input.id); release(`stems-${input.id}`); publish(); });
  running.set(input.id, job);
  progress.set(input.id, 0);
  hold(`stems-${input.id}`);
  publish();
  return job;
}

async function runStemJob({ id, title, blob, fileName }: StemJobInput) {
  const toastId = stemToastId(id);
  const label = `Separating stems for ${title}`;
  toast.loading(label, { id: toastId, description: "0%" });
  try {
    const start = await fetch("/api/stems", { method: "POST", body: blob, headers: { "x-file-name": encodeURIComponent(fileName) } });
    if (!start.ok) throw await failure(start);
    const { job } = await start.json() as { job: string };
    for (;;) {
      await wait(1000);
      const res = await fetch(`/api/stems?job=${job}`);
      if (!res.ok) throw await failure(res);
      const status = await res.json() as { state: string; progress: number; error?: string };
      if (status.state === "failed") throw new Error(status.error ?? "Stem separation failed");
      progress.set(id, status.progress);
      publish();
      toast.update(toastId, "loading", label, { description: percent(status.progress) });
      if (status.state === "done") break;
    }
    toast.update(toastId, "loading", label, { description: "Downloading stems" });
    const file = await fetch(`/api/stems?job=${job}&file=1`);
    if (!file.ok) throw await failure(file);
    const stems = await file.blob();
    toast.update(toastId, "loading", label, { description: "Measuring levels" });
    const stemEnergy = await analyzeStems(stems).catch(() => undefined);
    // Deleted while the job ran: saving now would bring the track back from the dead.
    const stored = (await loadTracks().catch(() => [])).find(t => t.id === id);
    if (!stored) { toast.dismiss(toastId); return; }
    let kept = true;
    try { await saveTrack({ ...stored, stems, stemEnergy }); } catch { kept = false; }
    toast.update(toastId, kept ? "success" : "warn", kept ? `Stems ready for ${title}.` : `Stems ready for ${title}, but there is not enough space to keep them. They apply for this session only.`);
    doneListeners.forEach(l => l({ trackId: id, blob: stems, stemEnergy }));
  } catch (e) {
    toast.update(toastId, "fail", e instanceof Error ? e.message : "Stem separation failed");
  }
}

// ---- lyrics (Whisper) ----
type LyricsJobInput = { id: string; title: string; blob: Blob; fileName: string; /** The track's stems file: only its vocals are transcribed, which is cleaner. */ stems?: Blob; language?: string };
const lyricProgress = new Map<string, number>();
const lyricRunning = new Map<string, Promise<void>>();
let lyricSnapshot: Record<string, number> = {};
const lyricListeners = new Set<() => void>();
const publishLyrics = () => { lyricSnapshot = Object.fromEntries(lyricProgress); lyricListeners.forEach(l => l()); };
const subscribeLyrics = (l: () => void) => { lyricListeners.add(l); return () => { lyricListeners.delete(l); }; };

/** Progress (0..1) of every transcription running now, by track id. Survives page changes. */
export function useLyricsProgress(): Record<string, number> {
  return useSyncExternalStore(subscribeLyrics, () => lyricSnapshot, () => lyricSnapshot);
}

const lyricsDoneListeners = new Set<(done: { trackId: string; lyrics: Lyrics }) => void>();
/** Called when a transcription finished and its words are saved with the track. Returns the unsubscribe. */
export function onLyricsDone(listener: (done: { trackId: string; lyrics: Lyrics }) => void) {
  lyricsDoneListeners.add(listener);
  return () => { lyricsDoneListeners.delete(listener); };
}

export const lyricsToastId = (trackId: string) => `lyrics-${trackId}`;

/** Starts (or joins) the transcription of one track. Resolves when the job is over; failures end in the toast, never throw. */
export function startLyricsJob(input: LyricsJobInput): Promise<void> {
  const existing = lyricRunning.get(input.id);
  if (existing) return existing;
  const job = runLyricsJob(input).finally(() => { lyricRunning.delete(input.id); lyricProgress.delete(input.id); release(`lyrics-${input.id}`); publishLyrics(); });
  lyricRunning.set(input.id, job);
  lyricProgress.set(input.id, 0);
  hold(`lyrics-${input.id}`);
  publishLyrics();
  return job;
}

async function runLyricsJob({ id, title, blob, fileName, stems, language }: LyricsJobInput) {
  const toastId = lyricsToastId(id);
  const label = `Transcribing lyrics for ${title}`;
  toast.loading(label, { id: toastId, description: "0%" });
  try {
    const headers: Record<string, string> = { "x-file-name": encodeURIComponent(stems ? "stems.flac" : fileName), "x-language": language ?? "auto" };
    if (stems) headers["x-source"] = "vocals";
    const start = await fetch("/api/lyrics", { method: "POST", body: stems ?? blob, headers });
    if (!start.ok) throw await failure(start, "Transcription failed");
    const { job } = await start.json() as { job: string };
    for (;;) {
      await wait(1000);
      const res = await fetch(`/api/lyrics?job=${job}`);
      if (!res.ok) throw await failure(res, "Transcription failed");
      const status = await res.json() as { state: string; progress: number; error?: string };
      if (status.state === "failed") throw new Error(status.error ?? "Transcription failed");
      lyricProgress.set(id, status.progress);
      publishLyrics();
      toast.update(toastId, "loading", label, { description: percent(status.progress) });
      if (status.state === "done") break;
    }
    const file = await fetch(`/api/lyrics?job=${job}&file=1`);
    if (!file.ok) throw await failure(file, "Transcription failed");
    const lyrics = await file.json() as Lyrics;
    if (!lyrics.words.length) { toast.update(toastId, "warn", `No words were heard in ${title}. Try a track with vocals.`); return; }
    // Deleted while the job ran: saving now would bring the track back from the dead.
    const stored = (await loadTracks().catch(() => [])).find(t => t.id === id);
    if (!stored) { toast.dismiss(toastId); return; }
    let kept = true;
    try { await saveTrack({ ...stored, lyrics }); } catch { kept = false; }
    toast.update(toastId, kept ? "success" : "warn", kept ? `Lyrics ready for ${title}.` : `Lyrics ready for ${title}, but there is not enough space to keep them. They apply for this session only.`);
    lyricsDoneListeners.forEach(l => l({ trackId: id, lyrics }));
  } catch (e) {
    toast.update(toastId, "fail", e instanceof Error ? e.message : "Transcription failed");
  }
}

// ---- downloads from a link ----
/** Files downloaded while no deck page was mounted. The deck page imports them as soon as it opens. */
const pendingImports: File[] = [];
const importListeners = new Set<(files: File[]) => void>();

/** Takes the files that finished downloading with no deck page open. */
export function takePendingImports() { return pendingImports.splice(0); }
/** Called with each downloaded file. Returns the unsubscribe. */
export function onDownloaded(listener: (files: File[]) => void) {
  importListeners.add(listener);
  return () => { importListeners.delete(listener); };
}

let importSeq = 0;
/**
 * Downloads one track from a link on the server and hands the file to whichever deck page is open. One toast follows the
 * download and stays until it ends; with no deck page open, the file waits and the toast says where to find it.
 */
export async function downloadFromLink(url: string, start: string, end: string): Promise<boolean> {
  const toastId = `import-url-${++importSeq}`;
  const key = toastId;
  hold(key);
  toast.loading("Downloading from link", { id: toastId, description: url });
  try {
    const res = await fetch("/api/import-url", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, start, end }) });
    if (!res.ok) {
      const message = await res.json().then((b: { error?: string }) => b.error, () => undefined);
      toast.update(toastId, "fail", message ?? "Could not import that link.");
      return false;
    }
    const name = decodeURIComponent(res.headers.get("x-file-name") ?? "") || "download.m4a";
    // The server keeps the audio in the format the site published it in (usually AAC in M4A), not always MP3.
    const type = res.headers.get("content-type")?.split(";")[0] || "audio/mp4";
    const total = Number(res.headers.get("content-length")) || 0;
    let blob: Blob;
    if (res.body && total) {
      const reader = res.body.getReader();
      const parts: Uint8Array<ArrayBuffer>[] = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value as Uint8Array<ArrayBuffer>); got += value.byteLength;
        toast.update(toastId, "loading", "Downloading from link", { description: percent(got / total) });
      }
      blob = new Blob(parts, { type });
    } else blob = await res.blob();
    const file = new File([blob], name, { type });
    if (importListeners.size) {
      toast.dismiss(toastId);
      importListeners.forEach(l => l([file]));
    } else {
      pendingImports.push(file);
      toast.update(toastId, "success", `${name} downloaded. Open the decks to add it to your library.`);
    }
    return true;
  } catch {
    toast.update(toastId, "fail", "Could not reach the import service.");
    return false;
  } finally { release(key); }
}
