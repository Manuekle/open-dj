import { describe, expect, it } from "vitest";
import { buildCharts, DIFFICULTIES } from "@/lib/rhythm-game/chart";
import { Judge, MISS_AFTER, gradeOf } from "@/lib/rhythm-game/judge";

const RATE = 11025;

/** A kick on every beat and a hat on every off-beat, 120 bpm. */
function drums(seconds: number, bpm = 120) {
  const x = new Float32Array(Math.round(seconds * RATE));
  const beat = 60 / bpm;
  const burst = (at: number, hz: number, decay: number, len: number, gain: number) => {
    const s = Math.round(at * RATE);
    for (let i = 0; i < len && s + i < x.length; i++) x[s + i] += gain * Math.sin(2 * Math.PI * hz * i / RATE) * Math.exp(-i / decay);
  };
  for (let t = 0.5; t < seconds - 0.2; t += beat) {
    burst(t, 70, 600, 3000, 0.8);
    burst(t + beat / 2, 3000, 120, 800, 0.3);
  }
  return x;
}

describe("charts from audio", () => {
  const set = buildCharts(drums(40), RATE, 120);

  it("gets denser and uses more lanes as the difficulty goes up", () => {
    const counts = DIFFICULTIES.map(d => set.charts[d.id].notes.length);
    expect(counts[0]).toBeGreaterThan(8);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
    expect(set.charts.expert.notes.length).toBeGreaterThan(set.charts.easy.notes.length);
    for (const d of DIFFICULTIES) for (const n of set.charts[d.id].notes) { expect(n.lane).toBeGreaterThanOrEqual(0); expect(n.lane).toBeLessThan(d.lanes); }
  });

  it("keeps notes sorted, off the start and the end, and apart by the difficulty's gap", () => {
    for (const d of DIFFICULTIES) {
      const notes = set.charts[d.id].notes;
      for (let i = 1; i < notes.length; i++) expect(notes[i].t).toBeGreaterThanOrEqual(notes[i - 1].t);
      expect(notes[0].t).toBeGreaterThan(1);
      expect(notes[notes.length - 1].t).toBeLessThan(set.duration);
    }
  });

  it("puts easy notes on the drum hits", () => {
    const beat = 0.5;
    const off = set.charts.easy.notes.map(n => { const r = (n.t - 0.5) % beat; return Math.min(r, beat - r); });
    expect(off.filter(o => o < 0.06).length / off.length).toBeGreaterThan(0.8);
  });

  it("makes an empty chart from silence rather than failing", () => {
    const silent = buildCharts(new Float32Array(RATE * 12), RATE);
    for (const d of DIFFICULTIES) expect(silent.charts[d.id].notes).toEqual([]);
  });
});

describe("judging", () => {
  const chart = { difficulty: "easy" as const, lanes: 4, notes: [{ t: 2, lane: 0 }, { t: 3, lane: 1 }, { t: 3, lane: 2 }] };

  it("grades a press by how far it is from the note and builds the combo", () => {
    const j = new Judge(chart);
    expect(j.press(0, 2.01)?.judgement).toBe("perfect");
    expect(j.press(1, 3.07)?.judgement).toBe("great");
    expect(j.press(2, 3.12)?.judgement).toBe("good");
    expect(j.stats.combo).toBe(3);
    expect(j.stats.counts).toEqual({ perfect: 1, great: 1, good: 1, miss: 0 });
    expect(j.finished).toBe(true);
  });

  it("ignores a press long before a note and misses a note left behind", () => {
    const j = new Judge(chart);
    expect(j.press(0, 1.5)).toBeNull();
    expect(j.advance(2 + MISS_AFTER - 0.01)).toEqual([]);
    expect(j.advance(2 + MISS_AFTER + 0.01)).toHaveLength(1);
    expect(j.stats.combo).toBe(0);
    expect(j.press(0, 2.2)).toBeNull();
  });

  it("breaks the combo on a miss and keeps the best", () => {
    const j = new Judge(chart);
    j.press(0, 2);
    j.advance(3.5);
    expect(j.stats.maxCombo).toBe(1);
    expect(j.stats.combo).toBe(0);
    expect(j.stats.counts.miss).toBe(2);
  });

  it("grades a run", () => {
    expect(gradeOf(1, 0, 10)).toBe("S");
    expect(gradeOf(0.96, 1, 10)).toBe("A");
    expect(gradeOf(0.5, 5, 10)).toBe("D");
  });
});
