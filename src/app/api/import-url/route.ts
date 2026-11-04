import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/* Imports one track from a URL, run on the machine serving the app: yt-dlp (the maintained youtube-dl fork) downloads the
   best audio as MP3, and ffmpeg cuts it to the asked range. POST { url, start?, end? } answers the MP3 as the body, its
   file name in the x-file-name header (percent-encoded), so the client imports it like a dropped file.
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

  const dir = await mkdtemp(path.join(tmpdir(), "open-dj-url-"));
  try {
    // "--" ends the options, so a link can never be read as one. A playlist link downloads only its video.
    await run(YTDLP, ["--no-playlist", "--no-progress", "-x", "--audio-format", "mp3", "--audio-quality", "0",
      "--max-filesize", String(MAX_BYTES), "--trim-filenames", "120", "-o", path.join(dir, "%(title)s.%(ext)s"), "--", url.toString()]);
    const name = (await readdir(dir)).find(file => file.endsWith(".mp3"));
    if (!name) return Response.json({ error: "No audio came back from that link." }, { status: 502 });

    let file = path.join(dir, name);
    if (from > 0 || to !== null) {
      const cut = path.join(dir, `cut-${name}`);
      await run(FFMPEG, ["-y", "-loglevel", "error", "-i", file, "-ss", String(from), ...(to !== null ? ["-to", String(to)] : []), "-c:a", "libmp3lame", "-q:a", "0", cut]);
      file = cut;
    }
    const audio = await readFile(file);
    if (!audio.byteLength) return Response.json({ error: "That range holds no audio." }, { status: 422 });
    const out = from > 0 || to !== null ? name.replace(/\.mp3$/, " - TRIM.mp3") : name;
    return new Response(new Uint8Array(audio), { headers: { "content-type": "audio/mpeg", "content-length": String(audio.byteLength), "x-file-name": encodeURIComponent(out) } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Import failed." }, { status: 502 });
  } finally {
    void rm(dir, { recursive: true, force: true });
  }
}
