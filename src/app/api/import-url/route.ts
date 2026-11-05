import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/* Imports one track from a URL, run on the machine serving the app: yt-dlp (the maintained youtube-dl fork) downloads the
   best audio stream as it is published, with no re-encoding, and ffmpeg cuts it to the asked range by copying the stream.
   Transcoding to MP3 would add a second lossy generation and make the file larger (a V0 MP3 is near twice the size of
   the AAC or Opus it came from). AAC in M4A is preferred because every browser plays it; Opus or MP3 are taken when that
   is all the site offers. POST { url, start?, end? } answers the audio as the body, its file name in the x-file-name
   header (percent-encoded) and its type in content-type, so the client imports it like a dropped file.
   Only download audio you have the rights to: public domain, Creative Commons, or your own. */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const YTDLP = process.env.YTDLP_BIN ?? "yt-dlp";
const FFMPEG = process.env.FFMPEG_BIN ?? "ffmpeg";
const MAX_BYTES = 150 * 1024 * 1024;
/** "MM:SS", "HH:MM:SS" or plain seconds, optionally fractional. */
const STAMP = /^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/;

function run(cmd: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let tail = "";
    child.stderr.on("data", (chunk: Buffer) => { tail = (tail + chunk.toString()).slice(-2000); });
    child.on("error", e => reject((e as NodeJS.ErrnoException).code === "ENOENT" ? new Error(`${path.basename(cmd)} is not installed.`) : e));
    child.on("close", code => code === 0 ? resolve() : reject(new Error(tail.trim().split("\n").pop() || `${path.basename(cmd)} exited with ${code}`)));
  });
}

/** Audio containers yt-dlp may hand back, with the type the browser expects for each. */
const TYPES: Record<string, string> = {
  ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".aac": "audio/aac", ".opus": "audio/ogg", ".ogg": "audio/ogg",
  ".webm": "audio/webm", ".mp3": "audio/mpeg", ".flac": "audio/flac", ".wav": "audio/wav",
};

/** Seconds from a timestamp, or null when it is not one. */
function seconds(stamp: string): number | null {
  if (!STAMP.test(stamp)) return null;
  return stamp.split(":").reduce((total, part) => total * 60 + Number(part), 0);
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { url?: unknown; start?: unknown; end?: unknown } | null;
  const raw = typeof body?.url === "string" ? body.url.trim() : "";
  let url: URL;
  try { url = new URL(raw); } catch { return Response.json({ error: "Paste a valid link." }, { status: 400 }); }
  if (url.protocol !== "http:" && url.protocol !== "https:") return Response.json({ error: "Only http and https links work." }, { status: 400 });

  const start = typeof body?.start === "string" && body.start.trim() ? body.start.trim() : "";
  const end = typeof body?.end === "string" && body.end.trim() ? body.end.trim() : "";
  const from = start ? seconds(start) : 0;
  const to = end ? seconds(end) : null;
  if (from === null || (end && to === null)) return Response.json({ error: "Use MM:SS or HH:MM:SS for the start and end." }, { status: 400 });
  if (to !== null && to <= from) return Response.json({ error: "The end must come after the start." }, { status: 400 });

  const dir = await mkdtemp(path.join(tmpdir(), "shift-url-"));
  try {
    // "--" ends the options, so a link can never be read as one. A playlist link downloads only its video. -x keeps
    // the audio stream of a video as it is: no --audio-format, so nothing is transcoded.
    await run(YTDLP, ["--no-playlist", "--no-progress", "-f", "bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio/best", "-x",
      "--max-filesize", String(MAX_BYTES), "--trim-filenames", "120", "-o", path.join(dir, "%(title)s.%(ext)s"), "--", url.toString()]);
    const name = (await readdir(dir)).find(file => path.extname(file).toLowerCase() in TYPES);
    if (!name) return Response.json({ error: "No audio came back from that link." }, { status: 502 });
    const ext = path.extname(name), type = TYPES[ext.toLowerCase()];

    let file = path.join(dir, name);
    const trimmed = from > 0 || to !== null;
    if (trimmed) {
      const cut = path.join(dir, `cut-${name}`);
      // A stream copy: the cut lands on the nearest audio frame (a few milliseconds) and the quality is untouched.
      await run(FFMPEG, ["-y", "-loglevel", "error", "-ss", String(from), "-i", file, ...(to !== null ? ["-t", String(to - from)] : []),
        "-map", "0:a:0", "-c:a", "copy", cut]);
      file = cut;
    }
    const audio = await readFile(file);
    if (!audio.byteLength) return Response.json({ error: "That range holds no audio." }, { status: 422 });
    const out = trimmed ? `${name.slice(0, -ext.length)} - TRIM${ext}` : name;
    return new Response(new Uint8Array(audio), { headers: { "content-type": type, "content-length": String(audio.byteLength), "x-file-name": encodeURIComponent(out) } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Import failed." }, { status: 502 });
  } finally {
    void rm(dir, { recursive: true, force: true });
  }
}
