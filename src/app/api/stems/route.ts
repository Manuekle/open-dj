import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { STEMS } from "@/lib/types";

/* Stem separation with Demucs (https://github.com/Manuekle/demucs), run on the machine serving the app.
   POST the audio as the body: it queues a job and answers its id. GET ?job=<id> reads its progress, and once done,
   GET ?job=<id>&file=1 answers the stems as one 8-channel FLAC, a stereo pair per stem in STEMS order, and forgets the
   job. GET alone says whether Demucs is installed (npm run setup:stems). One job runs at a time: Demucs takes every core. */

export const dynamic = "force-dynamic";

const DEMUCS = process.env.DEMUCS_BIN ?? path.join(process.cwd(), ".demucs", "bin", "demucs");
const MODEL = process.env.DEMUCS_MODEL ?? "htdemucs";
const DEVICE = process.env.DEMUCS_DEVICE;
const FFMPEG = process.env.FFMPEG_BIN ?? "ffmpeg";
const MAX_BYTES = 150 * 1024 * 1024;
/** A job nobody asked about for this long is dropped with its files. */
const STALE_MS = 30 * 60 * 1000;
const EXTENSION = /^\.(mp3|wav|m4a|mp4|ogg|opus|webm|flac|aac)$/;

type Job = { state: "queued" | "running" | "done" | "failed"; progress: number; error?: string; dir: string; touched: number };
// On globalThis, so a dev-server reload keeps the jobs already running.
const store = globalThis as typeof globalThis & { stemJobs?: Map<string, Job>; stemQueue?: Promise<void> };
const jobs = store.stemJobs ??= new Map<string, Job>();

const installed = () => access(DEMUCS).then(() => true, () => false);

function run(cmd: string, args: string[], onOutput?: (text: string) => void) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const read = (chunk: Buffer) => { const text = chunk.toString(); tail = (tail + text).slice(-2000); onOutput?.(text); };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited with ${code}: ${tail.trim().split("\n").pop() ?? ""}`)));
  });
}

async function separate(job: Job, input: string) {
  job.state = "running";
  // Demucs reports progress through tqdm, "42%|####", on stderr. Merging the stems takes the last few percent.
  await run(DEMUCS, ["-n", MODEL, "-o", job.dir, "--filename", "{stem}.{ext}", ...(DEVICE ? ["-d", DEVICE] : []), input], text => {
    const all = [...text.matchAll(/(\d+)%\|/g)];
    if (all.length) job.progress = Math.max(job.progress, Number(all[all.length - 1][1]) / 100 * 0.95);
  });
  const stems = STEMS.map(s => path.join(job.dir, MODEL, `${s.id}.wav`));
  await run(FFMPEG, ["-y", "-loglevel", "error", ...stems.flatMap(file => ["-i", file]),
    "-filter_complex", `${stems.map((_, i) => `[${i}:a]`).join("")}amerge=inputs=${stems.length}[a]`, "-map", "[a]", "-c:a", "flac",
    path.join(job.dir, "stems.flac")]);
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
  if (!await installed()) return Response.json({ error: "Demucs is not installed. Run npm run setup:stems." }, { status: 503 });
  const body = await request.arrayBuffer();
  if (!body.byteLength) return Response.json({ error: "Send the audio file as the request body." }, { status: 400 });
  if (body.byteLength > MAX_BYTES) return Response.json({ error: "The file is larger than 150 MB." }, { status: 413 });
  const name = decodeURIComponent(request.headers.get("x-file-name") ?? "");
  const ext = EXTENSION.test(path.extname(name).toLowerCase()) ? path.extname(name).toLowerCase() : ".audio";

  const id = crypto.randomUUID();
  const dir = await mkdtemp(path.join(tmpdir(), "open-dj-stems-"));
  const input = path.join(dir, `track${ext}`);
  await writeFile(input, Buffer.from(body));
  const job: Job = { state: "queued", progress: 0, dir, touched: Date.now() };
  jobs.set(id, job);
  store.stemQueue = (store.stemQueue ?? Promise.resolve()).then(() => separate(job, input)).catch((e: unknown) => {
    job.state = "failed";
    job.error = e instanceof Error ? e.message : "Stem separation failed";
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
  if (job.state !== "done") return Response.json({ error: "The stems are not ready" }, { status: 409 });
  const file = await readFile(path.join(job.dir, "stems.flac"));
  jobs.delete(id);
  void rm(job.dir, { recursive: true, force: true });
  return new Response(new Uint8Array(file), { headers: { "content-type": "audio/flac", "content-length": String(file.byteLength) } });
}
