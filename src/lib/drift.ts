import { foldMultiple } from "@/lib/transition";

/* Beat drift between two decks, and the correction for it.

   Measurement: both decks are read back to back, so their media clocks are compared at the same instant and the
   context clock drops out. What it measures is the difference in beat phase between what the two media elements report.
   It cannot see a difference between the decks' output latencies (the elements' audio path), which no media-clock
   measurement can. Two decks are therefore aligned to the limit of what their media clocks report, not to the sample.

   Correction: while the incoming deck is silent it may seek. Once it is audible it never does; it is slewed by a small
   change of playbackRate (a PI controller, capped at 1 %), which the browser's time stretcher renders without a change of
   pitch. If the error grows past what a slew can fix in time, the governor says so and the caller leaves early. */

export type BeatGrid = { bpm: number; firstBeat: number };

/** A beat position wrapped to -0.5..0.5. */
export const wrapBeats = (x: number) => x - Math.round(x);

export type PhaseReading = {
  /** Seconds the incoming media must move forward to land on the outgoing deck's beat (negative: back). */
  media: number;
  /** The same, in real seconds at the incoming deck's current rate. */
  real: number;
  /** One beat of the incoming deck, in media seconds. */
  beat: number;
};

/**
 * Beat phase error between the outgoing and incoming deck, read at one instant. The incoming track's grid is read at
 * half or double time when that is how it matches (a 64 bpm track against a 128 bpm one), so a track is lined up beat
 * for every other beat, not stretched.
 */
export function phaseReading(out: BeatGrid & { time: number }, inn: BeatGrid & { time: number; rate: number }): PhaseReading {
  const fold = foldMultiple(out.bpm, inn.bpm);
  const innBpm = inn.bpm * fold;
  const outBeats = (out.time - out.firstBeat) * out.bpm / 60;
  const innBeats = (inn.time - inn.firstBeat) * innBpm / 60;
  const diff = wrapBeats(outBeats - innBeats);
  const beat = 60 / innBpm;
  return { media: diff * beat, real: diff * beat / (inn.rate || 1), beat };
}

export type GovernorConfig = {
  /** Phase error below which the proportional term does nothing, seconds. */
  deadband: number;
  /** Proportional and integral gain: rate change per second of error, and per second of error summed over time. */
  kp: number;
  ki: number;
  /** Cap on the rate change, as a fraction (0.01 = 1 %), and on its integral part. */
  maxTrim: number;
  maxIntegral: number;
  /** Largest rate change between two updates, so the stretcher never sees a jump. */
  slew: number;
  /** Rate changes are quantized to this, and an update smaller than it is not sent. */
  quantum: number;
  /** Seconds between rate changes, unless the change is large: each one is a new setting for the stretcher. */
  holdFor: number;
  /** While silent: past this error, seek. */
  seekAbove: number;
  /** While audible: past this error with time left, give up on sync. */
  fallbackAbove: number;
  /** Length of the median window, in readings. */
  window: number;
  /** A deck whose clock gives no usable reading for this long is not trusted, seconds. */
  staleAfter: number;
  /** Seconds the incoming deck gets to settle after a seek before it is read again. */
  settle: number;
};

export const DEFAULT_GOVERNOR: GovernorConfig = {
  deadband: 0.003, kp: 0.5, ki: 0.06, maxTrim: 0.01, maxIntegral: 0.004, slew: 0.002, quantum: 0.0004, holdFor: 0.5,
  seekAbove: 0.012, fallbackAbove: 0.05, window: 5, staleAfter: 1.2, settle: 0.25,
};

export type Reading = {
  /** Seconds, any monotonic clock (the performance clock). */
  time: number;
  /** The phase error in real seconds, or null when a clock could not be read. */
  error: number | null;
  /** Whether the incoming deck is heard. */
  audible: boolean;
  /** Seconds of the blend left; 0 outside a blend. */
  remaining: number;
};

export type Decision =
  | { kind: "hold" }
  | { kind: "trim"; trim: number }
  /** Move the (silent) incoming deck by `by` media seconds. */
  | { kind: "seek"; by: number }
  /** Sync cannot be kept; leave the overlap early. */
  | { kind: "fallback"; reason: string };

const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

/**
 * Turns a stream of phase readings into corrections. It owns no clock and no audio, so it runs the same against a real
 * deck and against the simulated ones in the tests.
 *
 * - silent: seek when the filtered error is past `seekAbove`, then wait `settle` for the element to re-time. `ready`
 *   turns true once three filtered readings in a row sit inside the deadband.
 * - audible: never seek. trim = kp * error (outside the deadband) + an integral that learns a steady tempo mismatch, such
 *   as an estimated bpm that is a few hundredths off, which a P term alone would leave as a constant offset.
 */
export class DriftGovernor {
  private readonly cfg: GovernorConfig;
  private readonly recent: number[] = [];
  private integral = 0;
  private applied = 0;
  private lastTime: number | null = null;
  private appliedAt = -Infinity;
  private lastGood: number | null = null;
  private quietUntil = 0;
  private settled = 0;
  /** The filtered error, seconds, as of the last reading; null before the window has a reading. */
  filtered: number | null = null;

  constructor(cfg: Partial<GovernorConfig> = {}, private readonly maxTrim = cfg.maxTrim ?? DEFAULT_GOVERNOR.maxTrim) {
    this.cfg = { ...DEFAULT_GOVERNOR, ...cfg, maxTrim };
  }

  /** The rate change in force, as a fraction of the base rate. */
  get trim() { return this.applied; }
  /** Three filtered readings in a row inside the deadband. */
  get ready() { return this.settled >= 3; }

  /** Forget the integral and the window: the base rate changed, or a seek moved the deck. */
  reset() { this.recent.length = 0; this.integral = 0; this.settled = 0; this.filtered = null; }

  update(r: Reading): Decision {
    const c = this.cfg;
    if (r.error === null || !Number.isFinite(r.error)) {
      if (this.lastGood !== null && r.time - this.lastGood > c.staleAfter && r.audible && r.remaining > 1) return { kind: "fallback", reason: "clock unreadable" };
      return { kind: "hold" };
    }
    this.lastGood = r.time;
    if (r.time < this.quietUntil) return { kind: "hold" };
    this.recent.push(r.error);
    if (this.recent.length > c.window) this.recent.shift();
    const err = this.filtered = median(this.recent);
    const dt = this.lastTime === null ? 0 : Math.min(1, Math.max(0, r.time - this.lastTime));
    this.lastTime = r.time;
    this.settled = Math.abs(err) <= c.deadband ? this.settled + 1 : 0;

    if (!r.audible) {
      if (this.recent.length >= 3 && Math.abs(err) > c.seekAbove) {
        this.quietUntil = r.time + c.settle; this.reset();
        return { kind: "seek", by: err };
      }
      return { kind: "hold" };
    }

    if (Math.abs(err) > c.fallbackAbove && r.remaining > 2) return { kind: "fallback", reason: `${(err * 1000).toFixed(0)} ms off the beat` };

    const p = Math.abs(err) > c.deadband ? c.kp * err : 0;
    const saturated = Math.abs(p + this.integral) >= this.maxTrim;
    // No integrating while saturated or while the error is still large: it would wind up and overshoot.
    if (!saturated && Math.abs(err) < 0.02) this.integral = Math.max(-c.maxIntegral, Math.min(c.maxIntegral, this.integral + c.ki * err * dt));
    let want = Math.max(-this.maxTrim, Math.min(this.maxTrim, p + this.integral));
    want = Math.max(this.applied - c.slew, Math.min(this.applied + c.slew, want));
    // Quantizing can round past the cap, so the cap is applied again.
    want = Math.max(-this.maxTrim, Math.min(this.maxTrim, Math.round(want / c.quantum) * c.quantum));
    const change = Math.abs(want - this.applied);
    if (change < c.quantum / 2) return { kind: "hold" };
    if (r.time - this.appliedAt < c.holdFor && change < 4 * c.quantum) return { kind: "hold" };
    this.applied = want; this.appliedAt = r.time;
    return { kind: "trim", trim: want };
  }
}

/** Rate change that is still inaudible without a pitch lock: 0.3 % is about 5 cents. */
export const UNLOCKED_MAX_TRIM = 0.003;
/** Largest tempo change allowed without pitch lock: 1.5 % is about 26 cents, past what an ear takes as a tuning drift. */
export const UNLOCKED_MAX_RATE_DEVIATION = 0.015;

/** A rate change in cents of pitch, which is what it costs when the browser does not keep pitch. */
export const rateCents = (rate: number) => 1200 * Math.log2(rate);
