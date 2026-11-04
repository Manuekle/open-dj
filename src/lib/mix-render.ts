import { createMasterBus } from "@/lib/audio-engine";
import { createDeckGraph, type DeckGraph } from "@/lib/deck-graph";
import { MixSession, crossGains, type MixSpec } from "@/lib/mix-session";

/* Renders a transition offline through the real deck graph, master bus and MixSession, so a test (or the in-browser
   self-test) can look at the samples that come out. The only thing it replaces is the media element: each deck plays a
   synthetic buffer. It runs on any OfflineAudioContext, node's and the browser's alike. */

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => unknown;

export type Harness = {
  ctx: OfflineAudioContext;
  A: DeckGraph;
  B: DeckGraph;
  session: MixSession;
  /** Starts another mix on the same graph, as a second transition would. */
  next(spec: Partial<Omit<MixSpec, "from" | "to">> & { start: number; duration: number }): MixSession;
};

export type Scenario = {
  sampleRate?: number;
  seconds: number;
  /** Mono sources for decks A and B, one buffer each. */
  a: Float32Array;
  b: Float32Array;
  plan: MixSpec["plan"];
  /** Context time of progress 0, and the seconds the blend takes. */
  start: number;
  duration: number;
  /** The deck that goes out. */
  from?: "A" | "B";
  handover?: boolean;
  /** Context seconds per beat of the outgoing track. */
  beat?: number;
  /** Things done to the graph while it renders, at context times (rounded to a render block). */
  actions?: { at: number; run: (h: Harness) => void }[];
};

export async function renderMix(Offline: OfflineCtor, s: Scenario) {
  const rate = s.sampleRate ?? 22050;
  const ctx = new Offline(2, Math.ceil(s.seconds * rate), rate) as OfflineAudioContext;
  const bus = createMasterBus(ctx);
  bus.output.connect(ctx.destination);
  bus.input.gain.value = 0.9;
  const A = createDeckGraph(ctx, bus.input), B = createDeckGraph(ctx, bus.input);
  for (const [deck, data] of [[A, s.a], [B, s.b]] as const) {
    const buffer = ctx.createBuffer(1, data.length, rate); buffer.getChannelData(0).set(data);
    const src = ctx.createBufferSource(); src.buffer = buffer; src.connect(deck.input); src.start(0);
  }
  const from = s.from ?? "A", to = from === "A" ? "B" : "A";
  const graph = { A, B };
  // The crossfader sits on the outgoing deck, as it does before a blend.
  const rest = crossGains(from === "A" ? -1 : 1), final = crossGains(from === "A" ? 1 : -1);
  A.cross.gain.value = rest.A; B.cross.gain.value = rest.B;
  graph[to].mix.volume.gain.value = 0; // the incoming deck is silenced for its preroll
  const spec = (over: Partial<MixSpec> = {}): MixSpec => ({
    plan: s.plan, from: graph[from], to: graph[to], start: s.start, duration: s.duration, outStart: rest[from], handover: !!s.handover, beat: s.beat,
    rest: { from: rest[from], to: rest[to] }, final: { from: final[from], to: final[to] }, ...over,
  });
  const session = new MixSession(ctx, spec());
  session.schedule();
  const h: Harness = {
    ctx, A, B, session,
    next(over) {
      const next = new MixSession(ctx, spec(over));
      next.schedule();
      h.session = next;
      return next;
    },
  };
  for (const action of s.actions ?? []) {
    const frame = Math.max(128, Math.round(action.at * rate / 128) * 128);
    void ctx.suspend(frame / rate).then(() => { action.run(h); return ctx.resume(); });
  }
  const buffer = await ctx.startRendering();
  return { out: buffer.getChannelData(0), rate, ctx, A, B, session: h.session };
}

/** A sine, mono. */
export function sine(frequency: number, amplitude: number, seconds: number, rate: number) {
  const x = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < x.length; i++) x[i] = amplitude * Math.sin(2 * Math.PI * frequency * i / rate);
  return x;
}

export const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

/** The largest sample-to-sample step, as a multiple of the step a sum of sines `parts` ([Hz, amplitude]) could make at most
    at the output's gain. A gain move that is smooth keeps this at or under 1; a click is several times it. */
export function stepRatio(x: Float32Array, rate: number, parts: [number, number][], gain: number, from = 1, to = x.length) {
  const bound = parts.reduce((sum, [f, a]) => sum + a * 2 * Math.PI * f / rate, 0) * gain;
  let max = 0;
  for (let i = Math.max(1, from); i < Math.min(to, x.length); i++) max = Math.max(max, Math.abs(x[i] - x[i - 1]));
  return max / bound;
}

/** Magnitude of one frequency in a stretch (Goertzel), as the amplitude of the sine that would give it. */
export function toneLevel(x: Float32Array, rate: number, frequency: number, from: number, to: number) {
  const w = 2 * Math.PI * frequency / rate, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  const a = Math.floor(from * rate), b = Math.min(x.length, Math.floor(to * rate));
  for (let i = a; i < b; i++) { const s0 = x[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  const power = s1 * s1 + s2 * s2 - c * s1 * s2;
  return 2 * Math.sqrt(Math.max(0, power)) / (b - a);
}
