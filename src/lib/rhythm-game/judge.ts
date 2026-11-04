import type { Chart } from "@/lib/rhythm-game/chart";

/* The rules of play, apart from the screen and the audio so they can be tested: which note a key press belongs to, how
   good it was, and what that does to the score and the combo. Times are seconds on the song's own clock. */

export type Judgement = "perfect" | "great" | "good" | "miss";
/** How far from the note a press may land and still count, seconds. */
export const WINDOW: Record<Exclude<Judgement, "miss">, number> = { perfect: 0.045, great: 0.09, good: 0.135 };
/** A note this far behind the song is lost. Presses this far before a note are ignored, not punished. */
export const MISS_AFTER = 0.16;
const POINTS = { perfect: 300, great: 200, good: 100, miss: 0 } as const;
const WEIGHT = { perfect: 1, great: 0.8, good: 0.5, miss: 0 } as const;

export type Grade = "S" | "A" | "B" | "C" | "D";
export type Stats = {
  score: number; combo: number; maxCombo: number; judged: number; total: number;
  counts: Record<Judgement, number>;
  /** 0..1, weighted over the notes judged so far. */
  accuracy: number;
};
export type Outcome = { judgement: Judgement; lane: number; /** Seconds early (negative) or late (positive); 0 for a miss. */ offset: number };

type Live = { t: number; lane: number; done: boolean };

export class Judge {
  readonly notes: Live[];
  private readonly lanes: number[][];
  private readonly head: number[];
  private weight = 0;
  stats: Stats;

  constructor(chart: Chart) {
    this.notes = chart.notes.map(n => ({ t: n.t, lane: n.lane, done: false }));
    this.lanes = Array.from({ length: chart.lanes }, () => []);
    this.notes.forEach((n, i) => this.lanes[n.lane].push(i));
    this.head = this.lanes.map(() => 0);
    this.stats = { score: 0, combo: 0, maxCombo: 0, judged: 0, total: this.notes.length, counts: { perfect: 0, great: 0, good: 0, miss: 0 }, accuracy: 1 };
  }

  private settle(judgement: Judgement, lane: number, offset: number): Outcome {
    const s = this.stats;
    s.counts[judgement]++;
    s.judged++;
    this.weight += WEIGHT[judgement];
    if (judgement === "miss") s.combo = 0;
    else {
      s.combo++;
      s.maxCombo = Math.max(s.maxCombo, s.combo);
      s.score += Math.round(POINTS[judgement] * (1 + Math.min(s.combo, 50) / 50));
    }
    s.accuracy = this.weight / s.judged;
    return { judgement, lane, offset };
  }

  /** The oldest note in the lane still waiting, or -1. */
  private next(lane: number) {
    const list = this.lanes[lane];
    while (this.head[lane] < list.length && this.notes[list[this.head[lane]]].done) this.head[lane]++;
    return this.head[lane] < list.length ? list[this.head[lane]] : -1;
  }

  /** A press in `lane` at song time `t`: the outcome, or null when it is too early for any note or the lane is empty. */
  press(lane: number, t: number): Outcome | null {
    const i = this.next(lane);
    if (i < 0) return null;
    const note = this.notes[i], offset = t - note.t;
    if (offset < -MISS_AFTER) return null;
    // A press past the good window but before the note is lost is a miss on that note, as in any tap game.
    const d = Math.abs(offset);
    const judgement: Judgement = d <= WINDOW.perfect ? "perfect" : d <= WINDOW.great ? "great" : d <= WINDOW.good ? "good" : "miss";
    note.done = true;
    return this.settle(judgement, lane, judgement === "miss" ? 0 : offset);
  }

  /** Notes the song has left behind by `t`, each judged a miss. */
  advance(t: number): Outcome[] {
    const out: Outcome[] = [];
    for (let lane = 0; lane < this.lanes.length; lane++) {
      for (let i = this.next(lane); i >= 0 && this.notes[i].t + MISS_AFTER < t; i = this.next(lane)) {
        this.notes[i].done = true;
        out.push(this.settle("miss", lane, 0));
      }
    }
    return out;
  }

  get finished() { return this.stats.judged >= this.stats.total; }
}

export function gradeOf(accuracy: number, misses: number, total: number): Grade {
  if (total === 0) return "D";
  if (accuracy >= 0.95 && misses === 0) return "S";
  if (accuracy >= 0.9) return "A";
  if (accuracy >= 0.8) return "B";
  if (accuracy >= 0.7) return "C";
  return "D";
}
