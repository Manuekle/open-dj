// Analysis happens on the user's device; no file is sent to a service. The browser decodes a file here (decodeAudioData
// already works off the page's thread), and the math runs in a worker so a long track never stalls the UI or the mix.
import { RATE, answer, type Analysis, type AnalysisJob, type AnalysisReply } from "@/lib/analyze-dsp";
import type { Rhythm, Structure } from "@/lib/analysis-types";
import { SampleCache } from "@/lib/sample-cache";

export { ANALYSIS_VERSION, analyzeFeatures, analyzeSamples, camelotOf, staleness, type Analysis, type Bands } from "@/lib/analyze-dsp";
export { RHYTHM_VERSION, STRUCTURE_VERSION } from "@/lib/analysis-types";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; retry: () => Promise<unknown> };
/** The analysis worker: undefined until first asked for, null where it cannot run (no Worker, or it failed). */
let worker: Worker | null | undefined;
const jobs = new Map<number, Pending>();
let lastId = 0;
/** An idle worker holds on to the heap its last jobs grew, so it is let go a minute after the last answer and started
    again by the next job. */
const IDLE_MS = 60_000;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
function releaseWhenIdle() {
  clearTimeout(idleTimer);
  if (jobs.size > 0 || !worker) return;
  idleTimer = setTimeout(() => {
    if (jobs.size > 0) return;
    worker?.terminate();
    worker = undefined;
  }, IDLE_MS);
}

function unwrap<T>(reply: AnalysisReply): T {
  if (reply.error !== undefined) throw new Error(reply.error);
  return reply.result as T;
}
function analysisWorker() {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL("./analysis.worker.ts", import.meta.url), { type: "module" });
  } catch {
    return worker = null;
  }
  worker.onmessage = (event: MessageEvent<AnalysisReply>) => {
    const job = jobs.get(event.data.id);
    jobs.delete(event.data.id);
    releaseWhenIdle();
    if (!job) return;
    try { job.resolve(unwrap(event.data)); } catch (error) { job.reject(error as Error); }
  };
  // A worker that fails to load or dies takes the samples it was sent with it; its jobs decode again and run here.
  worker.onerror = () => {
    worker?.terminate();
    worker = null;
    const left = [...jobs.values()];
    jobs.clear();
    for (const job of left) job.retry().then(job.resolve, job.reject);
  };
  return worker;
}

/** Runs one job in the worker, or here without one. load decodes what the job needs; the samples are moved to the
    worker, not copied, so load runs again if the worker dies holding them. */
async function run<T>(load: () => Promise<AnalysisJob>): Promise<T> {
  const job = await load();
  const current = analysisWorker();
  if (!current) return unwrap<T>(answer({ id: 0, ...job }));
  clearTimeout(idleTimer);
  return new Promise<T>((resolve, reject) => {
    const id = ++lastId;
    jobs.set(id, { resolve: resolve as (value: unknown) => void, reject, retry: () => load().then(again => unwrap<T>(answer({ id, ...again }))) });
    current.postMessage({ id, ...job }, job.kind === "stem" ? [job.left.buffer, job.right.buffer] : [job.samples.buffer]);
  });
}

const decode = async (blob: Blob) => new OfflineAudioContext(1, 1, RATE).decodeAudioData(await blob.arrayBuffer());
/** A copy of one channel, which can be moved to the worker without touching the AudioBuffer. */
function channel(audio: AudioBuffer, index: number) {
  const x = new Float32Array(audio.length);
  audio.copyFromChannel(x, index);
  return x;
}
/** The mono analysis copy: every channel averaged, so a part panned hard to one side (a drum track on the right) is heard. */
function mono(audio: AudioBuffer) {
  const x = channel(audio, 0);
  const n = audio.numberOfChannels;
  if (n === 1) return x;
  const other = new Float32Array(audio.length);
  for (let c = 1; c < n; c++) {
    audio.copyFromChannel(other, c);
    for (let i = 0; i < x.length; i++) x[i] += other[i];
  }
  for (let i = 0; i < x.length; i++) x[i] /= n;
  return x;
}

export function analyzeFile(blob: Blob): Promise<Analysis> {
  return run<Analysis>(async () => ({ kind: "track", samples: mono(await decode(blob)) }));
}

/** Only the beats, downbeats, sections and phrases, for a track whose tempo, key and loudness are current. The file is
    decoded again, but nothing else is recomputed. */
export function analyzeRhythmAndStructure(blob: Blob, bpm: number | null): Promise<{ rhythm: Rhythm; structure: Structure }> {
  return run(async () => ({ kind: "features", samples: mono(await decode(blob)), bpm }));
}

/** Level per second of each stem in a stems file, dB, in STEMS order: where the vocals, drums, bass and melody play. */
export async function analyzeStems(blob: Blob): Promise<number[][]> {
  const audio = await decode(blob);
  if (audio.numberOfChannels < 8) throw new Error("Not a stems file");
  // One stem at a time, so only one stereo pair is copied out at once.
  const levels: number[][] = [];
  for (let stem = 0; stem < 4; stem++) {
    levels.push(await run<number[]>(async () => ({ kind: "stem", left: channel(audio, 2 * stem), right: channel(audio, 2 * stem + 1) })));
  }
  return levels;
}


/** Duration of a file the browser can play but OfflineAudioContext could not decode, read through a media element.
    Rejects for a file the browser cannot play at all (corrupt, truncated, not audio), so it is not added to the library. */
export function probeDuration(blob: Blob, timeoutMs = 8000): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob), media = new Audio();
    // One exit for every outcome: the element and the temporary URL are released whichever it is.
    const finish = (duration: number, error?: Error) => {
      window.clearTimeout(timer);
      media.onloadedmetadata = null; media.onerror = null;
      media.removeAttribute("src"); media.load();
      URL.revokeObjectURL(url);
      if (error) reject(error); else resolve(duration);
    };
    const timer = window.setTimeout(() => finish(0, new Error("The file did not load")), timeoutMs);
    media.preload = "metadata";
    media.onloadedmetadata = () => {
      const duration = media.duration;
      if (Number.isFinite(duration) && duration > 0) finish(duration); else finish(0, new Error("The file has no audio"));
    };
    media.onerror = () => finish(0, new Error("The browser cannot play this file"));
    media.src = url;
  });
}

export function inferName(fileName:string):{title:string;artist:string} {
  const clean=fileName.replace(/\.[^.]+$/,"").replace(/_/g," ").trim();
  const parts=clean.split(/\s[-–—]\s/);
  return parts.length>=2 ? {artist:parts[0],title:parts.slice(1).join(" - ")} : {title:clean||"Untitled track",artist:"Local file"};
}

/**
 * A stable identity for a file's content: its size and a SHA-256 of its first and last 64 KiB. The same file imported
 * twice, or under another name, gives the same value; two different files of the same size are told apart by the bytes.
 * Only the ends are read, so a 150 MB track costs a few milliseconds and is never held in memory whole. Without Web
 * Crypto (an insecure origin) a cheap checksum of the same bytes still separates two imports.
 */
export async function fingerprintOf(blob: Blob): Promise<string> {
  const CHUNK = 64 * 1024;
  const head = blob.slice(0, CHUNK);
  const tail = blob.size > CHUNK ? blob.slice(Math.max(CHUNK, blob.size - CHUNK)) : new Blob([]);
  const bytes = new Uint8Array(8 + head.size + tail.size);
  new DataView(bytes.buffer).setFloat64(0, blob.size);
  bytes.set(new Uint8Array(await head.arrayBuffer()), 8);
  bytes.set(new Uint8Array(await tail.arrayBuffer()), 8 + head.size);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
    return Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
  }
  let hash = 2166136261;
  for (const byte of bytes) { hash ^= byte; hash = Math.imul(hash, 16777619); }
  return `fnv1a:${(hash >>> 0).toString(16)}:${blob.size}`;
}

// Decoded mono samples at the analysis rate, for the transition editor's close-up waveforms. They are large, so they
// live in a cache with a byte budget (see SampleCache): least recently used goes first, and the pair the editor is
// drawing is held until it closes. Deck waveforms and playback never read this cache (they use the stored peaks and the
// media element), so evicting an entry only means the editor decodes that track again.
export const SAMPLE_RATE = RATE;
/** About four 4-minute tracks at the analysis rate. */
export const SAMPLE_CACHE_BYTES = 48 * 1024 * 1024;
const samples = new SampleCache(SAMPLE_CACHE_BYTES);
async function decodeMono(blob: Blob) {
  const audio = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(await blob.arrayBuffer());
  // A copy of channel 0, so the decoded AudioBuffer (every channel of it) can be collected.
  return audio.getChannelData(0).slice();
}
export function loadSamples(id: string, blob: Blob): Promise<Float32Array> {
  return samples.get(id, () => decodeMono(blob));
}
/** Like loadSamples, and the entry is kept until release is called. */
export function holdSamples(id: string, blob: Blob): { samples: Promise<Float32Array>; release: () => void } {
  const ready = loadSamples(id, blob);
  return { samples: ready, release: samples.hold(id) };
}
/** Frees the decoded samples of a deleted track. */
export const dropSamples = (id: string) => samples.drop(id);
/** Frees every decoded sample. */
export const clearSamples = () => samples.clear();
/** Cache state, for the tests and the audit. */
export const sampleCacheStats = () => ({ bytes: samples.bytes, entries: samples.size, budget: SAMPLE_CACHE_BYTES });

/** Peak level per bin between two times, 0..1, for a waveform of `bins` bars. */
export function regionPeaks(data: Float32Array, start: number, end: number, bins: number): number[] {
  const out: number[] = [];
  const from = start * RATE, step = (end - start) * RATE / bins;
  for (let i = 0; i < bins; i++) {
    const a = Math.floor(from + i * step), b = Math.floor(from + (i + 1) * step);
    let peak = 0;
    for (let j = Math.max(0, a); j < Math.min(data.length, b); j += 4) { const v = Math.abs(data[j]); if (v > peak) peak = v; }
    out.push(Math.round(Math.pow(peak, 0.7) * 1000) / 1000);
  }
  return out;
}
