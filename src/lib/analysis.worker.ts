import { answer, type AnalysisRequest } from "@/lib/analyze-dsp";

// The analysis worker: tempo, key, loudness and bands of each track, off the page's thread (lib/analyze.ts sends the jobs).
self.onmessage = (event: MessageEvent<AnalysisRequest>) => self.postMessage(answer(event.data));
