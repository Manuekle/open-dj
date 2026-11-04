import { buildCharts, type ChartSet } from "@/lib/rhythm-game/chart";

// Charts for the rhythm game, off the page's thread (lib/rhythm-game/make-charts.ts sends the track).
type Request = { samples: Float32Array; rate: number; bpm: number | null };
type Reply = { charts?: ChartSet; error?: string };

self.onmessage = (event: MessageEvent<Request>) => {
  let reply: Reply;
  try { reply = { charts: buildCharts(event.data.samples, event.data.rate, event.data.bpm) }; }
  catch (error) { reply = { error: (error as Error).message }; }
  self.postMessage(reply);
};
