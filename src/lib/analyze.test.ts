import { OfflineAudioContext } from "node-web-audio-api";
import { beforeAll, describe, expect, it } from "vitest";
import { SAMPLE_RATE, analyzeFile, analyzeSamples } from "@/lib/analyze";
import { kicks, noise, tones, wav } from "@/lib/test-tracks";

beforeAll(() => {
  // analyzeFile decodes through the page's OfflineAudioContext; the Rust implementation stands in for it here.
  (globalThis as { OfflineAudioContext?: unknown }).OfflineAudioContext = OfflineAudioContext;
});

/** Distance between two beat phases, seconds, across the wrap. */
const phaseOff = (a: number, b: number, beat: number) => {
  const d = (((a - b) % beat) + beat) % beat;
  return Math.min(d, beat - d);
};

describe("tempo and beat grid", () => {
  it.each([128, 124, 100, 140, 174])("finds %s bpm", bpm => {
    const result = analyzeSamples(kicks(bpm, 60, SAMPLE_RATE, 0.3));
    expect(result.bpm).not.toBeNull();
    expect(Math.abs(result.bpm! - bpm)).toBeLessThan(0.5);
  });

  it("lands the grid on the beats", () => {
    const result = analyzeSamples(kicks(126, 60, SAMPLE_RATE, 0.37));
    expect(phaseOff(result.firstBeat, 0.37, 60 / 126)).toBeLessThan(0.02);
  });

  it("reads a tempo under the search range at double time", () => {
    const result = analyzeSamples(kicks(62, 60, SAMPLE_RATE));
    expect(result.bpm).not.toBeNull();
    expect(Math.abs(result.bpm! - 124)).toBeLessThan(0.5);
  });

  it("reports how clearly the beat stands out", () => {
    expect(analyzeSamples(kicks(128, 60, SAMPLE_RATE)).pulse).toBeGreaterThan(10);
  });

  it("gives no tempo for silence, a held tone or noise", () => {
    const random = noise(5);
    for (const x of [new Float32Array(30 * SAMPLE_RATE), tones([[440, 0.3]], 30, SAMPLE_RATE), new Float32Array(30 * SAMPLE_RATE).map(() => 0.3 * random())]) {
      const result = analyzeSamples(x);
      expect(result.bpm).toBeNull();
      expect(result.pulse).toBeLessThan(3);
    }
  });

  it("gives no tempo for a clip too short to have one, without failing", () => {
    const result = analyzeSamples(kicks(128, 5, SAMPLE_RATE));
    expect(result.bpm).toBeNull();
    expect(result.duration).toBeCloseTo(5, 3);
  });
});

describe("key, loudness and energy", () => {
  it("hears A minor and C major", () => {
    // Triads with the tonic loudest, as a bass line would put it.
    const am = analyzeSamples(tones([[110, 0.3], [220, 0.2], [261.63, 0.12], [329.63, 0.12]], 20, SAMPLE_RATE));
    expect(am.key).toBe("Am");
    expect(am.camelot).toBe("8A");
    const c = analyzeSamples(tones([[130.81, 0.3], [261.63, 0.2], [329.63, 0.12], [392, 0.12]], 20, SAMPLE_RATE));
    expect(c.key).toBe("C");
    expect(c.camelot).toBe("8B");
  });

  it("measures integrated loudness of a 1 kHz sine within half an LU", () => {
    // A 1 kHz sine in both channels at amplitude 0.1 reads -20 LUFS on a BS.1770 meter.
    const result = analyzeSamples(tones([[1000, 0.1]], 20, SAMPLE_RATE));
    expect(Math.abs(result.lufs - -20)).toBeLessThan(0.5);
  });

  it("follows the level second by second", () => {
    const x = tones([[200, 0.5]], 20, SAMPLE_RATE);
    for (let i = 10 * SAMPLE_RATE; i < x.length; i++) x[i] *= 0.1;
    const { energy } = analyzeSamples(x);
    expect(energy[5] - energy[15]).toBeCloseTo(20, 0);
  });
});

describe("files", () => {
  it("decodes and analyzes a real WAV file", async () => {
    const result = await analyzeFile(wav(kicks(128, 40, 44100, 0.2), 44100));
    expect(result.duration).toBeCloseTo(40, 1);
    expect(Math.abs(result.bpm! - 128)).toBeLessThan(0.5);
    expect(result.peaks).toHaveLength(160);
  });

  it("rejects a corrupt file instead of inventing an analysis", async () => {
    const random = noise(3);
    const garbage = new Uint8Array(4096).map(() => Math.floor((random() + 1) * 128));
    await expect(analyzeFile(new Blob([garbage]))).rejects.toBeTruthy();
  });

  it("rejects an empty file and a format it cannot read", async () => {
    await expect(analyzeFile(new Blob([]))).rejects.toBeTruthy();
    await expect(analyzeFile(new Blob(["not audio, just text"], { type: "text/plain" }))).rejects.toBeTruthy();
  });
});
