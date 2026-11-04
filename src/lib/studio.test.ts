import { describe, expect, it } from "vitest";
import { MIN_TIMELINE, audible, clipWindow, encodeWav, joinChunks, stemChannels, takeOffset, timelineLength } from "@/lib/studio";

describe("clipWindow", () => {
  it("waits for a clip that starts later", () => expect(clipWindow(4, 10, 1)).toEqual({ delay: 3, bufferOffset: 0 }));
  it("starts inside a clip the playhead is already in", () => expect(clipWindow(4, 10, 6)).toEqual({ delay: 0, bufferOffset: 2 }));
  it("skips a clip that is over", () => expect(clipWindow(4, 10, 14)).toBeNull());
  it("trims the head of a clip pulled before zero", () => expect(clipWindow(-0.2, 5, 0)).toEqual({ delay: 0, bufferOffset: 0.2 }));
});

describe("takeOffset", () => {
  it("pulls the take earlier by the latency", () => expect(takeOffset(8, 0.12)).toBeCloseTo(7.88));
});

describe("audible", () => {
  it("plays what is not muted", () => expect(audible([false, true], [false, false], 0)).toBe(true));
  it("silences a muted lane", () => expect(audible([false, true], [false, false], 1)).toBe(false));
  it("plays only the soloed lanes", () => {
    expect(audible([false, false], [false, true], 0)).toBe(false);
    expect(audible([true, false], [false, true], 1)).toBe(true);
  });
});

describe("timelineLength", () => {
  it("holds the minimum for short clips", () => expect(timelineLength([{ offset: 0, duration: 5 }])).toBe(MIN_TIMELINE));
  it("grows to the end of the last clip", () => expect(timelineLength([{ offset: 10, duration: 200 }, { offset: 0, duration: 30 }])).toBe(210));
});

describe("joinChunks", () => {
  it("concatenates in order", () => expect([...joinChunks([Float32Array.of(1, 2), Float32Array.of(3)])]).toEqual([1, 2, 3]));
});

describe("stemChannels", () => {
  const eight = Array.from({ length: 8 }, (_, i) => Float32Array.of(i));
  it("takes the pair of a stem", () => expect(stemChannels(eight, 2).map(c => c[0])).toEqual([4, 5]));
  it("rejects a file without eight channels", () => expect(() => stemChannels(eight.slice(0, 2), 0)).toThrow());
});

describe("encodeWav", () => {
  it("writes a 16-bit PCM header and the samples", async () => {
    const blob = encodeWav({ numberOfChannels: 1, length: 3, sampleRate: 44100, getChannelData: () => Float32Array.of(0, 1, -1) });
    const view = new DataView(await blob.arrayBuffer());
    expect(blob.size).toBe(44 + 6);
    expect(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))).toBe("RIFF");
    expect(view.getUint32(24, true)).toBe(44100);
    expect(view.getInt16(46, true)).toBe(0x7fff);
    expect(view.getInt16(48, true)).toBe(-0x8000);
  });
});
