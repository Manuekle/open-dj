/* Preroll: how long the incoming deck plays silent before a blend, so everything that can make noise happens unheard.

   Before a blend the incoming deck has to start (play() resolves some tens to hundreds of ms after it is called, longer
   on a cold decoder), its tempo has to be set (the browser's stretcher takes a moment to settle) and its beats have to be
   aligned (each seek on a playing element costs a restart). A fixed preroll is right on one machine and short on another;
   this one is built from what the deck has actually taken. */

/** Latencies seen so far, seconds, newest last. */
export class LatencyTracker {
  private readonly samples: number[] = [];
  constructor(private readonly keep = 8, private readonly fallback = 0.25) {}
  record(seconds: number) {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    this.samples.push(Math.min(seconds, 5));
    if (this.samples.length > this.keep) this.samples.shift();
  }
  /** The slow end of what has been seen (about the 90th percentile), or a guess before anything has been. */
  slow() {
    if (!this.samples.length) return this.fallback;
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
  }
}

export type PrerollInput = {
  /** play() to audio moving, the slow end. */
  startLatency: number;
  /** What one seek on a playing element costs. */
  seekCost: number;
  /** Seek-and-check rounds allowed before the blend. */
  passes?: number;
  /** Time for an element to re-time after a seek, before it can be read again. */
  settle?: number;
  margin?: number;
};

export const MIN_PREROLL = 0.8;
export const MAX_PREROLL = 3;
/** Context seconds between writing a blend's automation and its first sample. */
export const LOOKAHEAD = 0.08;

/** Seconds of preroll: start, then each alignment pass, then a margin; held between MIN_PREROLL and MAX_PREROLL. */
export function prerollSeconds({ startLatency, seekCost, passes = 2, settle = 0.25, margin = 0.2 }: PrerollInput) {
  const need = startLatency + passes * (seekCost + settle) + margin + LOOKAHEAD;
  return Math.max(MIN_PREROLL, Math.min(MAX_PREROLL, need));
}
