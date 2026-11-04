import { describe, expect, it } from "vitest";
import { peaksOf } from "./stem-peaks";

describe("peaksOf", () => {
  it("takes the extremes of both channels per bucket", () => {
    const left = Float32Array.from([0.2, -0.5, 0.1, 0.1]), right = Float32Array.from([0.9, 0, 0, -0.3]);
    const { min, max } = peaksOf(left, right, 2);
    expect([...max]).toEqual([expect.closeTo(0.9, 5), expect.closeTo(0.1, 5)]);
    expect([...min]).toEqual([expect.closeTo(-0.5, 5), expect.closeTo(-0.3, 5)]);
  });
  it("gives silence flat peaks", () => {
    const z = new Float32Array(100);
    const { min, max } = peaksOf(z, z, 10);
    expect(Math.max(...max)).toBe(0);
    expect(Math.min(...min)).toBe(0);
  });
  it("covers a signal shorter than the bucket count", () => {
    const x = Float32Array.from([0.5, -0.5]);
    const { min, max } = peaksOf(x, x, 8);
    expect(min.length).toBe(8);
    expect(Math.max(...max)).toBe(0.5);
  });
});
