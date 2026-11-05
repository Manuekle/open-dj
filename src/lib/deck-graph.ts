import type { EffectName } from "@/lib/types";

/* One deck's signal path, built on any BaseAudioContext so the same graph runs in the browser (fed by a media element)
   and offline in the tests and the self-test (fed by a buffer). Nothing here touches the DOM.

   The path has two kinds of controls, kept apart on purpose:
   - the DJ's own: trim, the three EQ bands, the color filter, the effect, the channel fader, the crossfader;
   - the lanes in `mix`, which only a running transition drives (MixSession): a bass shelf, a low and a high pass, a dry
     and a send level for the transition's own effect, a volume and a level per stem.
   A transition never writes to a control the DJ also uses. AudioParam timelines cannot be shared: a curve in flight
   makes any event inside it throw, and a cancelled mix would otherwise leave the DJ's knobs wherever it stopped. */

export type AudioEffect = {
  input: AudioNode; output: AudioNode; lfo?: OscillatorNode;
  /** The echo's delay line, so its time can follow the tempo. */
  delay?: DelayNode;
};
export type EffectKind = Exclude<EffectName, "off" | "filter">;
export type SendKind = "echo" | "reverb" | "flanger";

/** The lanes a transition drives. Each rests at a value that leaves the signal untouched. */
export type MixLanes = {
  /** Low shelf in dB; the bass swap. Rests at 0. */
  low: BiquadFilterNode;
  /** Low and high pass, cutoff moved through `detune` (cents from 1 kHz), so a sweep is linear in pitch. */
  lp: BiquadFilterNode;
  hp: BiquadFilterNode;
  /** Level of the untouched signal into the sum. Rests at 1. */
  dry: GainNode;
  /** Level sent to the transition's effect. Rests at 0. */
  send: GainNode;
  sum: GainNode;
  /** The deck's level inside a transition. Rests at 1. */
  volume: GainNode;
  /** Level of each stem, in STEMS order (vocals, drums, bass, melody). Rests at 1. They act on a stems file only. */
  stems: GainNode[];
  /** The vocals stem's lane, stems[0]. */
  vocals: GainNode;
  /** The transition's own effects, built on first use. */
  rack: Partial<Record<SendKind, AudioEffect>>;
  /** Pitch shift for a transition: the untouched signal (rests at 1) and the shifted copy (rests at 0), and the shifter
      itself, built on first use. */
  pitchDry: GainNode;
  pitchWet: GainNode;
  pitch?: PitchShifter;
};

/** A pitch shifter that leaves tempo alone: two delay lines whose delay time ramps like a sawtooth, a half window apart
    and faded by a raised-cosine window, so a ramp that runs out hands over to the other. The delay's slope is the shift:
    a tap that gets `slope` seconds longer per second of window plays at 1 - slope / PITCH_WINDOW of its speed. */
export type PitchShifter = { delays: DelayNode[]; slopes: GainNode[] };
export const PITCH_WINDOW = 0.08;
/** Delay a tap holds at no shift, and the most it can reach (a shift of a ratio r moves a tap by |1 - r| windows). */
export const PITCH_BASE = 0.003;
export const PITCH_MAX_RATIO = 2.5;

export type DeckGraph = {
  /** Where a plain stereo source connects. */
  input: GainNode;
  /** Where an eight-channel stems source connects: one stereo gain per stem ahead of the trim. */
  splitter: ChannelSplitterNode;
  stems: GainNode[];
  trim: GainNode;
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  colorLP: BiquadFilterNode;
  colorHP: BiquadFilterNode;
  filter: BiquadFilterNode;
  dry: GainNode;
  wet: GainNode;
  analyser: AnalyserNode;
  channel: GainNode;
  cross: GainNode;
  mix: MixLanes;
  effects: Record<EffectKind, AudioEffect>;
  activeEffect: EffectName;
  stemMode: boolean;
};

const BASE_HZ = 1000;
/** Cutoff in cents from 1 kHz, the unit the filters' `detune` lanes move in. */
export const centsOf = (hz: number) => 1200 * Math.log2(hz / BASE_HZ);
/** Where a low pass parks when it should leave the signal alone: just under Nyquist, never on it. A low pass at Nyquist
    has its poles on the unit circle (z = -1, twice), so nothing damps it: any state it holds rings at the top of the band
    for good and grows until the deck is silent or deafening, and only a reload clears it. Just under, the poles are
    inside the circle and whatever it holds dies out in a few milliseconds. */
export const lpRestHz = (ctx: BaseAudioContext) => ctx.sampleRate / 2 * 0.99;
export const COLOR_LP_REST_HZ = 20000;
export const COLOR_HP_REST_HZ = 12;

/** The two cutoffs one color knob value (-1 low pass .. +1 high pass) asks for; the idle one sits at rest. */
export function colorCutoffs(value: number) {
  const v = Math.max(-1, Math.min(1, value));
  if (Math.abs(v) < 0.02) return { lp: COLOR_LP_REST_HZ, hp: COLOR_HP_REST_HZ };
  return v < 0 ? { lp: COLOR_LP_REST_HZ * Math.pow(0.012, -v), hp: COLOR_HP_REST_HZ } : { lp: COLOR_LP_REST_HZ, hp: 20 * Math.pow(300, v) };
}

/** A small deterministic noise source, so a reverb tail is the same on every load. */
function noise(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 31 - 1; };
}

export function buildEffect(ctx: BaseAudioContext, kind: EffectKind): AudioEffect {
  if (kind === "echo") {
    const delay = ctx.createDelay(2.0); delay.delayTime.value = 0.29;
    const feedback = ctx.createGain(); feedback.gain.value = 0.3;
    delay.connect(feedback); feedback.connect(delay);
    return { input: delay, output: delay, delay };
  }
  if (kind === "reverb") {
    const convolver = ctx.createConvolver();
    const impulse = ctx.createBuffer(2, Math.floor(ctx.sampleRate * 1.6), ctx.sampleRate);
    const random = noise(11);
    for (let ch = 0; ch < impulse.numberOfChannels; ch++) {
      const out = impulse.getChannelData(ch);
      for (let i = 0; i < out.length; i++) out[i] = random() * Math.pow(1 - i / out.length, 2.9);
    }
    convolver.buffer = impulse;
    return { input: convolver, output: convolver };
  }
  if (kind === "flanger") {
    const flanger = ctx.createDelay(0.04); flanger.delayTime.value = 0.005;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.3;
    const depth = ctx.createGain(); depth.gain.value = 0.003;
    lfo.connect(depth); depth.connect(flanger.delayTime); lfo.start();
    return { input: flanger, output: flanger, lfo };
  }
  if (kind === "phaser") {
    // Two all-pass stages swept by one slow LFO, two octaves either side of 1.1 kHz, so the notches move.
    const a = ctx.createBiquadFilter(); a.type = "allpass"; a.frequency.value = 1100; a.Q.value = 3;
    const b = ctx.createBiquadFilter(); b.type = "allpass"; b.frequency.value = 1100; b.Q.value = 3;
    a.connect(b);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.25;
    const depth = ctx.createGain(); depth.gain.value = 2400;
    lfo.connect(depth); depth.connect(a.detune); depth.connect(b.detune); lfo.start();
    return { input: a, output: b, lfo };
  }
  const crusher = ctx.createWaveShaper(); const curve = new Float32Array(8192);
  for (let i = 0; i < curve.length; i++) { const x = (i / (curve.length - 1)) * 2 - 1; curve[i] = Math.round(x * 16) / 16; }
  crusher.curve = curve;
  return { input: crusher, output: crusher };
}

function filterAt(ctx: BaseAudioContext, type: BiquadFilterType, hz: number, q: number) {
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = BASE_HZ;
  f.detune.value = centsOf(type === "lowpass" ? Math.min(hz, lpRestHz(ctx)) : hz); f.Q.value = q;
  return f;
}

export function createDeckGraph(ctx: BaseAudioContext, destination: AudioNode): DeckGraph {
  const trim = ctx.createGain();
  const low = ctx.createBiquadFilter(); low.type = "lowshelf"; low.frequency.value = 280;
  const mid = ctx.createBiquadFilter(); mid.type = "peaking"; mid.frequency.value = 1100; mid.Q.value = 0.75;
  const high = ctx.createBiquadFilter(); high.type = "highshelf"; high.frequency.value = 4400;
  // Two filters, one always at rest, so the color knob never changes a filter's type: a type change under a cutoff that
  // is still moving jumps the response and clicks.
  const colorLP = filterAt(ctx, "lowpass", COLOR_LP_REST_HZ, 0.9);
  const colorHP = filterAt(ctx, "highpass", COLOR_HP_REST_HZ, 0.9);
  const filter = ctx.createBiquadFilter(); filter.type = "lowpass"; filter.frequency.value = 20000;
  const dry = ctx.createGain();
  const wet = ctx.createGain(); wet.gain.value = 0.4;
  const analyser = ctx.createAnalyser(); analyser.fftSize = 512;
  const channel = ctx.createGain(); channel.gain.value = 0.82;
  const cross = ctx.createGain();

  const lpRest = lpRestHz(ctx);
  const stemLanes = [0, 1, 2, 3].map(() => ctx.createGain());
  const mix: MixLanes = {
    low: (() => { const f = ctx.createBiquadFilter(); f.type = "lowshelf"; f.frequency.value = 280; return f; })(),
    // Butterworth, and at rest parked just under Nyquist (see lpRestHz), nearly flat to the top of the band.
    lp: filterAt(ctx, "lowpass", lpRest, Math.SQRT1_2),
    hp: filterAt(ctx, "highpass", COLOR_HP_REST_HZ, Math.SQRT1_2),
    dry: ctx.createGain(), send: ctx.createGain(), sum: ctx.createGain(), volume: ctx.createGain(),
    stems: stemLanes, vocals: stemLanes[0],
    rack: {}, pitchDry: ctx.createGain(), pitchWet: ctx.createGain(),
  };
  mix.pitchWet.gain.value = 0;
  mix.send.gain.value = 0;

  const splitter = ctx.createChannelSplitter(8);
  const stems = [0, 1, 2, 3].map(k => {
    const pair = ctx.createChannelMerger(2); splitter.connect(pair, 2 * k, 0); splitter.connect(pair, 2 * k + 1, 1);
    const gain = ctx.createGain(); pair.connect(gain);
    gain.connect(mix.stems[k]); mix.stems[k].connect(trim);
    return gain;
  });

  trim.connect(low); low.connect(mid); mid.connect(high); high.connect(colorLP); colorLP.connect(colorHP); colorHP.connect(filter);
  filter.connect(dry); dry.connect(analyser); wet.connect(analyser);
  analyser.connect(mix.low); mix.low.connect(mix.lp); mix.lp.connect(mix.hp);
  mix.hp.connect(mix.dry); mix.dry.connect(mix.sum); mix.hp.connect(mix.send);
  mix.sum.connect(mix.pitchDry); mix.pitchDry.connect(mix.volume); mix.pitchWet.connect(mix.volume);
  mix.volume.connect(channel); channel.connect(cross); cross.connect(destination);

  const effects = Object.fromEntries((["echo", "reverb", "flanger", "phaser", "crush"] as const).map(k => [k, buildEffect(ctx, k)])) as Record<EffectKind, AudioEffect>;
  return { input: trim, splitter, stems, trim, low, mid, high, colorLP, colorHP, filter, dry, wet, analyser, channel, cross, mix, effects, activeEffect: "off", stemMode: false };
}

/** The transition's own copy of a send effect, wired between the send lane and the sum. Built once per deck and kind. */
export function ensureRack(ctx: BaseAudioContext, deck: DeckGraph, kind: SendKind) {
  const have = deck.mix.rack[kind];
  if (have) return have;
  const effect = buildEffect(ctx, kind);
  deck.mix.send.connect(effect.input); effect.output.connect(deck.mix.sum);
  deck.mix.rack[kind] = effect;
  return effect;
}

/** Delay and slope a tap needs for a pitch ratio `r` (1 = unchanged): the delay climbs by `slope` over each window, and
    starts high enough that a falling one never goes below zero. */
export function pitchTap(r: number) {
  const k = Math.max(1 / PITCH_MAX_RATIO, Math.min(PITCH_MAX_RATIO, Number.isFinite(r) ? r : 1));
  const slope = (1 - k) * PITCH_WINDOW;
  return { slope, delay: PITCH_BASE + Math.max(0, -slope) };
}
/** Share of the shifted copy in the output for a ratio: none at rest, all of it from a fifth of a semitone on, so a
    shift too small to hear does not put the delayed copy over the dry signal. */
export function pitchWetShare(r: number) {
  const semitones = Math.abs(12 * Math.log2(Math.max(1e-3, r)));
  return Math.min(1, semitones / 0.2);
}

/** The deck's pitch shifter, wired between the sum and the deck's volume lane. Built once per deck. */
export function ensurePitch(ctx: BaseAudioContext, deck: DeckGraph): PitchShifter {
  if (deck.mix.pitch) return deck.mix.pitch;
  const n = Math.max(2, Math.round(PITCH_WINDOW * ctx.sampleRate));
  const saw = ctx.createBuffer(1, n, ctx.sampleRate), window = ctx.createBuffer(1, n, ctx.sampleRate);
  const a = saw.getChannelData(0), w = window.getChannelData(0);
  for (let i = 0; i < n; i++) { a[i] = i / n; w[i] = Math.sin(Math.PI * i / n) ** 2; }
  const delays: DelayNode[] = [], slopes: GainNode[] = [];
  for (const phase of [0, 0.5]) {
    const delay = ctx.createDelay(PITCH_WINDOW * PITCH_MAX_RATIO + 0.05); delay.delayTime.value = PITCH_BASE;
    const slope = ctx.createGain(); slope.gain.value = 0;
    const ramp = ctx.createBufferSource(); ramp.buffer = saw; ramp.loop = true;
    const fade = ctx.createBufferSource(); fade.buffer = window; fade.loop = true;
    const tap = ctx.createGain(); tap.gain.value = 0;
    ramp.connect(slope); slope.connect(delay.delayTime);
    fade.connect(tap.gain);
    deck.mix.sum.connect(delay); delay.connect(tap); tap.connect(deck.mix.pitchWet);
    ramp.start(0, phase * PITCH_WINDOW); fade.start(0, phase * PITCH_WINDOW);
    delays.push(delay); slopes.push(slope);
  }
  deck.mix.pitch = { delays, slopes };
  return deck.mix.pitch;
}

/** Times a deck's effects to its tempo: the echo repeats every `beats` beats, and the flanger and phaser sweep once
    every four times that. `beat` is the heard seconds per beat; without one (no tempo) the effects keep their own times. */
export function applyEffectTime(ctx: BaseAudioContext, d: DeckGraph, beat: number | null, beats: number) {
  if (!beat || !Number.isFinite(beat) || beat <= 0) return;
  const t = ctx.currentTime, span = Math.max(0.03, beat * beats);
  d.effects.echo.delay?.delayTime.setTargetAtTime(Math.min(1.9, span), t, 0.04);
  d.effects.flanger.lfo?.frequency.setTargetAtTime(1 / (span * 4), t, 0.05);
  d.effects.phaser.lfo?.frequency.setTargetAtTime(1 / (span * 4), t, 0.05);
}

/** One-knob color filter: below 0 sweeps a low pass down, above 0 a high pass up. Both filters move in cents, so a sweep
    is even in pitch, and neither ever changes type, so a fast turn through zero does not jump. */
export function applyColor(ctx: BaseAudioContext, deck: DeckGraph, value: number) {
  const t = ctx.currentTime, c = colorCutoffs(value);
  deck.colorLP.detune.setTargetAtTime(centsOf(Math.min(c.lp, lpRestHz(ctx))), t, 0.02);
  deck.colorHP.detune.setTargetAtTime(centsOf(c.hp), t, 0.02);
}

/** Routes a deck's own effect and sets its depth. Every level change is a ramp: a jump in the dry or wet level clicks. */
export function applyEffect(ctx: BaseAudioContext, d: DeckGraph, effect: EffectName, amount: number) {
  const t = ctx.currentTime;
  d.filter.disconnect();
  d.filter.type = "lowpass";
  d.filter.frequency.setTargetAtTime(effect === "filter" ? Math.max(240, 20000 * (1 - amount) ** 3) : 20000, t, 0.012);
  d.filter.connect(d.dry);
  d.dry.gain.setTargetAtTime(effect === "off" || effect === "filter" ? 1 : 1 - amount * 0.25, t, 0.01);
  d.wet.gain.setTargetAtTime(Math.max(0, Math.min(0.95, amount * 0.7)), t, 0.01);
  if (effect !== "off" && effect !== "filter") {
    const fx = d.effects[effect];
    fx.output.disconnect();
    fx.output.connect(d.wet);
    d.filter.connect(fx.input);
  }
  d.activeEffect = effect;
}
