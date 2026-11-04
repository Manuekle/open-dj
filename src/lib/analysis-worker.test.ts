import { OfflineAudioContext } from "node-web-audio-api";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { answer, type AnalysisReply, type AnalysisRequest } from "@/lib/analyze-dsp";
import { kicks, tones, wav } from "@/lib/test-tracks";

/** Stands in for the browser's Worker: moves what it is sent (detaching it here, as postMessage does) and answers with
    the real analysis, in order, in reverse, with an error, or by dying. */
class FakeWorker {
  static mode: "answer" | "reverse" | "error" | "crash" = "answer";
  static moved: ArrayBuffer[] = [];
  static held: AnalysisRequest[] = [];
  onmessage: ((event: { data: AnalysisReply }) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage(message: AnalysisRequest, transfer: ArrayBuffer[]) {
    const request = structuredClone(message, { transfer });
    FakeWorker.moved.push(...transfer);
    const reply = (data: AnalysisReply) => setTimeout(() => this.onmessage?.({ data }));
    if (FakeWorker.mode === "answer") reply(answer(request));
    if (FakeWorker.mode === "error") reply({ id: request.id, error: "boom" });
    if (FakeWorker.mode === "crash") setTimeout(() => this.onerror?.());
    if (FakeWorker.mode === "reverse" && FakeWorker.held.push(request) === 2) FakeWorker.held.reverse().forEach(r => reply(answer(r)));
  }
  terminate() {}
}

const globals = globalThis as { OfflineAudioContext?: unknown; Worker?: unknown };
beforeAll(() => { globals.OfflineAudioContext = OfflineAudioContext; });
beforeEach(() => {
  vi.resetModules();
  FakeWorker.mode = "answer"; FakeWorker.moved = []; FakeWorker.held = [];
  globals.Worker = FakeWorker;
});
afterEach(() => { delete globals.Worker; });
/** A fresh copy of lib/analyze, so each test starts without a worker. */
const analyze = () => import("@/lib/analyze");

describe("analysis worker", () => {
  it("moves the samples to the worker and gives the same analysis as running here", async () => {
    const file = wav(kicks(128, 30, 44100, 0.1), 44100);
    const inWorker = await (await analyze()).analyzeFile(file);
    expect(FakeWorker.moved).toHaveLength(1);
    expect(FakeWorker.moved[0].byteLength).toBe(0); // moved, not copied

    delete globals.Worker;
    vi.resetModules();
    const here = await (await analyze()).analyzeFile(file);
    expect(inWorker).toEqual(here);
    expect(Math.abs(inWorker.bpm! - 128)).toBeLessThan(0.5);
  });

  it("gives each caller its own answer when replies come back out of order", async () => {
    FakeWorker.mode = "reverse";
    const { analyzeFile } = await analyze();
    const [a, b] = await Promise.all([analyzeFile(wav(kicks(128, 30, 44100), 44100)), analyzeFile(wav(kicks(100, 30, 44100), 44100))]);
    expect(Math.abs(a.bpm! - 128)).toBeLessThan(0.5);
    expect(Math.abs(b.bpm! - 100)).toBeLessThan(0.5);
  });

  it("runs the job here when the worker dies holding it", async () => {
    FakeWorker.mode = "crash";
    const { analyzeFile } = await analyze();
    const result = await analyzeFile(wav(kicks(124, 30, 44100), 44100));
    expect(Math.abs(result.bpm! - 124)).toBeLessThan(0.5);
    // Later jobs skip the dead worker.
    FakeWorker.moved = [];
    await analyzeFile(wav(kicks(124, 20, 44100), 44100));
    expect(FakeWorker.moved).toHaveLength(0);
  });

  it("rejects when the worker reports an error", async () => {
    FakeWorker.mode = "error";
    const { analyzeFile } = await analyze();
    await expect(analyzeFile(wav(kicks(124, 20, 44100), 44100))).rejects.toThrow("boom");
  });

  it("runs here where there is no Worker", async () => {
    delete globals.Worker;
    const result = await (await analyze()).analyzeFile(wav(kicks(126, 20, 44100), 44100));
    expect(Math.abs(result.bpm! - 126)).toBeLessThan(0.5);
  });

  it("measures each stem of a stems file in the worker, one pair at a time", async () => {
    const { analyzeStems } = await analyze();
    // A 0.5 sine on all eight channels: every stem reads its mean square, 0.125, or -9 dB.
    const levels = await analyzeStems(wav(tones([[220, 0.5]], 6, 44100), 44100, 8));
    expect(levels).toHaveLength(4);
    expect(FakeWorker.moved).toHaveLength(8);
    for (const stem of levels) {
      expect(stem).toHaveLength(6);
      for (const db of stem) expect(db).toBeCloseTo(-9.0, 0);
    }
  });

  it("refuses a file that is not a stems file", async () => {
    const { analyzeStems } = await analyze();
    await expect(analyzeStems(wav(tones([[220, 0.5]], 2, 44100), 44100, 2))).rejects.toThrow("Not a stems file");
  });
});
