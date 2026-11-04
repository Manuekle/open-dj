import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/* The disk backup: projects and their tracks, in DATA_DIR (./data, or /data in Docker), so a session survives a
   cleared browser, another browser or a crash. The browser keeps working from IndexedDB; this is its mirror.
     GET                          { available, projects, tracks: { id: parts[] } }
     PUT    ?project=<id>         the project JSON          DELETE ?project=<id>
     PUT    ?track=<id>&part=<p>  one part of a track       GET    ?track=<id>&part=<p>
                                                            DELETE ?track=<id> (every part)
     PUT    ?mix=<id>&part=<p>    one part of a recording   GET    ?mix=<id>&part=<p>      DELETE ?mix=<id>
   Track parts: meta (the track's JSON without its files), audio, stems (the 8-channel FLAC), cover. Recording parts:
   meta and audio. */

export const dynamic = "force-dynamic";

const ROOT = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const PROJECTS = path.join(ROOT, "projects"), TRACKS = path.join(ROOT, "tracks"), MIXES = path.join(ROOT, "mixes");
const PARTS = ["meta", "audio", "stems", "cover"] as const;
type Part = typeof PARTS[number];
// Ids are the UUIDs the browser makes; anything else could walk out of the folder.
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BYTES = 300 * 1024 * 1024;

async function writable() {
  try { for (const dir of [PROJECTS, TRACKS, MIXES]) await mkdir(dir, { recursive: true }); return true; } catch { return false; }
}
const bad = (error: string, status = 400) => Response.json({ error }, { status });
const partOf = (value: string | null): Part | null => PARTS.includes(value as Part) ? value as Part : null;
const trackFile = (id: string, part: Part) => path.join(TRACKS, `${id}.${part}`);
const mixFile = (id: string, part: Part) => path.join(MIXES, `${id}.${part}`);
/** The file a ?track= or ?mix= request names, or null when the id or part is not one this backup keeps. */
function fileOf(params: URLSearchParams) {
  const track = params.get("track"), mix = params.get("mix"), part = partOf(params.get("part"));
  if (track && ID.test(track) && part) return trackFile(track, part);
  if (mix && ID.test(mix) && (part === "meta" || part === "audio")) return mixFile(mix, part);
  return null;
}
async function listParts(dir: string) {
  const out: Record<string, string[]> = {};
  for (const name of await readdir(dir)) {
    const [id, part] = name.split(".");
    if (ID.test(id) && partOf(part)) (out[id] ??= []).push(part);
  }
  return out;
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  if (!await writable()) return Response.json({ available: false, projects: [], tracks: {} });
  if (params.has("track") || params.has("mix")) {
    const file = fileOf(params);
    if (!file) return bad("Unknown track, recording or part");
    try {
      const body = await readFile(file);
      return new Response(new Uint8Array(body), { headers: { "content-type": params.get("part") === "meta" ? "application/json" : "application/octet-stream" } });
    } catch { return bad("Not backed up", 404); }
  }
  const projects = [];
  for (const name of await readdir(PROJECTS)) {
    if (!name.endsWith(".json")) continue;
    try { projects.push(JSON.parse(await readFile(path.join(PROJECTS, name), "utf8"))); } catch { /* a half-written file is skipped */ }
  }
  return Response.json({ available: true, projects, tracks: await listParts(TRACKS), mixes: await listParts(MIXES) });
}

export async function PUT(request: Request) {
  if (!await writable()) return bad("The backup folder cannot be written", 503);
  const params = new URL(request.url).searchParams;
  const project = params.get("project");
  if (project) {
    if (!ID.test(project)) return bad("Unknown project");
    const body = await request.text();
    try { if (JSON.parse(body).id !== project) return bad("The body is a different project"); } catch { return bad("The body is not JSON"); }
    // Written beside, then renamed over, so a crash mid-write never leaves half a project.
    const file = path.join(PROJECTS, `${project}.json`);
    await writeFile(`${file}.tmp`, body);
    await rename(`${file}.tmp`, file);
    return Response.json({ saved: Date.now() });
  }
  const file = fileOf(params);
  if (!file) return bad("Unknown track, recording or part");
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BYTES) return bad("Too large", 413);
  await writeFile(file, Buffer.from(body));
  return Response.json({ saved: Date.now() });
}

// The same as PUT, for the save a closing tab sends with fetch keepalive or sendBeacon.
export const POST = PUT;

export async function DELETE(request: Request) {
  if (!await writable()) return bad("The backup folder cannot be written", 503);
  const params = new URL(request.url).searchParams;
  const project = params.get("project"), track = params.get("track"), mix = params.get("mix");
  if (mix && ID.test(mix)) {
    for (const part of ["meta", "audio"] as const) await rm(mixFile(mix, part), { force: true });
    return Response.json({ deleted: true });
  }
  if (project && ID.test(project)) { await rm(path.join(PROJECTS, `${project}.json`), { force: true }); return Response.json({ deleted: true }); }
  if (track && ID.test(track)) {
    for (const part of PARTS) await rm(trackFile(track, part), { force: true });
    return Response.json({ deleted: true });
  }
  return bad("Unknown project or track");
}

