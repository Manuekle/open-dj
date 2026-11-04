import { z } from "zod";
import type { MixFeatures } from "@/lib/mix-features";
import type { TransitionPlan } from "@/lib/types";

/* The AI transition planner, on a local model through Ollama (https://ollama.com): nothing leaves the machine.
   POST { from, to, auto }: two tracks' analysis (lib/mix-features) and the automatic plan. The model answers where the
   outgoing track leaves and the incoming one enters, in bars of each track's own grid, and which curve, eq, effect and
   stem move to use, with a line per decision; Ollama holds its output to the Plan schema. GET says whether Ollama is
   running with the model pulled. */

export const dynamic = "force-dynamic";

const OLLAMA = (process.env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
const MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5:7b";
/** A first answer loads the model into memory, which can take a while on a laptop. */
const TIMEOUT_MS = 300_000;
const BARS = [1, 2, 4, 8, 16] as const;

const Plan = z.object({
  outBar: z.number().int().describe("Bar of the outgoing track, counted from its first beat, where the transition starts"),
  inBar: z.number().int().describe("Bar of the incoming track, counted from its first beat, it is playing when the transition starts"),
  bars: z.number().int().describe("Transition length in bars of the outgoing track: 1, 2, 4, 8 or 16"),
  volume: z.enum(["smooth", "overlap", "fade"]),
  eq: z.enum(["none", "bass"]),
  effect: z.enum(["none", "lowpass", "echo", "rise", "reverb", "flanger", "swap"]),
  stems: z.enum(["none", "vocals"]),
  notes: z.array(z.string()).describe("Two to five short sentences, one per decision, each citing the numbers behind it"),
});

const SYSTEM = `You plan one transition between two tracks for a two-deck DJ engine. You get each track's analysis and the engine's own automatic plan; return a better plan when you see one, or the same one when it is already right.

How the engine plays a plan:
- The incoming deck is tempo-matched to the outgoing one and beat-aligned. When the outgoing track reaches outBar, the incoming track is at inBar, and both run for "bars" bars of the outgoing track.
- volume: "smooth" is an equal-power crossfade across the whole length; "overlap" brings the new track in at full level in the first quarter and drops the old one in the last quarter; "fade" fades the old one out over the first 60%, then the new one in over the last 60%.
- eq "bass": the low band (below 250 Hz) of the outgoing track is cut and the incoming one's restored over the middle tenth, so two bass lines never play at once. "none" leaves the lows to the volume curve.
- effect: "lowpass" sweeps a low-pass filter down on the outgoing track; "rise" opens a high-pass on the incoming one; "echo" feeds the outgoing track into an echo that grows over the second half (an echo out); "reverb" washes the outgoing track into a growing reverb tail while a low pass closes on it (a space out); "flanger" sweeps a flanger over the outgoing track and back; "swap" sweeps a high pass up with reverb on the outgoing track while the incoming one opens from a closed low pass (filter up and down); "none".
- stems "vocals" (only when both tracks have stems): the outgoing vocals are gone by 40% and the incoming vocals come in from 60%, so two voices never overlap.

How to judge it, as a professional DJ would:
- Phrasing: start on a phrase boundary (a multiple of 8 or 16 bars from the first beat), where the loudness or a band steps. The outgoing track should leave in its outro, after its last main section; the incoming track's main section (its loud, full-band stretch) should arrive as the transition ends, so inBar + bars lands on it.
- Harmony: Camelot codes one step apart, the same number with A and B, or the same code mix cleanly over long blends (8-16 bars). Clashing keys need a short transition (2-4 bars) or a filter that hides the mids. A key with keyClarity under 0.05 is a guess; weigh it less.
- Tempo: under 3% change is inaudible; 3-8% is fine over a shorter blend; over 8%, prefer a 1-2 bar echo out.
- Bass: if both tracks carry bass (low band near their usual level) across the overlap, swap the bass. If one side has none (a breakdown, an intro), let it cross.
- Vocals: if both stems show vocals in the overlap, hand them over or shorten the overlap.
- Energy: keep the floor moving; do not drop into a quiet intro after a peak unless the next track builds quickly.

All perBar series start at the first beat, one value per bar, in dB. Keep each note to one sentence, in plain English, with the numbers behind it.`;

/** Whether Ollama answers and has the model, by its name with or without the ":latest" tag. */
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

export async function POST(request: Request) {
  const { running, pulled } = await hasModel();
  if (!running) return Response.json({ error: `Ollama is not running at ${OLLAMA}. Start it with: ollama serve` }, { status: 503 });
  if (!pulled) return Response.json({ error: `Pull the model first: ollama pull ${MODEL}` }, { status: 503 });
  const { from, to, auto } = await request.json() as { from: MixFeatures; to: MixFeatures; auto: TransitionPlan };
  if (!from?.bpm || !to?.bpm) return Response.json({ error: "Both tracks need a tempo first." }, { status: 400 });
  const barOut = from.barSeconds, barIn = to.barSeconds;
  const automatic = {
    outBar: Math.round((auto.outAt - from.firstBeat) / barOut), inBar: Math.round((auto.inAt - to.firstBeat) / barIn),
    bars: auto.bars, volume: auto.volume, eq: auto.eq, effect: auto.effect, stems: auto.stems ?? "none", notes: auto.notes ?? [],
  };

  let out: z.infer<typeof Plan>;
  try {
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        model: MODEL, stream: false, think: false, format: z.toJSONSchema(Plan),
        // The analysis runs to a few thousand tokens; Ollama's default context would cut it off.
        options: { temperature: 0.2, num_ctx: 16384 },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: JSON.stringify({ outgoing: from, incoming: to, automaticPlan: automatic }) },
        ],
      }),
    });
    if (!res.ok) return Response.json({ error: `Ollama error ${res.status}: ${(await res.text()).slice(0, 200)}` }, { status: 502 });
    const body = await res.json() as { message?: { content?: string } };
    const parsed = Plan.safeParse(JSON.parse(body.message?.content ?? "null"));
    if (!parsed.success) return Response.json({ error: "The model returned a plan in the wrong shape. Try again." }, { status: 502 });
    out = parsed.data;
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") return Response.json({ error: "The local model took too long. Try again, or a smaller OLLAMA_MODEL." }, { status: 504 });
    if (e instanceof SyntaxError) return Response.json({ error: "The model did not return JSON. Try again." }, { status: 502 });
    return Response.json({ error: `Could not reach Ollama at ${OLLAMA}.` }, { status: 502 });
  }
  // Keep what comes back inside both tracks and on the engine's lengths.
  const bars = BARS.reduce((best, n) => Math.abs(n - out.bars) < Math.abs(best - out.bars) ? n : best, 4 as number);
  const lastOut = Math.floor((from.duration - from.firstBeat) / barOut) - bars - 1;
  const outBar = Math.max(0, Math.min(lastOut, out.outBar));
  const inBar = Math.max(0, Math.min(Math.floor((to.duration - to.firstBeat) / barIn) - 1, out.inBar));
  const plan: Omit<TransitionPlan, "fromId" | "toId" | "preset" | "by"> = {
    outAt: from.firstBeat + outBar * barOut, inAt: to.firstBeat + inBar * barIn, bars,
    volume: out.volume, eq: out.eq, effect: out.effect,
    stems: from.perBar.stems && to.perBar.stems ? out.stems : "none",
    // Small models often pack every reason into one note; the editor lists them one sentence a row.
    notes: out.notes.flatMap(note => note.split(/(?<=[.!?])\s+(?=[A-Z])/)).map(n => n.trim()).filter(Boolean).slice(0, 6),
  };
  return Response.json({ plan, model: MODEL });
}
