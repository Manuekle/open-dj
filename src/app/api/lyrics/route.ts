import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { parseWhisper, type Lyrics } from "@/lib/lyrics";

/* Lyrics with a time on every word, for karaoke, from whisper.cpp (https://github.com/ggml-org/whisper.cpp) run on the
   machine serving the app. POST the audio as the body: it queues a job and answers its id. GET ?job=<id> reads its
   progress, and once done, GET ?job=<id>&file=1 answers the lyrics as JSON and forgets the job. GET alone says whether
   whisper.cpp and a model are installed (npm run setup:whisper). One job runs at a time: Whisper takes the whole GPU or every core.

   Headers of the POST: x-file-name (percent-encoded; its extension tells the format), x-language ("auto" by default, or
   a code like "en" or "es") and x-source: "vocals" when the body is a track's 8-channel stems file, so only the vocals
   pair is transcribed. That is cleaner than the full mix: no drums to mistake for words, and the times are tighter. */

export const dynamic = "force-dynamic";

const WHISPER = process.env.WHISPER_BIN ?? "whisper-cli";
const MODEL = process.env.WHISPER_MODEL ?? path.join(process.cwd(), ".whisper", "ggml-small.bin");
const FFMPEG = process.env.FFMPEG_BIN ?? "ffmpeg";
const MAX_BYTES = 150 * 1024 * 1024;
/** A job nobody asked about for this long is dropped with its files. */
const STALE_MS = 30 * 60 * 1000;
const EXTENSION = /^\.(mp3|wav|m4a|mp4|ogg|opus|webm|flac|aac)$/;
const LANGUAGE = /^(?:auto|[a-z]{2,3})$/;

type Job = { state: "queued" | "running" | "done" | "failed"; progress: number; error?: string; dir: string; touched: number; lyrics?: Lyrics };
// On globalThis, so a dev-server reload keeps the jobs already running.
const store = globalThis as typeof globalThis & { lyricJobs?: Map<string, Job>; lyricQueue?: Promise<void> };
const jobs = store.lyricJobs ??= new Map<string, Job>();

const exists = (file: string) => access(file).then(() => true, () => false);
/** The whisper binary, by path or on PATH. */
async function binary() {
  if (WHISPER.includes("/")) return exists(WHISPER);
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) if (dir && await exists(path.join(dir, WHISPER))) return true;
  return false;
}
const installed = async () => (await binary()) && await exists(MODEL);

function run(cmd: string, args: string[], onOutput?: (text: string) => void) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const read = (chunk: Buffer) => { const text = chunk.toString(); tail = (tail + text).slice(-2000); onOutput?.(text); };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", e => reject((e as NodeJS.ErrnoException).code === "ENOENT" ? new Error(`${path.basename(cmd)} is not installed.`) : e));
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited with ${code}: ${tail.trim().split("\n").pop() ?? ""}`)));
  });
}

async function transcribe(job: Job, input: string, source: "mix" | "vocals", language: string) {
  job.state = "running";
  // Whisper reads 16 kHz mono. The stems file holds the vocals as its first stereo pair (channels 0 and 1).
  const wav = path.join(job.dir, "audio.wav");
  const filter = source === "vocals" ? ["-af", "pan=mono|c0=0.5*c0+0.5*c1"] : ["-ac", "1"];
  await run(FFMPEG, ["-y", "-loglevel", "error", "-i", input, "-vn", ...filter, "-ar", "16000", "-c:a", "pcm_s16le", wav]);
  job.progress = 0.02;
  // One word per entry (-ml 1 with -sow) gives a start and an end for each. No context carried between windows (-mc 0)
  // stops the repetition loops Whisper falls into on sung audio; -sns drops the music and applause tags.
  const out = path.join(job.dir, "out");
  const threads = Math.max(2, Math.min(8, availableParallelism() - 1));
  await run(WHISPER, ["-m", MODEL, "-f", wav, "-l", language, "-ml", "1", "-sow", "-mc", "0", "-sns", "-pp", "-ojf", "-of", out, "-t", String(threads)], text => {
    const all = [...text.matchAll(/progress\s*=\s*(\d+)%/g)];
    if (all.length) job.progress = Math.max(job.progress, 0.02 + Number(all[all.length - 1][1]) / 100 * 0.97);
  });
  const { language: heard, words } = parseWhisper(JSON.parse(await readFile(`${out}.json`, "utf8")));
  job.lyrics = { version: 1, language: heard || (language === "auto" ? "" : language), source, words };
  job.progress = 1;
  job.state = "done";
}

function sweep() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.state !== "running" && job.state !== "queued" && now - job.touched > STALE_MS) { jobs.delete(id); void rm(job.dir, { recursive: true, force: true }); }
  }
}

export async function POST(request: Request) {
  sweep();
  if (!await installed()) return Response.json({ error: "Whisper is not installed. Run npm run setup:whisper." }, { status: 503 });
  const body = await request.arrayBuffer();
  if (!body.byteLength) return Response.json({ error: "Send the audio file as the request body." }, { status: 400 });
  if (body.byteLength > MAX_BYTES) return Response.json({ error: "The file is larger than 150 MB." }, { status: 413 });
  const name = decodeURIComponent(request.headers.get("x-file-name") ?? "");
  const ext = EXTENSION.test(path.extname(name).toLowerCase()) ? path.extname(name).toLowerCase() : ".audio";
  const asked = (request.headers.get("x-language") ?? "auto").toLowerCase();
  const language = LANGUAGE.test(asked) ? asked : "auto";
  const source = request.headers.get("x-source") === "vocals" ? "vocals" : "mix";

  const id = crypto.randomUUID();
  const dir = await mkdtemp(path.join(tmpdir(), "open-dj-lyrics-"));
  const input = path.join(dir, `track${ext}`);
  await writeFile(input, Buffer.from(body));
  const job: Job = { state: "queued", progress: 0, dir, touched: Date.now() };
  jobs.set(id, job);
  store.lyricQueue = (store.lyricQueue ?? Promise.resolve()).then(() => transcribe(job, input, source, language)).catch((e: unknown) => {
    job.state = "failed";
    job.error = e instanceof Error ? e.message : "Transcription failed";
  }).finally(() => { job.touched = Date.now(); void rm(input, { force: true }); });
  return Response.json({ job: id }, { status: 202 });
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const id = params.get("job");
  if (!id) return Response.json({ available: await installed() });
  const job = jobs.get(id);
  if (!job) return Response.json({ error: "No such job" }, { status: 404 });
  job.touched = Date.now();
  if (!params.has("file")) return Response.json({ state: job.state, progress: job.progress, error: job.error });
  if (job.state !== "done" || !job.lyrics) return Response.json({ error: "The lyrics are not ready" }, { status: 409 });
  const lyrics = job.lyrics;
  jobs.delete(id);
  void rm(job.dir, { recursive: true, force: true });
  return Response.json(lyrics);
}
