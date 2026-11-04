import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaLoadError, whenMediaReady, type MediaLike } from "@/lib/media-ready";

class FakeMedia extends EventTarget implements MediaLike {
  readyState = 0;
  duration = NaN;
  error: { message?: string } | null = null;
  ready(duration = 200) { this.readyState = 1; this.duration = duration; this.dispatchEvent(new Event("loadedmetadata")); }
  fail(message?: string) { this.error = { message }; this.dispatchEvent(new Event("error")); }
}

describe("waiting for a deck to load", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("resolves at once when the metadata is already there", async () => {
    const media = new FakeMedia();
    media.readyState = 1; media.duration = 180;
    await expect(whenMediaReady(media)).resolves.toBeUndefined();
  });

  it("resolves when the metadata arrives", async () => {
    const media = new FakeMedia();
    const pending = whenMediaReady(media);
    media.ready();
    await expect(pending).resolves.toBeUndefined();
  });

  it("rejects a file the browser cannot decode, with its message", async () => {
    const media = new FakeMedia();
    const pending = whenMediaReady(media);
    media.fail("Format error");
    await expect(pending).rejects.toThrow("Format error");
  });

  it("rejects at once for a media element already in error", async () => {
    const media = new FakeMedia();
    media.error = {};
    await expect(whenMediaReady(media)).rejects.toBeInstanceOf(MediaLoadError);
  });

  it("rejects a file with no playable length", async () => {
    const media = new FakeMedia();
    const pending = whenMediaReady(media);
    media.ready(0);
    await expect(pending).rejects.toThrow(/no playable audio/);
  });

  it("times out, and says it may be worth retrying", async () => {
    const media = new FakeMedia();
    const pending = whenMediaReady(media, 5000);
    const caught = pending.catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(5000);
    const error = await caught as MediaLoadError;
    expect(error.name).toBe("TimeoutError");
    expect(error.retryable).toBe(true);
  });

  it("does not time out after it has answered", async () => {
    const media = new FakeMedia();
    const pending = whenMediaReady(media, 5000);
    media.ready();
    await pending;
    await vi.advanceTimersByTimeAsync(10000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
