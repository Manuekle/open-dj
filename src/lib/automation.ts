/* AudioParam scheduling helpers.

   What these guarantee: an event written to an AudioParam runs on the audio thread, against the context clock, whatever
   the main thread is doing (a background tab, a long GC, a React render). That is the only timing in this app that is
   sample-accurate. A transition is written whole, ahead of time, as a chain of linear ramps rather than driven by a
   timer.

   Why ramps and not setValueCurveAtTime: cancelling is the hard part, and a ramp chain cancels the same way everywhere.
   cancelScheduledValues(t) drops every event at or after t. A curve that has started is a single event; engines differ on
   whether cancelling inside it stops it, and an event placed inside a running curve throws NotSupportedError. A ramp
   chain has none of that, and costs a few thousand events per lane at most. */

/** Ramp breakpoints per second of automation, and the bounds on a lane's breakpoint count. */
export const POINTS_PER_SECOND = 40;
export const MIN_POINTS = 32;
export const MAX_POINTS = 1600;

export const pointCount = (seconds: number) => Math.max(MIN_POINTS, Math.min(MAX_POINTS, Math.ceil(seconds * POINTS_PER_SECOND)));

/** fn sampled at n evenly spaced progress values from `from` to `to`, both ends included. */
export function sampleCurve(fn: (t: number) => number, from: number, to: number, n: number) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = fn(from + (to - from) * (n === 1 ? 1 : i / (n - 1)));
  return out;
}

type Scheduling = Pick<AudioParam, "setValueAtTime" | "linearRampToValueAtTime" | "cancelScheduledValues">;

/**
 * Writes `values` as a ramp chain from `start` over `duration`. The first value is set at `start`, so the lane holds
 * whatever it held before until then.
 */
export function rampChain(param: Scheduling, values: ArrayLike<number>, start: number, duration: number) {
  const n = values.length;
  if (n === 0) return;
  param.setValueAtTime(finite(values[0]), start);
  for (let i = 1; i < n; i++) param.linearRampToValueAtTime(finite(values[i]), start + duration * i / (n - 1));
}

/** A value an engine will take: NaN or infinity in the timeline throws or silences the node. */
const finite = (v: number) => (Number.isFinite(v) ? v : 0);

/**
 * Removes every event from `time` on and pins the lane at `current` from `time`, so what comes next starts where the
 * old automation was. `current` is the caller's own value for the lane at `time`: the analytic value of the ramps it
 * wrote. cancelAndHoldAtTime would read the engine's true value instead, but it is not used: Chrome does not leave a
 * lane usable for the events placed right after it at the same time (the self-test on /diagnostics caught the faders
 * staying at zero after a cancel), Safari and Firefox do not have it, and one path that behaves the same everywhere is
 * worth more than the few thousandths it would save.
 */
export function holdAt(param: Scheduling, time: number, current: number) {
  param.cancelScheduledValues(time);
  param.setValueAtTime(finite(current), time);
}

/** Cancels from `time` on and ramps the lane to `target` over `seconds`, from the value it holds at `time`. */
export function releaseTo(param: Scheduling, time: number, current: number, target: number, seconds: number) {
  holdAt(param, time, current);
  if (seconds > 0) param.linearRampToValueAtTime(finite(target), time + seconds);
  else param.setValueAtTime(finite(target), time);
}
