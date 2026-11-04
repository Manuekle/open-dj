/* Mapping between the page's performance clock and the audio context's clock.

   AudioContext.currentTime moves in steps of a render block (and in some engines a whole hardware buffer, 10 ms or
   more), so a single reading is off by up to a step. performance.now() is smooth. Reading both many times and keeping
   the offset gives a smooth map from one to the other, good to a millisecond or two, which is what lets the main thread
   place "the outgoing deck reaches bar 17 at this context time" without that step in it. A stale currentTime only ever
   reads early, so the offset is taken from the high end of the window, not the middle. */

export class ClockMap {
  private readonly offsets: number[] = [];
  constructor(private readonly keep = 24) {}

  /** Record the context time seen at a performance time (both in seconds). */
  sample(perfSeconds: number, contextSeconds: number) {
    this.offsets.push(contextSeconds - perfSeconds);
    if (this.offsets.length > this.keep) this.offsets.shift();
  }
  get ready() { return this.offsets.length >= 3; }
  /** The context time of a performance time. */
  at(perfSeconds: number) {
    if (!this.offsets.length) return perfSeconds;
    const sorted = [...this.offsets].sort((a, b) => a - b);
    return perfSeconds + sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.8))];
  }
}
