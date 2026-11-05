import { OfflineAudioContext } from "node-web-audio-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sine, toneLevel } from "@/lib/mix-render";
import { covers, renderPreview, type AudioWindow } from "@/lib/transition-preview";
import type { TransitionPlan } from "@/lib/types";

const RATE = 22050;
const globals = globalThis as { OfflineAudioContext?: unknown };
const before = globals.OfflineAudioContext;
beforeAll(() => { globals.OfflineAudioContext = OfflineAudioContext; });
afterAll(() => { globals.OfflineAudioContext = before; });

const win = (hz: number, seconds: number, start = 0): AudioWindow => ({ start, end: start + seconds, rate: RATE, channels: [sine(hz, 0.3, seconds, RATE)] });
const plan: TransitionPlan = { fromId: "a", toId: "b", outAt: 20, inAt: 4, bars: 4, volume: "smooth", eq: "none", effect: "none", preset: "blend" };

describe("transition preview", () => {
  it("plays the old track, blends, then the new one", async () => {
    // A at 220 Hz from 16 s, B at 660 Hz from 0 s: 4 s lead-in, 8 s blend, 4 s tail.
    const out = await renderPreview({ plan, a: win(220, 40), b: win(660, 40), aStart: 16, bStart: 0, aRate: 1, bRate: 1,
      lead: 4, duration: 8, seconds: 16, aTrim: 0, bTrim: 0 });
    expect(out.duration).toBeCloseTo(16, 1);
    const x = out.getChannelData(0);
    const at = (s: number, hz: number) => toneLevel(x, RATE, hz, s, s + 0.5);
    expect(at(1, 220)).toBeGreaterThan(at(1, 660) * 10);
    expect(at(14, 660)).toBeGreaterThan(at(14, 220) * 10);
  });

  it("shifts the pitch of the old track without changing its length", async () => {
    // +12 st held from the start of the blend: the 220 Hz outgoing track reads as 440 Hz while it leaves.
    const shifted: TransitionPlan = { ...plan, volume: "linear", pitch: { out: [{ t: 0.01, g: 1 }, { t: 0.99, g: 1 }], in: [] } };
    const out = await renderPreview({ plan: shifted, a: win(220, 40), b: win(660, 40), aStart: 16, bStart: 0, aRate: 1, bRate: 1,
      lead: 4, duration: 8, seconds: 16, aTrim: 0, bTrim: 0 });
    const x = out.getChannelData(0);
    const at = (s: number, hz: number) => toneLevel(x, RATE, hz, s, s + 0.5);
    expect(out.duration).toBeCloseTo(16, 1);
    expect(at(1, 220)).toBeGreaterThan(at(1, 440) * 10);
    expect(at(6, 440)).toBeGreaterThan(at(6, 220) * 3);
  });

  it("plays a speed move by resampling and takes the pitch back out", async () => {
    // The old track at -10% speed would read 270 Hz; the shifter returns it to 300 Hz.
    const slow: TransitionPlan = { ...plan, volume: "linear", speed: { out: [{ t: 0.01, g: 0.3 }, { t: 0.99, g: 0.3 }], in: [] } };
    const out = await renderPreview({ plan: slow, a: win(300, 40), b: win(660, 40), aStart: 16, bStart: 0, aRate: 1, bRate: 1,
      lead: 4, duration: 8, seconds: 16, aTrim: 0, bTrim: 0 });
    const x = out.getChannelData(0);
    const at = (s: number, hz: number) => toneLevel(x, RATE, hz, s, s + 0.5);
    expect(at(6, 300)).toBeGreaterThan(at(6, 270) * 3);
  });

  it("knows when a decoded window still covers a stretch", () => {
    const w = win(220, 60, 10);
    expect(covers(w, 20, 40, 300)).toBe(true);
    expect(covers(w, 5, 40, 300)).toBe(false);
    expect(covers(w, 20, 80, 300)).toBe(false);
    // The end of the track caps what has to be held.
    expect(covers({ ...w, end: 70 }, 20, 90, 70)).toBe(true);
  });
});
