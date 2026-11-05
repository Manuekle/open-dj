import { pointCount, rampChain, sampleCurve } from "@/lib/automation";
import { createMasterBus } from "@/lib/audio-engine";
import { createDeckGraph } from "@/lib/deck-graph";
import { MixSession, crossGains } from "@/lib/mix-session";
import { hasMotion, movesStems, speedOf, swapsBassStem } from "@/lib/transition";
import type { TransitionPlan } from "@/lib/types";

/* A transition heard on its own, away from the decks: both tracks decoded at full quality, the stretch around the
   transition cut out of each, and the plan rendered offline through the same deck graph, master bus and MixSession the
   decks play through. The result is one buffer that loops, so a plan can be tried again and again while the set plays on.

   What differs from the decks: the incoming track is sped up by resampling (its pitch follows its tempo, the decks keep
   pitch; a drawn speed move is resampled too, and the pitch shifter takes its share of the pitch back out), and stem moves are not heard (the preview plays each track's full mix; a stem bass swap falls back to the eq,
   as it does on a deck without stems). */

/** A stretch of a decoded track: its channels from `start` seconds on, at `rate`. */
export type AudioWindow = { start: number; end: number; rate: number; channels: Float32Array[] };

/** Seconds kept on either side of what a render needs, so moving a point a little does not decode the track again. */
const MARGIN = 30;

/** Decodes a track and keeps the stretch [from, to] (plus a margin), so a long track is not held whole in memory. */
export async function decodeWindow(blob: Blob, from: number, to: number, rate = 44100): Promise<AudioWindow> {
  const audio = await new OfflineAudioContext(2, 1, rate).decodeAudioData(await blob.arrayBuffer());
  const start = Math.max(0, from - MARGIN), end = Math.min(audio.duration, to + MARGIN);
  const a = Math.floor(start * audio.sampleRate), b = Math.ceil(end * audio.sampleRate);
  const channels = Array.from({ length: Math.min(2, audio.numberOfChannels) }, (_, i) => audio.getChannelData(i).slice(a, b));
  return { start, end, rate: audio.sampleRate, channels };
}

/** Whether a window holds the stretch [from, to] of its track. */
export const covers = (w: AudioWindow | null | undefined, from: number, to: number, duration: number) =>
  !!w && w.start <= Math.max(0, from) && w.end >= Math.min(duration, to) - 0.01;

export type PreviewSpec = {
  plan: TransitionPlan;
  a: AudioWindow; b: AudioWindow;
  /** Track seconds each track starts at in the preview. */
  aStart: number; bStart: number;
  /** Playback rate of each track. */
  aRate: number; bRate: number;
  /** Context seconds before the transition starts, the seconds it takes, and the whole preview. */
  lead: number; duration: number; seconds: number;
  /** Trim of each deck, dB. */
  aTrim: number; bTrim: number;
  /** Context seconds per beat of the outgoing track. */
  beat?: number;
};

/** Renders a preview to a stereo buffer: the outgoing track alone, the transition, then the incoming track alone. */
export async function renderPreview(s: PreviewSpec): Promise<AudioBuffer> {
  const rate = s.a.rate;
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(s.seconds * rate)), rate);
  const bus = createMasterBus(ctx);
  bus.output.connect(ctx.destination);
  bus.input.gain.value = 0.9;
  const A = createDeckGraph(ctx, bus.input), B = createDeckGraph(ctx, bus.input);
  const play = (deck: typeof A, w: AudioWindow, at: number, speed: number, trim: number, side: "out" | "in") => {
    deck.trim.gain.value = 10 ** (Math.max(-24, Math.min(12, trim)) / 20);
    const buffer = ctx.createBuffer(w.channels.length, w.channels[0].length, w.rate);
    w.channels.forEach((c, i) => buffer.copyToChannel(c as Float32Array<ArrayBuffer>, i));
    const src = ctx.createBufferSource();
    src.buffer = buffer; src.playbackRate.value = speed; src.connect(deck.input);
    // A drawn speed move: the rate follows the lane across the transition, on top of the rate the track plays at.
    if (hasMotion(s.plan.speed)) {
      const rate = src.playbackRate;
      rampChain(rate, sampleCurve(t => speed * speedOf(s.plan, t)[side], 0, 1, pointCount(s.duration)), s.lead, s.duration);
      rate.setValueAtTime(speed * speedOf(s.plan, 1)[side], s.lead + s.duration);
    }
    // A start before the track begins waits for it: the track comes in at its first second.
    const offset = at - w.start;
    if (offset >= 0) src.start(0, offset); else src.start(-offset / speed, 0);
  };
  play(A, s.a, s.aStart, s.aRate, s.aTrim, "out");
  play(B, s.b, s.bStart, s.bRate, s.bTrim, "in");

  // As on the decks: the fader rests on the outgoing deck, the incoming one is silent until the blend brings it in.
  const rest = crossGains(-1), final = crossGains(1);
  A.cross.gain.value = rest.A; B.cross.gain.value = rest.B;
  B.mix.volume.gain.value = 0;
  let plan = s.plan;
  if (swapsBassStem(plan.stems, plan.stemMoves) && plan.eq === "none") plan = { ...plan, eq: "bass" };
  if (movesStems(plan.stems)) plan = { ...plan, stems: "none" };
  new MixSession(ctx, {
    plan, from: A, to: B, start: s.lead, duration: s.duration, outStart: rest.A, handover: false, beat: s.beat, speedMovesPitch: true,
    rest: { from: rest.A, to: rest.B }, final: { from: final.A, to: final.B },
  }).schedule();
  return ctx.startRendering();
}
