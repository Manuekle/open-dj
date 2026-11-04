import { describe, expect, it } from "vitest";
import { autotune, correctionCents, detectPitch, hzToMidi, nearestInScale } from "@/lib/autotune";

const RATE = 44100;
/** A voiced-like tone: a fundamental with a few harmonics, which is what the pitch marks need. */
const tone = (hz: number, seconds = 1) => {
  const x = new Float32Array(Math.round(RATE * seconds));
  for (let i = 0; i < x.length; i++) x[i] = 0.4 * Math.sin(2 * Math.PI * hz * i / RATE) + 0.2 * Math.sin(4 * Math.PI * hz * i / RATE) + 0.1 * Math.sin(6 * Math.PI * hz * i / RATE);
  return x;
};
const median = (f0: Float32Array) => { const v = [...f0].filter(Boolean).sort((a, b) => a - b); return v[v.length >> 1] ?? 0; };
const cents = (a: number, b: number) => 1200 * Math.log2(a / b);

describe("nearestInScale", () => {
  it("snaps C# to C in C major", () => expect(nearestInScale(60.6, 0, "major")).toBe(60));
  it("keeps a note already in the scale", () => expect(nearestInScale(64.1, 0, "major")).toBe(64));
  it("follows the key", () => expect(nearestInScale(61, 2, "major")).toBe(61)); // C# is the leading tone of D major
  it("snaps to any semitone when chromatic", () => expect(nearestInScale(61.4, 0, "chromatic")).toBe(61));
});

describe("detectPitch", () => {
  it("finds the fundamental of a tone", async () => {
    const track = await detectPitch(tone(220), RATE);
    expect(Math.abs(cents(median(track.f0), 220))).toBeLessThan(15);
  });
  it("calls silence unvoiced", async () => {
    const track = await detectPitch(new Float32Array(RATE), RATE);
    expect(track.f0.every(v => v === 0)).toBe(true);
  });
});

describe("correctionCents", () => {
  it("pulls a sharp note down to the note, scaled by amount", () => {
    const track = { f0: Float32Array.of(450, 450), hop: 512, delay: 0 };
    const full = correctionCents(track, RATE, { key: 0, scale: "chromatic", speed: 0, amount: 1 });
    expect(full[0]).toBeCloseTo(-39.1, 0);
    const half = correctionCents(track, RATE, { key: 0, scale: "chromatic", speed: 0, amount: 0.5 });
    expect(half[0]).toBeCloseTo(-19.6, 0);
  });
  it("glides when the speed is slow", () => {
    const track = { f0: Float32Array.of(450, 450, 450), hop: 512, delay: 0 };
    const slow = correctionCents(track, RATE, { key: 0, scale: "chromatic", speed: 200, amount: 1 });
    expect(Math.abs(slow[0])).toBeLessThan(Math.abs(slow[2]));
    expect(Math.abs(slow[2])).toBeLessThan(39.1);
  });
  it("leaves unvoiced frames alone", () => {
    const out = correctionCents({ f0: Float32Array.of(0, 450), hop: 512, delay: 0 }, RATE, { key: 0, scale: "chromatic", speed: 0, amount: 1 });
    expect(out[0]).toBe(0);
  });
});

describe("autotune", () => {
  it("moves a sharp tone onto the note and keeps its length", async () => {
    const x = tone(450);
    const out = await autotune(x, RATE, { key: 0, scale: "chromatic", speed: 0, amount: 1 });
    expect(out.length).toBe(x.length);
    const heard = median((await detectPitch(out, RATE)).f0);
    expect(Math.abs(cents(heard, 440))).toBeLessThan(15);
  });
  it("snaps C# to C in C major", async () => {
    const hz = 440 * Math.pow(2, (60.6 - 69) / 12);
    const out = await autotune(tone(hz), RATE, { key: 0, scale: "major", speed: 0, amount: 1 });
    const heard = median((await detectPitch(out, RATE)).f0);
    expect(Math.abs(hzToMidi(heard) - 60)).toBeLessThan(0.2);
  });
  it("passes silence through unchanged", async () => {
    const x = new Float32Array(RATE / 2);
    expect([...(await autotune(x, RATE, { key: 0, scale: "major", speed: 0, amount: 1 }))].every(v => v === 0)).toBe(true);
  });
});
