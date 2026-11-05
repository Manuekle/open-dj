import { z } from "zod";

/* Lyrics translation and romanization on the local model through Ollama, the same one the AI transition planner uses:
   nothing leaves the machine. POST { mode, lines, target?, source? } answers { lines } with one entry per input line, in
   order. "translate" writes each line in `target`; "romanize" writes each in Latin letters (what rules cannot do, like
   kanji, is left to it; lib/romanize does the rest in the browser). GET says whether the model is there. */

export const dynamic = "force-dynamic";

const OLLAMA = (process.env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
const MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5:7b";
const TIMEOUT_MS = 300_000;
/** Lines per request: small enough that a 7B model keeps its place, large enough not to take an hour. */
const CHUNK = 24;

const Body = z.object({
  mode: z.enum(["translate", "romanize"]),
  lines: z.array(z.string().max(500)).min(1).max(600),
  target: z.string().max(40).optional(),
  source: z.string().max(40).optional(),
});
const Answer = z.object({ lines: z.array(z.string()) });

async function hasModel() {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { running: true, pulled: false };
    const { models } = await res.json() as { models: { name: string }[] };
    const want = MODEL.includes(":") ? MODEL : `${MODEL}:latest`;
    return { running: true, pulled: models.some(m => m.name === want || m.name === MODEL) };
  } catch { return { running: false, pulled: false }; }
}

export async function GET() {
  const { running, pulled } = await hasModel();
  return Response.json({ available: running && pulled, running, model: MODEL });
}

const system = (mode: "translate" | "romanize", target: string, source: string) => mode === "translate"
  ? `You translate song lyrics${source ? ` from ${source}` : ""} into ${target}. The user sends {"lines": [...]}. Answer {"lines": [...]} with exactly one translated line for every input line, in the same order, keeping each line short and singable. Never merge, split, skip or add lines. Keep names, ad-libs and sounds ("oh", "la la") as they are. Do not explain.`
  : `You romanize song lyrics${source ? ` (${source})` : ""}: write each line in Latin letters the way it is sung. Japanese: Hepburn romaji with spaces between words. Korean: Revised Romanization. Chinese: pinyin with tone marks. Russian and other scripts: the usual transliteration. The user sends {"lines": [...]}. Answer {"lines": [...]} with exactly one romanized line for every input line, in the same order. Never translate, merge, split, skip or add lines. Do not explain.`;

async function ask(mode: "translate" | "romanize", lines: string[], target: string, source: string) {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      model: MODEL, stream: false, think: false, format: z.toJSONSchema(Answer),
      options: { temperature: 0.1, num_ctx: 8192 },
      messages: [{ role: "system", content: system(mode, target, source) }, { role: "user", content: JSON.stringify({ lines }) }],
    }),
  });
  if (!res.ok) throw new Error(`Ollama error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json() as { message?: { content?: string } };
  const parsed = Answer.safeParse(JSON.parse(body.message?.content ?? "null"));
  if (!parsed.success) throw new SyntaxError("wrong shape");
  return parsed.data.lines;
}

export async function POST(request: Request) {
  const { running, pulled } = await hasModel();
  if (!running) return Response.json({ error: `Ollama is not running at ${OLLAMA}. Start it with: ollama serve` }, { status: 503 });
  if (!pulled) return Response.json({ error: `Pull the model first: ollama pull ${MODEL}` }, { status: 503 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Send { mode, lines } with up to 600 short lines." }, { status: 400 });
  const { mode, lines, target = "English", source = "" } = parsed.data;
  const out: string[] = [];
  try {
    for (let i = 0; i < lines.length; i += CHUNK) {
      const chunk = lines.slice(i, i + CHUNK);
      let got = await ask(mode, chunk, target, source);
      // A model that lost its place gets one more try, then the chunk goes line by line, so the lines stay in step.
      if (got.length !== chunk.length) got = await ask(mode, chunk, target, source);
      if (got.length !== chunk.length) {
        got = [];
        for (const line of chunk) got.push((await ask(mode, [line], target, source))[0] ?? "");
      }
      out.push(...got);
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") return Response.json({ error: "The local model took too long. Try again." }, { status: 504 });
    if (e instanceof SyntaxError) return Response.json({ error: "The model did not return JSON. Try again." }, { status: 502 });
    if (e instanceof Error && e.message.startsWith("Ollama error")) return Response.json({ error: e.message }, { status: 502 });
    return Response.json({ error: `Could not reach Ollama at ${OLLAMA}.` }, { status: 502 });
  }
  return Response.json({ lines: out, model: MODEL });
}
