import { describe, expect, it } from "vitest";
import { SampleCache } from "@/lib/sample-cache";

const MB = 1024 * 1024;
const samples = (mb: number) => new Float32Array(mb * MB / 4);
/** Lets promise callbacks (the cache's accounting) run. */
const settle = () => new Promise(resolve => setTimeout(resolve));

describe("sample cache", () => {
  it("decodes once per id and returns the same samples", async () => {
    const cache = new SampleCache(100 * MB);
    let loads = 0;
    const load = async () => { loads++; return samples(1); };
    const a = await cache.get("a", load), b = await cache.get("a", load);
    expect(a).toBe(b);
    expect(loads).toBe(1);
  });

  it("stays inside its budget by dropping the least recently used entry", async () => {
    const cache = new SampleCache(25 * MB);
    for (const id of ["a", "b", "c"]) { await cache.get(id, async () => samples(10)); await settle(); }
    expect(cache.bytes).toBeLessThanOrEqual(25 * MB);
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b") && cache.has("c")).toBe(true);
  });

  it("treats a read as a use", async () => {
    const cache = new SampleCache(25 * MB);
    await cache.get("a", async () => samples(10)); await settle();
    await cache.get("b", async () => samples(10)); await settle();
    await cache.get("a", async () => samples(10)); // a is now newer than b
    await cache.get("c", async () => samples(10)); await settle();
    expect(cache.has("b")).toBe(false);
    expect(cache.has("a") && cache.has("c")).toBe(true);
  });

  it("never drops an entry that is held, even over budget, and can drop it once released", async () => {
    const cache = new SampleCache(15 * MB);
    await cache.get("a", async () => samples(10)); await settle();
    const release = cache.hold("a");
    await cache.get("b", async () => samples(10)); await settle();
    // b cannot fit next to the held a, so it is not kept (its caller still got the samples); a stays.
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    release();
    release(); // a second release is harmless
    await cache.get("c", async () => samples(10)); await settle();
    // Released, a is the oldest, so it goes to make room for c.
    expect(cache.has("a")).toBe(false);
    expect(cache.has("c")).toBe(true);
    expect(cache.bytes).toBeLessThanOrEqual(15 * MB);
  });

  it("does not keep a failed decode, so the next call retries", async () => {
    const cache = new SampleCache(10 * MB);
    await expect(cache.get("a", () => Promise.reject(new Error("corrupt")))).rejects.toThrow("corrupt");
    await settle();
    expect(cache.has("a")).toBe(false);
    await expect(cache.get("a", async () => samples(1))).resolves.toHaveLength(MB / 4);
  });

  it("does not re-add an entry dropped while it was still decoding", async () => {
    const cache = new SampleCache(100 * MB);
    let finish!: (x: Float32Array) => void;
    const pending = cache.get("a", () => new Promise<Float32Array>(resolve => { finish = resolve; }));
    cache.drop("a");
    finish(samples(5));
    await pending; await settle();
    expect(cache.has("a")).toBe(false);
    expect(cache.bytes).toBe(0);
  });

  it("drops one id and clears all", async () => {
    const cache = new SampleCache(100 * MB);
    await cache.get("a", async () => samples(1)); await cache.get("b", async () => samples(1)); await settle();
    cache.drop("a");
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });
});
