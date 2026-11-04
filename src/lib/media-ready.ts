/* Waits for a media element to have loaded enough to play from: its metadata, with a real duration. A file the browser
   cannot decode fires an error instead, and one that never answers times out, so a damaged track is found while the
   other deck is still playing, not when its turn comes. Works on anything with a media element's shape. */

export interface MediaLike extends EventTarget {
  readyState: number;
  duration: number;
  error: { code?: number; message?: string } | null;
}
const HAVE_METADATA = 1, HAVE_FUTURE_DATA = 3;

export class MediaLoadError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.name = retryable ? "TimeoutError" : "MediaLoadError";
    this.retryable = retryable;
  }
}

export function whenMediaReady(media: MediaLike, timeoutMs = 8000): Promise<void> {
  return waitForMedia(media, timeoutMs, HAVE_METADATA);
}

/** Like whenMediaReady, then gives the element up to `bufferMs` more to buffer enough to play on (a mix start should not
    wait on a fetch). A slow buffer is not an error: the track is playable, so it resolves anyway. */
export async function whenMediaBuffered(media: MediaLike, timeoutMs = 8000, bufferMs = 2500): Promise<void> {
  await waitForMedia(media, timeoutMs, HAVE_METADATA);
  if (media.readyState >= HAVE_FUTURE_DATA) return;
  // Only the wait running out is forgiven; a decode error while buffering is a real failure.
  await waitForMedia(media, bufferMs, HAVE_FUTURE_DATA).catch((e: unknown) => { if (!(e instanceof MediaLoadError && e.retryable)) throw e; });
}

function waitForMedia(media: MediaLike, timeoutMs: number, needed: number): Promise<void> {
  const verdict = (): "ready" | Error | null => {
    if (media.error) return new MediaLoadError(media.error.message || "The browser could not decode this file");
    if (media.readyState >= HAVE_METADATA) {
      if (!(Number.isFinite(media.duration) && media.duration > 0)) return new MediaLoadError("The file has no playable audio");
      return media.readyState >= needed ? "ready" : null;
    }
    return null;
  };
  const now = verdict();
  if (now === "ready") return Promise.resolve();
  if (now) return Promise.reject(now);
  return new Promise<void>((resolve, reject) => {
    // Not abort or emptied: replacing a source fires both right after load(), before the new one answers.
    const events = ["loadedmetadata", "loadeddata", "canplay", "error"] as const;
    const finish = (result: "ready" | Error) => {
      clearTimeout(timer);
      events.forEach(name => media.removeEventListener(name, check));
      if (result === "ready") resolve(); else reject(result);
    };
    const check = () => {
      const v = verdict();
      if (v) finish(v);
    };
    const timer = setTimeout(() => finish(new MediaLoadError("The file took too long to load", true)), timeoutMs);
    events.forEach(name => media.addEventListener(name, check));
  });
}
