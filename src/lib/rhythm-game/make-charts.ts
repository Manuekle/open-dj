import { buildCharts, type ChartSet } from "@/lib/rhythm-game/chart";

/** Same rate as the DJ analysis: the beat tracker and the onset math were tuned on it. */
const RATE = 11025;

export type Song = {
  /** The track at the device's own rate, what the player hears. */
  audio: AudioBuffer;
  charts: ChartSet;
};

function mono(audio: AudioBuffer) {
  const x = new Float32Array(audio.length);
  audio.copyFromChannel(x, 0);
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

function inWorker(samples: Float32Array, bpm: number | null): Promise<ChartSet> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try { worker = new Worker(new URL("./chart.worker.ts", import.meta.url), { type: "module" }); }
    catch { resolve(buildCharts(samples, RATE, bpm)); return; }
    worker.onmessage = (event: MessageEvent<{ charts?: ChartSet; error?: string }>) => {
      worker.terminate();
      if (event.data.charts) resolve(event.data.charts); else reject(new Error(event.data.error ?? "Could not chart the track"));
    };
    // A worker that cannot load runs the same math here.
    worker.onerror = () => { worker.terminate(); try { resolve(buildCharts(samples, RATE, bpm)); } catch (e) { reject(e as Error); } };
    worker.postMessage({ samples, rate: RATE, bpm }, [samples.buffer]);
  });
}

/** Decodes a file and charts every difficulty of it. `bpm` is a hint from the library's own analysis, when there is one. */
export async function makeSong(blob: Blob, context: BaseAudioContext, bpm: number | null = null): Promise<Song> {
  const bytes = await blob.arrayBuffer();
  const audio = await context.decodeAudioData(bytes.slice(0));
  // The analysis copy is decoded again at the analysis rate: the browser resamples it, no math of ours.
  const small = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(bytes);
  const charts = await inWorker(mono(small), bpm);
  return { audio, charts };
}
