import type { Track, TransitionEffect, TransitionEq, TransitionPlan, TransitionPreset, TransitionStems, VolumeCurve } from "@/lib/types";
import { barIndexAt, barStarts, beatTimes, gridBpm } from "@/lib/grid";
import { entryPoint, exitPoint } from "@/lib/mix-points";

/* The one place transitions are defined: the audio engine and the editor's curves both read these functions, so what
   the editor draws is what plays. t runs 0..1 across the transition. */

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const eqPower = (v: number) => Math.sin(clamp01(v) * Math.PI / 2);

/** Gain of the outgoing and incoming track, 0..1. */
export function volumeAt(curve: VolumeCurve, t: number) {
  if (curve === "overlap") return { out: eqPower((1 - t) / 0.25), in: eqPower(t / 0.25) };
  if (curve === "fade") return { out: eqPower(1 - t / 0.6), in: eqPower((t - 0.4) / 0.6) };
  return { out: eqPower(1 - t), in: eqPower(t) };
}

/** Low band gain in dB: the bass swaps over the middle tenth. */
export function lowAt(eq: TransitionEq, t: number) {
  if (eq === "none") return { out: 0, in: 0 };
  const k = clamp01((t - 0.45) / 0.1);
  return { out: -24 * k, in: -24 * (1 - k) };
}

const ramp = (t: number, from: number, to: number) => clamp01((t - from) / (to - from));

export type SendFx = "echo" | "reverb" | "flanger";
/** The send effect an automatic effect routes the outgoing track through, if any. */
export function effectSend(effect: TransitionEffect): SendFx | null {
  return effect === "echo" ? "echo" : effect === "reverb" || effect === "swap" ? "reverb" : effect === "flanger" ? "flanger" : null;
}
/** Whether an effect moves the deck color filters (low or high pass). */
export const effectUsesColor = (effect: TransitionEffect) => effect === "lowpass" || effect === "rise" || effect === "reverb" || effect === "swap";

/** Everything an effect does at t: the color filter of each side (-1 low-pass .. +1 high-pass), the send effect's depth
    on the outgoing deck and how far its dry signal gives way to that send (the wash). */
export function effectAt(effect: TransitionEffect, t: number) {
  const none = { outColor: 0, inColor: 0, amount: 0, wash: 0 };
  if (effect === "lowpass") return { ...none, outColor: -0.85 * t * t };
  if (effect === "rise") return { ...none, inColor: 0.7 * (1 - t) * (1 - t) };
  if (effect === "echo") return { ...none, amount: 0.7 * ramp(t, 0.5, 1) };
  // A space out: the old track closes behind a low pass and drowns in its own reverb as it leaves.
  if (effect === "reverb") return { ...none, outColor: -0.4 * t * t, amount: 0.95 * ramp(t, 0.2, 0.9), wash: 0.55 * ramp(t, 0.5, 1) };
  // A flange that swells to the middle of the blend and clears again.
  if (effect === "flanger") return { ...none, amount: 0.9 * Math.sin(Math.PI * t) };
  // Filter up and down: the old track thins out under a rising high pass and reverb, the new one opens up from a closed low pass.
  if (effect === "swap") return { outColor: 0.85 * t * t, inColor: -0.85 * (1 - t) * (1 - t), amount: 0.6 * ramp(t, 0.35, 1), wash: 0.25 * ramp(t, 0.6, 1) };
  return none;
}

/** The multiple (half, same or double time) that brings a tempo of `own` bpm nearest `target`, so a 64 bpm track
    reads as 128 against a 128 bpm one and is matched beat for every other beat instead of stretched. */
export function foldMultiple(target: number, own: number) {
  const off = (m: number) => Math.abs(Math.log(own * m / target));
  return [0.5, 2].reduce((best, m) => off(m) < off(best) ? m : best, 1);
}
/** Playback rate that lands a track of `own` bpm on a `target` bpm grid, half and double time folded, held to what a
    deck can stretch to (0.75..1.25). */
export function syncRate(target: number, own: number) {
  return Math.min(1.25, Math.max(0.75, target / (own * foldMultiple(target, own))));
}
/** Tempo the incoming deck plays at, as the ratio of its media seconds to the outgoing deck's, so the editor and the
    engine read the same overlap. */
export function tempoRatio(from: Track, to: Track, fromRate = 1) {
  const a = gridBpm(from), b = gridBpm(to);
  if (!a || !b) return 1;
  return syncRate(a * fromRate, b) / fromRate;
}
/** The same ratio for a plan: a plan with sync off leaves the incoming deck at its own rate, so its media seconds run
    at toRate per fromRate of the outgoing deck's. */
export function planRatio(plan: Pick<TransitionPlan, "sync">, from: Track, to: Track, fromRate = 1, toRate = 1) {
  return plan.sync === false ? toRate / fromRate : tempoRatio(from, to, fromRate);
}

/** Loudness every track is trimmed toward on load: LUFS when the analysis has it, else dBFS (median of one-second
    windows). -11 LUFS leaves the master room for two decks at once. */
export const TARGET_LUFS = -11;
export const TARGET_LOUDNESS = -12;
/** Trim a deck gets on load, dB, in half steps within ±12. */
export function autoTrim(track: Track) {
  const gap = track.lufs !== undefined ? TARGET_LUFS - track.lufs : track.loudness !== undefined ? TARGET_LOUDNESS - track.loudness : 0;
  return Math.round(Math.max(-12, Math.min(12, gap)) * 2) / 2;
}

/** Gain of the outgoing and incoming vocals stem: the old voice is gone by 40%, the new one arrives from 60%. */
export function vocalsAt(stems: TransitionStems | undefined, t: number) {
  if (stems !== "vocals") return { out: 1, in: 1 };
  return { out: 1 - clamp01((t - 0.1) / 0.3), in: clamp01((t - 0.6) / 0.3) };
}

export const PRESETS: Record<Exclude<TransitionPreset, "custom">, { label: string; volume: VolumeCurve; eq: TransitionEq; effect: TransitionEffect }> = {
  auto: { label: "Auto", volume: "smooth", eq: "bass", effect: "lowpass" },
  fade: { label: "Fade", volume: "fade", eq: "none", effect: "none" },
  rise: { label: "Rise", volume: "overlap", eq: "none", effect: "rise" },
  space: { label: "Space", volume: "smooth", eq: "bass", effect: "swap" },
  blend: { label: "Blend", volume: "smooth", eq: "none", effect: "none" },
};

/** Seconds per beat. Without an estimated tempo a nominal 120 bpm only sizes a transition in seconds; nothing snaps to it. */
export const beatOf = (track: Track) => 60 / (track.bpm ?? 120);
export const barOf = (track: Track) => 4 * beatOf(track);
/** Seconds of track time the transition covers on that track. */
export const spanOn = (track: Track, bars: number) => bars * barOf(track);
/** The nearest bar line to a time, or the time itself on a track with no beat grid. */
export function snapToBar(track: Track, at: number, mode: "round" | "floor" = "round") {
  // Real bar starts from the beat tracker where the track has them (they follow a tempo that moves); else the bpm grid.
  const bars = barStarts(track);
  if (bars) {
    const i = barIndexAt(bars, at);
    if (i < 0) return Math.max(0, at);
    const next = bars[i + 1];
    return mode === "round" && next !== undefined && next - at < at - bars[i] ? next : bars[i];
  }
  if (!track.bpm) return Math.max(0, at);
  const grid = track.firstBeat ?? 0, bar = barOf(track);
  const n = (at - grid) / bar;
  return Math.max(grid, grid + (mode === "floor" ? Math.floor(n) : Math.round(n)) * bar);
}

/** The nearest beat to a time: a tracked beat where the track has them (they follow a tempo that moves), else the bpm
    grid, else the time itself on a track with no tempo. The editor's points snap with it, so a dragged point lands where
    the planner and the engine put theirs. */
export function snapToBeat(track: Track, at: number) {
  const beats = beatTimes(track);
  if (beats) {
    const i = barIndexAt(beats, at);
    if (i < 0) return beats[0];
    const next = beats[i + 1];
    return next !== undefined && next - at < at - beats[i] ? next : beats[i];
  }
  if (!track.bpm) return Math.max(0, at);
  const grid = track.firstBeat ?? 0, beat = beatOf(track);
  return Math.max(grid, grid + Math.round((at - grid) / beat) * beat);
}
/** A time moved by whole bars: along the tracked bars where there are any, else by the bar length of the tempo. */
export function stepBars(track: Track, at: number, bars: number) {
  const starts = barStarts(track);
  if (starts) {
    const i = Math.max(0, barIndexAt(starts, at + 1e-3));
    return starts[Math.max(0, Math.min(starts.length - 1, i + bars))];
  }
  return Math.max(0, at + bars * barOf(track));
}

function loudness(energy: number[], second: number, span = 4) {
  const slice = energy.slice(Math.max(0, second), second + span);
  if (!slice.length) return -90;
  return 10 * Math.log10(slice.reduce((sum, db) => sum + 10 ** (db / 10), 0) / slice.length);
}

/* The structure heuristics below read only the loudness series: a stretch within 1.5 dB of the track's median loudness
   counts as its body. They find where the level steps, not verses, choruses or downbeats. */

/** Where the body of a track ends: two seconds into its last 4 s window within 1.5 dB of its median loudness, or null
    without a loudness series. */
export function bodyEnd(track: Track): number | null {
  const energy = track.energy ?? [];
  const target = (track.loudness ?? -12) - 1.5;
  let last = -1;
  for (let s = 0; s < energy.length - 3; s++) if (loudness(energy, s) >= target) last = s;
  return last >= 0 ? last + 2 : null;
}
/** Where the body of a track starts: two seconds into its first 4 s window within 1.5 dB of its median loudness, or
    null without a loudness series. */
export function mainStart(track: Track): number | null {
  const energy = track.energy ?? [];
  const target = (track.loudness ?? -12) - 1.5;
  for (let s = 0; s < energy.length; s++) if (loudness(energy, s) >= target) return s + 2;
  return null;
}

/** Where the outgoing track starts its outro: the bar after its last 4 s within 1.5 dB of its median loudness. */
export function outroStart(track: Track, bars: number) {
  // With phrases and sections analyzed: the start that ends the blend on a phrase boundary over the outro.
  const point = exitPoint(track, bars);
  if (point) return point.at;
  const latest = Math.max(0, track.duration - spanOn(track, bars) - 1);
  const end = bodyEnd(track);
  const found = end !== null ? snapToBar(track, end) : latest;
  // An outro that starts before 60% of the track is a breakdown, not the end; fall back to the last bar that fits.
  return Math.min(found < track.duration * 0.6 ? latest : found, snapToBar(track, latest, "floor"));
}

/** Where the incoming track enters: the bar that brings its main section in as the transition ends. */
export function mainEntry(track: Track, bars: number) {
  const point = entryPoint(track, bars);
  if (point) return point.at;
  return snapToBar(track, (mainStart(track) ?? 0) - spanOn(track, bars), "floor");
}

/** How two Camelot codes sit on the wheel: the same key, a step round (a fifth), the relative major or minor, an
    energy boost (two steps, or the +7 "semitone up" jump), or a clash. */
export type Harmony = "same" | "adjacent" | "relative" | "boost" | "clash" | "unknown";
export function harmony(a?: string, b?: string): Harmony {
  const pa = /^(\d+)([AB])$/.exec(a ?? ""), pb = /^(\d+)([AB])$/.exec(b ?? "");
  if (!pa || !pb) return "unknown";
  const step = (Number(pb[1]) - Number(pa[1]) + 12) % 12;
  if (pa[2] !== pb[2]) return step === 0 ? "relative" : "clash";
  if (step === 0) return "same";
  if (step === 1 || step === 11) return "adjacent";
  if (step === 2 || step === 7) return "boost";
  return "clash";
}
export const HARMONY_LABEL: Record<Harmony, string> = {
  same: "the same key", adjacent: "a step round the Camelot wheel", relative: "relative major and minor",
  boost: "an energy boost up the wheel", clash: "keys that clash", unknown: "keys not yet known",
};
/** Tempo change the incoming track needs, as a fraction, folding half and double time onto the nearest. */
export function tempoGap(from: Track, to: Track) {
  const a = gridBpm(from), b = gridBpm(to);
  if (!a || !b) return null;
  return b * foldMultiple(a, b) / a - 1;
}
/** Mean of a per-second series between two times, in dB through power, or null without data. */
export function meanDb(series: number[] | undefined, start: number, end: number) {
  if (!series?.length) return null;
  const slice = series.slice(Math.max(0, Math.floor(start)), Math.max(Math.floor(start) + 1, Math.ceil(end)));
  if (!slice.length) return null;
  return 10 * Math.log10(slice.reduce((sum, db) => sum + 10 ** (db / 10), 0) / slice.length);
}
function median(series: number[]) {
  const sorted = series.filter(v => v > -90).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : -90;
}
/** How loud a track's lows are over a stretch, dB against its own median low band. */
export function bassOver(track: Track, start: number, end: number) {
  const low = track.bands?.low;
  const level = meanDb(low, start, end);
  return level === null || !low ? null : level - median(low);
}
/** Share of a stretch, 0..1, where the vocals stem is within 20 dB of its loudest second. */
export function vocalsOver(track: Track, start: number, end: number) {
  const vocals = track.stemEnergy?.[0];
  if (!vocals?.length) return null;
  const top = Math.max(...vocals), slice = vocals.slice(Math.max(0, Math.floor(start)), Math.ceil(end));
  return slice.length ? slice.filter(v => v > top - 20).length / slice.length : 0;
}

const pctText = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;

/**
 * The automatic plan, from the numbers a DJ reads before a blend:
 * - length: a long blend only when the keys agree and the tempo moves under 3%; a clash gets 4 bars; a tempo jump of
 *   more than 8% gets a 2-bar echo out, since stretching that far is audible.
 * - effect: clashing keys go under a low pass on the outgoing track, which takes out the mids where the clash is heard.
 * - eq: the lows swap at the middle when both tracks carry bass across the overlap (within 6 dB of their median), so
 *   two kick drums and bass lines never stack; otherwise the bass is left alone.
 * - stems: when both tracks have stems and both sing across the overlap, the vocals hand over instead of overlapping.
 */
export function autoPlan(from: Track, to: Track): TransitionPlan {
  const h = harmony(from.camelot, to.camelot), gap = tempoGap(from, to);
  const compatible = h === "same" || h === "adjacent" || h === "relative";
  const jump = gap !== null && Math.abs(gap) > 0.08;
  let bars = jump ? 2 : h === "clash" ? 4 : compatible && gap !== null && Math.abs(gap) <= 0.03 ? 16 : 8;
  const notes: string[] = [];
  notes.push(from.camelot && to.camelot ? `Keys ${from.key} (${from.camelot}) into ${to.key} (${to.camelot}): ${HARMONY_LABEL[h]}.` : `Keys: ${HARMONY_LABEL.unknown}.`);
  if (gap !== null) notes.push(`Tempo ${from.bpm!.toFixed(1)} into ${to.bpm!.toFixed(1)} bpm: the incoming deck moves ${pctText(gap === null ? 0 : -gap / (1 + gap))}.`);
  // A blend takes at most a third of either track, so a short one still has a body to play.
  const fits = (n: number) => spanOn(from, n) <= from.duration / 3 && spanOn(to, n) <= to.duration / 3;
  const wanted = bars;
  while (bars > 1 && !fits(bars)) bars /= 2;
  if (bars < wanted) notes.push(`A short track: the blend is cut to ${bars} bar${bars === 1 ? "" : "s"} so it fits.`);
  const outAt = outroStart(from, bars), inAt = mainEntry(to, bars);
  const outSpan = spanOn(from, bars), inSpan = spanOn(to, bars);

  // Without a beat grid on both sides nothing can be matched or placed on a bar: a plain equal-power crossfade.
  if (gap === null) {
    const missing = [from, to].filter(t => !t.bpm).map(t => t.title).join(" and ");
    notes.push(`No tempo estimate for ${missing}, so this is a plain equal-power crossfade over about ${Math.round(outSpan)} s, not on the beat.`);
    return { fromId: from.id, toId: to.id, outAt, inAt, bars, volume: "smooth", eq: "none", effect: "none", stems: "none", preset: "auto", by: "auto", notes };
  }

  const gain = (meanDb(to.energy, inAt, inAt + inSpan) ?? 0) - (meanDb(from.energy, outAt, outAt + outSpan) ?? 0);
  // Without a reason for a rescue, the effect follows where the energy goes: up gets a build, down a wash, level a flange.
  const effect: TransitionEffect = jump ? "echo" : h === "clash" ? "reverb" : bars < 8 ? "lowpass" : gain > 1.5 ? "swap" : gain < -1.5 ? "reverb" : "flanger";
  if (jump) notes.push("The tempo gap is over 8%, so the old track echoes out over 2 bars instead of a long stretched blend.");
  else if (h === "clash") notes.push("A low pass and a reverb wash on the outgoing track hide the clash in the mids over a short 4-bar blend.");
  else notes.push(`${bars} bars: the keys sit together${bars === 16 ? " and the tempo barely moves, so the blend can run long" : ""}.`);
  if (!jump && h !== "clash") notes.push(effect === "lowpass" ? "A short blend, so a low pass takes the old track out."
    : effect === "swap" ? `Energy rises ${gain.toFixed(1)} dB into the new track, so the old one thins out under a rising high pass while the new one opens from a closed filter.`
    : effect === "reverb" ? `Energy drops ${Math.abs(gain).toFixed(1)} dB into the new track, so the old one washes out into reverb.`
    : "Energy stays level, so a flanger sweeps over the old track as the new one arrives.");

  const bassOut = bassOver(from, outAt, outAt + outSpan), bassIn = bassOver(to, inAt, inAt + inSpan);
  const bothBass = bassOut === null || bassIn === null ? true : bassOut > -6 && bassIn > -6;
  const eq: TransitionEq = jump ? "none" : bothBass ? "bass" : "none";
  if (bassOut !== null && bassIn !== null && !jump) notes.push(eq === "bass"
    ? `Both carry bass through the overlap (${bassOut.toFixed(1)} and ${bassIn.toFixed(1)} dB against their medians), so the lows swap at the middle.`
    : `One side has little bass in the overlap (${bassOut.toFixed(1)} and ${bassIn.toFixed(1)} dB against their medians), so the lows are left to cross with the volume.`);

  const vocalsOut = vocalsOver(from, outAt, outAt + outSpan), vocalsIn = vocalsOver(to, inAt, inAt + inSpan);
  const stems: TransitionStems = vocalsOut !== null && vocalsIn !== null && vocalsOut > 0.3 && vocalsIn > 0.3 ? "vocals" : "none";
  if (stems === "vocals") notes.push("Both tracks sing across the overlap, so the outgoing vocals leave early and the new ones come in late.");
  if (from.lufs !== undefined && to.lufs !== undefined) notes.push(`Loudness ${from.lufs.toFixed(1)} and ${to.lufs.toFixed(1)} LUFS: the trims match them on load.`);

  return { fromId: from.id, toId: to.id, outAt, inAt, bars, volume: "smooth", eq, effect, stems, preset: "auto", by: "auto", notes };
}
