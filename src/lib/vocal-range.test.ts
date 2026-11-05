import { describe, expect, it } from "vitest";
import { fitKey, noteName, rangeOf } from "@/lib/vocal-range";

const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);
/** `frames` steady frames on each note, with an unvoiced frame between notes. */
const sung = (notes: number[], frames = 10) => notes.flatMap(n => [...Array<number>(frames).fill(hz(n)), 0]);

describe("noteName", () => {
  it("names MIDI notes in scientific pitch", () => {
    expect(noteName(60)).toBe("C4");
    expect(noteName(57)).toBe("A3");
    expect(noteName(45.4)).toBe("A2");
    expect(noteName(73)).toBe("C#5");
  });
});

describe("rangeOf", () => {
  it("reads the range of a sung scale", () => {
    const r = rangeOf(sung([48, 50, 52, 53, 55, 57, 59, 60]), { low: 0, high: 1 });
    expect(r?.low).toBeCloseTo(48, 5);
    expect(r?.high).toBeCloseTo(60, 5);
  });

  it("ignores blips shorter than a run and octave slips inside a note", () => {
    const f0 = [...sung([50, 52, 55]), hz(80), hz(80), 0, ...Array<number>(8).fill(hz(55)), hz(43), ...Array<number>(8).fill(hz(55))];
    const r = rangeOf(f0, { low: 0, high: 1 });
    expect(r?.high).toBeCloseTo(55, 5);
    expect(r?.low).toBeCloseTo(50, 5);
  });

  it("answers null when too little was sung", () => {
    expect(rangeOf([hz(50), hz(50), 0, 0])).toBeNull();
    expect(rangeOf([])).toBeNull();
  });
});

describe("fitKey", () => {
  it("leaves a song that already fits alone", () => {
    expect(fitKey({ low: 48, high: 67 }, { low: 52, high: 63 })).toEqual({ shift: 0, octave: 0, outside: 0 });
  });

  it("moves a song that sits too high down into the range", () => {
    const fit = fitKey({ low: 50, high: 64 }, { low: 55, high: 68 });
    expect(fit.octave).toBe(0);
    expect(fit.shift).toBeLessThanOrEqual(-4);
    expect(fit.outside).toBe(0);
  });

  it("has a low voice sing a high song an octave down rather than move it far", () => {
    const fit = fitKey({ low: 45, high: 64 }, { low: 60, high: 74 });
    expect(fit.octave).toBe(-1);
    expect(Math.abs(fit.shift)).toBeLessThanOrEqual(1);
    expect(fit.outside).toBe(0);
  });

  it("centres a song wider than the voice and says how much is left outside", () => {
    const fit = fitKey({ low: 55, high: 62 }, { low: 50, high: 66 });
    expect(fit.shift).toBe(0);
    expect(fit.outside).toBeCloseTo(9, 5);
  });

  it("never moves more than the limit", () => {
    const fit = fitKey({ low: 70, high: 80 }, { low: 40, high: 44 }, 5);
    expect(Math.abs(fit.shift)).toBeLessThanOrEqual(5);
  });
});
