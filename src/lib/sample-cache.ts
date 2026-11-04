/* A bounded cache of decoded samples. Decoded audio is large (a 4-minute track at the 11 kHz analysis rate is about
   10 MB, a 10-minute one 26 MB), so the cache keeps what fits in a byte budget, drops the entry used longest ago first,
   and never drops one that something is holding (the transition editor holds the two tracks it draws). */

type Entry = { promise: Promise<Float32Array>; bytes: number; holds: number };

export class SampleCache {
  private entries = new Map<string, Entry>();
  constructor(private readonly budget: number) {}

  /** Decoded bytes kept now (entries still decoding count as 0 until they land). */
  get bytes() { let sum = 0; for (const e of this.entries.values()) sum += e.bytes; return sum; }
  get size() { return this.entries.size; }
  has(id: string) { return this.entries.has(id); }

  /** The samples for an id, decoding with `load` the first time. A failed decode is not kept, so the next call retries. */
  get(id: string, load: () => Promise<Float32Array>): Promise<Float32Array> {
    const hit = this.entries.get(id);
    if (hit) {
      // Most recently used goes last in Map order.
      this.entries.delete(id); this.entries.set(id, hit);
      return hit.promise;
    }
    const entry: Entry = { promise: load(), bytes: 0, holds: 0 };
    this.entries.set(id, entry);
    entry.promise.then(samples => {
      // Dropped or replaced while decoding: nothing to account for.
      if (this.entries.get(id) !== entry) return;
      entry.bytes = samples.byteLength;
      this.trim();
    }, () => { if (this.entries.get(id) === entry) this.entries.delete(id); });
    return entry.promise;
  }

  /** Keeps an id's entry from being evicted until the returned release runs. Unknown ids hold nothing. */
  hold(id: string): () => void {
    const entry = this.entries.get(id);
    if (!entry) return () => {};
    entry.holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.holds--;
      this.trim();
    };
  }

  /** Forgets one id (its track was deleted). */
  drop(id: string) { this.entries.delete(id); }
  /** Forgets everything. */
  clear() { this.entries.clear(); }

  private trim() {
    if (this.bytes <= this.budget) return;
    let total = this.bytes;
    for (const [id, entry] of this.entries) {
      if (total <= this.budget) break;
      if (entry.holds > 0 || entry.bytes === 0) continue;
      this.entries.delete(id);
      total -= entry.bytes;
    }
  }
}
