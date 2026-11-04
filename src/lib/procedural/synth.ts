/*
 * Procedural sound recipes and their player, vendored from procedural-sounds
 * (https://github.com/m1ckc3s/procedural-sounds), lib/audio/patch.ts, synth.ts and effects.ts.
 * Copyright (c) 2026 Mick Cesanek. MIT License.
 *
 * Its synth core is itself adapted from @web-kits/audio (https://github.com/raphaelsalaja/audio),
 * Copyright (c) 2026 Raphael Salaja, and its echo from cuelume (https://github.com/Danilaa1/cuelume),
 * Copyright (c) 2026 Daniel Belyi. Both MIT License. Full texts: THIRD-PARTY-NOTICES.md.
 *
 * Changes here: the three files are merged into one, the app-wide context helpers are dropped (the studio passes its
 * own context and destination), and a pitch helper is added for putting a recipe on the piano.
 */

export type Waveform = "sine" | "triangle" | "square" | "sawtooth";
export type Frequency = number | { start: number; end: number; time?: number };
export interface FM { ratio: number; depth: number }
export interface OscillatorSource { type: Waveform; frequency: Frequency; fm?: FM; detune?: number }
export type NoiseColor = "white" | "pink" | "brown";
export interface NoiseSource { type: "noise"; color?: NoiseColor }
export type Source = OscillatorSource | NoiseSource;
export interface Envelope { attack?: number; decay: number; sustain?: number; release?: number; curve?: "ramp" }
export interface FilterEnvelope { attack?: number; peak: number; decay: number }
export interface Filter { type: BiquadFilterType; frequency: number; Q?: number; resonance?: number; envelope?: FilterEnvelope }
export interface ReverbEffect { type: "reverb"; decay?: number; damping?: number; mix?: number; preDelay?: number; roomSize?: number }
export interface DelayEffect { type: "delay"; delay: number; feedback: number; wet: number; lowpass?: number }
export type Effect = ReverbEffect | DelayEffect;
export interface Layer { source: Source; envelope?: Envelope; gain?: number; delay?: number; filter?: Filter | Filter[]; effects?: Effect[] }
export type Patch = Layer | { layers: Layer[] };

export function layersOf(patch: Patch): Layer[] {
  return "layers" in patch ? patch.layers : [patch];
}

const SILENCE = 0.0001;
const INAUDIBLE_GAIN = 0.001;

function createNoiseBuffer(ctx: BaseAudioContext, color: NoiseColor, duration: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  if (color === "pink") {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    }
  } else if (color === "brown") {
    let last = 0;
    for (let i = 0; i < data.length; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; data[i] = last * 3.5; }
  } else {
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  return buffer;
}

function buildSource(ctx: BaseAudioContext, src: Source, t: number, duration: number): AudioScheduledSourceNode {
  if (src.type === "noise") {
    const node = ctx.createBufferSource();
    node.buffer = createNoiseBuffer(ctx, src.color ?? "white", duration + 0.1);
    node.start(t); node.stop(t + duration + 0.1);
    return node;
  }
  const osc = ctx.createOscillator();
  osc.type = src.type;
  if (typeof src.frequency === "number") osc.frequency.setValueAtTime(src.frequency, t);
  else {
    osc.frequency.setValueAtTime(src.frequency.start, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(src.frequency.end, 1), t + Math.min(src.frequency.time ?? duration, duration));
  }
  if (src.detune) osc.detune.value = src.detune;
  osc.start(t); osc.stop(t + duration + 0.1);
  if (src.fm) {
    const carrier = typeof src.frequency === "number" ? src.frequency : src.frequency.start;
    const mod = ctx.createOscillator(); mod.type = "sine"; mod.frequency.value = carrier * src.fm.ratio;
    const depth = ctx.createGain(); depth.gain.value = src.fm.depth;
    mod.connect(depth); depth.connect(osc.frequency); mod.start(t); mod.stop(t + duration + 0.1);
  }
  return osc;
}

function buildEnvelope(ctx: BaseAudioContext, envelope: Envelope | undefined, gain: number, t: number) {
  const node = ctx.createGain();
  if (!envelope) { node.gain.setValueAtTime(gain, t); node.gain.setTargetAtTime(SILENCE, t, 0.15); return { node, duration: 0.5 }; }
  const attack = envelope.attack ?? 0, decay = envelope.decay, sustain = envelope.sustain ?? 0, release = envelope.release ?? 0;
  const sustainLevel = Math.max(sustain * gain, SILENCE), decayTC = decay / 3;
  if (envelope.curve === "ramp") {
    const peak = Math.max(gain, SILENCE);
    node.gain.setValueAtTime(SILENCE, t);
    if (attack > 0) node.gain.exponentialRampToValueAtTime(peak, t + attack); else node.gain.setValueAtTime(peak, t);
    node.gain.exponentialRampToValueAtTime(SILENCE, t + attack + decay);
    return { node, duration: attack + decay + release };
  }
  node.gain.setValueAtTime(SILENCE, t);
  if (attack > 0) node.gain.linearRampToValueAtTime(gain, t + attack); else node.gain.setValueAtTime(gain, t);
  if (sustain > 0) {
    node.gain.setTargetAtTime(sustainLevel, t + attack, decayTC);
    if (release > 0) node.gain.setTargetAtTime(SILENCE, t + attack + decay, release / 3);
  } else node.gain.setTargetAtTime(SILENCE, t + attack, decayTC);
  return { node, duration: attack + decay + release };
}

function buildFilter(ctx: BaseAudioContext, filter: Filter, t: number) {
  const node = ctx.createBiquadFilter();
  node.type = filter.type;
  node.frequency.setValueAtTime(filter.frequency, t);
  node.Q.value = filter.Q ?? filter.resonance ?? 1;
  if (filter.envelope) {
    const env = filter.envelope, attackEnd = t + (env.attack ?? 0);
    node.frequency.linearRampToValueAtTime(env.peak, attackEnd);
    node.frequency.exponentialRampToValueAtTime(Math.max(filter.frequency, 1), attackEnd + env.decay);
  }
  return node;
}

function createShimmer(ctx: BaseAudioContext, opts: DelayEffect) {
  const input = ctx.createGain(), output = ctx.createGain();
  input.connect(output);
  const delay = ctx.createDelay(1); delay.delayTime.value = opts.delay;
  const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = opts.lowpass ?? 4000;
  const feedback = ctx.createGain(); feedback.gain.value = opts.feedback;
  const wet = ctx.createGain(); wet.gain.value = opts.wet;
  input.connect(delay); delay.connect(lp); lp.connect(feedback); feedback.connect(delay); lp.connect(wet); wet.connect(output);
  return { input, output };
}

function shimmerTail(opts: DelayEffect) {
  if (opts.feedback <= 0) return 0;
  if (opts.feedback >= 1) return opts.delay;
  return opts.delay * (1 + Math.ceil(Math.log(INAUDIBLE_GAIN) / Math.log(opts.feedback)));
}

function createReverb(ctx: BaseAudioContext, opts: ReverbEffect) {
  const decay = opts.decay ?? 0.5, mix = opts.mix ?? 0.3, preDelay = opts.preDelay ?? 0, damping = opts.damping ?? 0, roomSize = opts.roomSize ?? 1;
  const input = ctx.createGain(), output = ctx.createGain();
  const dry = ctx.createGain(); dry.gain.value = 1 - mix; input.connect(dry); dry.connect(output);
  const wet = ctx.createGain(); wet.gain.value = mix; input.connect(wet);
  const length = Math.ceil(ctx.sampleRate * decay * roomSize);
  const buffer = ctx.createBuffer(2, Math.max(1, length), ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (length * 0.28));
    if (damping > 0) {
      const coeff = Math.min(damping, 0.99);
      let prev = 0;
      for (let i = 0; i < length; i++) { prev = data[i] * (1 - coeff) + prev * coeff; data[i] = prev; }
    }
  }
  const convolver = ctx.createConvolver(); convolver.buffer = buffer;
  if (preDelay > 0) {
    const pre = ctx.createDelay(Math.max(preDelay + 0.01, 1)); pre.delayTime.value = preDelay;
    wet.connect(pre); pre.connect(convolver);
  } else wet.connect(convolver);
  convolver.connect(output);
  return { input, output };
}

export function patchDuration(patch: Patch): number {
  return Math.max(...layersOf(patch).map(layer => {
    const env = layer.envelope;
    const envDur = env ? (env.attack ?? 0) + env.decay + (env.release ?? 0) : 0.5;
    const tail = (layer.effects ?? []).reduce((max, e) => e.type === "reverb" ? Math.max(max, e.decay ?? 0.5) : Math.max(max, shimmerTail(e)), 0);
    return (layer.delay ?? 0) + envDur + tail;
  })) + 0.15;
}

/** Plays a recipe at time `when` into `destination`. `detune` is in cents; `volume` scales every layer. */
export function renderPatch(ctx: BaseAudioContext, patch: Patch, destination: AudioNode, when = ctx.currentTime, opts?: { volume?: number; detune?: number }) {
  const sources: AudioScheduledSourceNode[] = [];
  const envelopes: GainNode[] = [];
  for (const layer of layersOf(patch)) {
    const start = when + (layer.delay ?? 0);
    const { node: env, duration } = buildEnvelope(ctx, layer.envelope, (layer.gain ?? 0.5) * (opts?.volume ?? 1), start);
    envelopes.push(env);
    const src = buildSource(ctx, layer.source, start, duration);
    if (src instanceof OscillatorNode && opts?.detune) src.detune.value += opts.detune;
    let tail: AudioNode = src;
    const filters: BiquadFilterNode[] = [];
    for (const f of layer.filter ? Array.isArray(layer.filter) ? layer.filter : [layer.filter] : []) {
      const fn = buildFilter(ctx, f, start); tail.connect(fn); tail = fn; filters.push(fn);
    }
    tail.connect(env);
    let cursor: AudioNode = env;
    for (const effect of layer.effects ?? []) {
      const fx = effect.type === "reverb" ? createReverb(ctx, effect) : createShimmer(ctx, effect);
      cursor.connect(fx.input); cursor = fx.output;
    }
    cursor.connect(destination);
    sources.push(src);
    src.onended = () => { for (const n of [src, env, ...filters]) { try { n.disconnect(); } catch { /* already gone */ } } };
  }
  return {
    duration: patchDuration(patch),
    stop(fade = 0.015) {
      const now = ctx.currentTime;
      envelopes.forEach(env => { env.gain.cancelScheduledValues(now); env.gain.setValueAtTime(env.gain.value, now); env.gain.setTargetAtTime(SILENCE, now, fade / 3); });
      sources.forEach(src => { try { src.stop(now + fade + 0.05); } catch { /* already stopped */ } });
    },
  };
}

/** The recipe's pitch as a MIDI note: its loudest pitched layer's starting frequency, or middle C when it has none. */
export function patchRoot(patch: Patch): number {
  const tonal = layersOf(patch).filter(l => l.source.type !== "noise").sort((a, b) => (b.gain ?? 0.5) - (a.gain ?? 0.5))[0];
  if (!tonal || tonal.source.type === "noise") return 60;
  const f = typeof tonal.source.frequency === "number" ? tonal.source.frequency : tonal.source.frequency.start;
  return Math.max(24, Math.min(108, Math.round(69 + 12 * Math.log2(f / 440))));
}

/** Renders a recipe to a buffer, so the piano can play it at any pitch like a sample. */
export async function patchBuffer(patch: Patch, sampleRate: number): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.ceil(patchDuration(patch) * sampleRate), sampleRate);
  renderPatch(ctx, patch, ctx.destination, 0);
  return ctx.startRendering();
}
