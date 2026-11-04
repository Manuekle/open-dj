import { describe, expect, it } from "vitest";
import { gridFromTempo, parseBpm, tapBpm } from "@/lib/manual-tempo";

describe("parseBpm", () => {
  it("reads numbers, with a comma too, and rounds to 0.01", () => {
    expect(parseBpm("128")).toBe(128);
    expect(parseBpm(" 127,555 ")).toBe(127.56);
  });
  it("rejects what is not a tempo", () => {
    for (const bad of ["", "abc", "0", "20", "300", "NaN"]) expect(parseBpm(bad)).toBeNull();
  });
});

describe("gridFromTempo", () => {
  it("lays a steady grid of one tempo over the track", () => {
    const r = gridFromTempo(120, 0.25, 10);
    expect(r.grid).toBe("steady");
    expect(r.beats[0]).toBe(0.25);
    expect(r.beats[1] - r.beats[0]).toBeCloseTo(0.5, 3);
    expect(r.beats.at(-1)!).toBeLessThan(10);
    expect(r.strength).toHaveLength(r.beats.length);
  });
  it("folds a late first beat into the first beat length", () => {
    expect(gridFromTempo(120, 1.3, 10).beats[0]).toBeCloseTo(0.3, 3);
  });
  it("starts at zero without a usable first beat", () => {
    expect(gridFromTempo(120, -1, 5).beats[0]).toBe(0);
    expect(gridFromTempo(120, NaN, 5).beats[0]).toBe(0);
  });
});

describe("tapBpm", () => {
  it("needs three taps", () => { expect(tapBpm([0, 0.5])).toBeNull(); });
  it("reads the median gap", () => { expect(tapBpm([0, 0.5, 1, 1.5, 2])).toBe(120); });
  it("ignores an outlier tap", () => { expect(tapBpm([0, 0.5, 1.2, 1.5, 2])).toBe(120); });
  it("starts over after a pause", () => { expect(tapBpm([0, 5, 5.5, 6, 6.5])).toBe(120); });
  it("rejects a tempo out of range", () => { expect(tapBpm([0, 1.9, 3.8])).toBeNull(); });
});
