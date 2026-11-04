import { STRUCTURE_VERSION, type Boundary, type PhraseLevel, type Rhythm, type Section, type SectionLabel, type Structure } from "@/lib/analysis-types";
import type { Features } from "@/lib/features";

/* Sections and phrases from energy, timbre, harmony and repetition.
   1. The track is cut into units: the bars of the beat grid when there is one, 2-second blocks when there is not.
   2. Each unit gets a vector (loudness, eight band levels, onset density, chroma), standardized with a floor per
      feature so that "nothing changed" stays nothing.
   3. Novelty is a checkerboard kernel over the unit-to-unit similarity (Foote 2000) at three scales; peaks are section
      boundaries.
   4. Phrases: for 4, 8, 16 and 32 bars, how many of the boundaries fall on one grid, corrected for chance. A length
      with too little evidence is left out, not reported with a low number.
   5. Each section is scored for intro, build-up, main, breakdown and outro from its position, loudness, bass, trend
      and repetition. These are rules of thumb, not a trained classifier; see the scores' doc in analysis-types.ts.
   Vocals are never inferred: nothing here can tell a voice from a lead instrument. */

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const BLOCK_SECONDS = 2;
const MAX_UNITS = 2400;
const SCALES = [2, 4, 8];
const MIN_PEAK = 0.22;
const GROUPS = 8;
/** Boundaries weaker than this (a chord change inside one arrangement, a slow ramp) stay in the list for phrase evidence
    and as mix anchors, but do not split a section. Set on synthetic songs; to be re-tuned on real recordings. */
const MAJOR = 0.4;

type Unit = { start: number; end: number };

function unitsFor(rhythm: Rhythm, duration: number): { units: Unit[]; unit: "bar" | "time"; bars: number[] } {
  if ((rhythm.grid === "steady" || rhythm.grid === "variable") && rhythm.beats.length >= 16) {
    const phase = rhythm.downbeat.phase, b = rhythm.beats;
    const bars: number[] = [];
    for (let i = phase; i < b.length; i += 4) bars.push(b[i]);
    const units: Unit[] = [];
    for (let k = 0; k + 1 < bars.length; k++) units.push({ start: bars[k], end: bars[k + 1] });
    if (units.length >= 8) return { units, unit: "bar", bars };
  }
  const units: Unit[] = [];
  for (let t = 0; t + BLOCK_SECONDS <= duration; t += BLOCK_SECONDS) units.push({ start: t, end: t + BLOCK_SECONDS });
  return { units, unit: "time", bars: [] };
}

/** Per-unit feature vectors, standardized and weighted: [loudness, 8 band groups, onset density, 12 chroma]. */
function describe(f: Features, units: Unit[]) {
  const dim = 1 + GROUPS + 1 + 12;
  const raw = new Float32Array(units.length * dim);
  const lowDb = new Float32Array(units.length), levelDb = new Float32Array(units.length);
  const perGroup = f.bandCount / GROUPS;
  const frames = f.level.length, slow = f.chroma.length / 12;
  for (let u = 0; u < units.length; u++) {
    const a = Math.max(0, Math.min(frames - 1, Math.floor(units[u].start * f.fps)));
    const b = Math.max(a + 1, Math.min(frames, Math.ceil(units[u].end * f.fps)));
    let level = 0, onset = 0, low = 0;
    const group = new Float64Array(GROUPS);
    for (let t = a; t < b; t++) {
      level += f.level[t]; onset += f.onset[t] + 1.5 * f.lowOnset[t];
      for (let k = 0; k < f.bandCount; k++) group[Math.min(GROUPS - 1, Math.floor(k / perGroup))] += f.bands[t * f.bandCount + k] / perGroup;
      for (let k = 0; k < f.lowBands; k++) low += f.bands[t * f.bandCount + k] / f.lowBands;
    }
    const n = b - a, o = u * dim;
    raw[o] = level / n;
    for (let g = 0; g < GROUPS; g++) raw[o + 1 + g] = group[g] / n;
    raw[o + 1 + GROUPS] = onset / n;
    levelDb[u] = level / n; lowDb[u] = low / n;
    const ca = Math.max(0, Math.min(slow - 1, Math.floor(units[u].start * f.chromaFps))), cb = Math.max(ca + 1, Math.min(slow, Math.ceil(units[u].end * f.chromaFps)));
    let sum = 0;
    for (let i = ca; i < cb; i++) for (let c = 0; c < 12; c++) { raw[o + 2 + GROUPS + c] += f.chroma[i * 12 + c]; sum += f.chroma[i * 12 + c]; }
    if (sum > 0) for (let c = 0; c < 12; c++) raw[o + 2 + GROUPS + c] /= sum;
  }
  // Scale each feature by what a change of it means to a listener, not by how much this particular track varies: 3 dB
  // of loudness, 4 dB in a band, 0.15 of onset density, 0.08 of a pitch class. A quiet intro and a loud drop then
  // stay as far apart as they sound, and a steady track stays at zero distance from itself.
  const scales = [3, ...Array(GROUPS).fill(4), 0.15, ...Array(12).fill(0.08)];
  const weights = [2, ...Array(GROUPS).fill(0.6), 1.5, ...Array(12).fill(0.08)];
  const wsum = weights.reduce((a, b) => a + b, 0);
  const z = new Float32Array(raw.length);
  for (let k = 0; k < dim; k++) {
    let m = 0;
    for (let u = 0; u < units.length; u++) m += raw[u * dim + k];
    m /= units.length;
    for (let u = 0; u < units.length; u++) z[u * dim + k] = (raw[u * dim + k] - m) / scales[k] * Math.sqrt(weights[k] / wsum);
  }
  return { z, dim, levelDb, lowDb };
}

function similarity(z: Float32Array, dim: number, i: number, j: number) {
  let d = 0;
  for (let k = 0; k < dim; k++) { const v = z[i * dim + k] - z[j * dim + k]; d += v * v; }
  return Math.exp(-d / 2);
}

/** Foote novelty at each unit boundary (the start of unit i), the mean over the kernel scales: the small kernel puts
    the peak on the change, the large ones keep a slow ramp from reading as one. */
function novelty(z: Float32Array, dim: number, n: number) {
  const out = new Float32Array(n);
  for (const h of SCALES) {
    const g = Array.from({ length: 2 * h }, (_, a) => Math.exp(-0.5 * ((a - h + 0.5) / (h * 0.6)) ** 2));
    for (let i = 1; i < n; i++) {
      // Only units inside the track count, so a boundary near either end is judged on the side that exists.
      let s = 0, norm = 0, before = 0, after = 0;
      for (let a = 0; a < 2 * h; a++) {
        const u = i - h + a;
        if (u < 0 || u >= n) continue;
        if (a < h) before++; else after++;
        for (let b = a; b < 2 * h; b++) {
          const v = i - h + b;
          if (v < 0 || v >= n) continue;
          const w = (a === b ? 1 : 2) * g[a] * g[b];
          s += (a < h) === (b < h) ? w * similarity(z, dim, u, v) : -w * similarity(z, dim, u, v);
          norm += w;
        }
      }
      // A kernel with fewer than two units on a side cannot tell a boundary from noise.
      if (before >= 2 && after >= 2 && norm > 0) out[i] += Math.max(0, s / norm) / SCALES.length;
    }
  }
  return out;
}

function peaks(nov: Float32Array, minGap: number) {
  const n = nov.length;
  let sum = 0, sq = 0;
  for (let i = 1; i < n; i++) { sum += nov[i]; sq += nov[i] * nov[i]; }
  const mean = sum / Math.max(1, n - 1), sd = Math.sqrt(Math.max(0, sq / Math.max(1, n - 1) - mean * mean));
  const threshold = Math.max(MIN_PEAK, mean + 0.5 * sd);
  const found: number[] = [];
  for (let i = 1; i < n - 1; i++) if (nov[i] >= threshold && nov[i] >= nov[i - 1] && nov[i] > nov[i + 1]) found.push(i);
  // Keep the stronger of two peaks closer than minGap.
  const kept: number[] = [];
  for (const i of found.sort((a, b) => nov[b] - nov[a])) if (kept.every(k => Math.abs(k - i) >= minGap)) kept.push(i);
  return kept.sort((a, b) => a - b);
}

function phraseLevels(boundaries: number[], strength: number[], units: number): PhraseLevel[] {
  const levels: PhraseLevel[] = [];
  for (const bars of [4, 8, 16, 32] as const) {
    if (units < 3 * bars || boundaries.length < 3) continue;
    let best = { offset: 0, recall: -1, on: 0, confidence: 0 };
    const total = strength.reduce((a, b) => a + b, 0);
    for (let q = 0; q < bars; q++) {
      let on = 0, hit = 0;
      boundaries.forEach((b, i) => { if ((b - q) % bars === 0) { on++; hit += strength[i]; } });
      const recall = hit / total;
      if (recall > best.recall) {
        const grid = Math.max(1, Math.floor((units - 1 - q) / bars));
        const alignment = clamp01((recall - 1 / bars) / (1 - 1 / bars));
        const coverage = clamp01(on / grid);
        best = { offset: q, recall, on, confidence: alignment * (0.5 + 0.5 * coverage) * Math.min(1, on / 4) };
      }
    }
    if (best.confidence >= 0.35) levels.push({ bars, offset: best.offset, confidence: Math.round(best.confidence * 1000) / 1000 });
  }
  return levels.sort((a, b) => b.confidence - a.confidence || b.bars - a.bars);
}

function labelSections(sections: { a: number; b: number }[], d: ReturnType<typeof describe>, unitsN: number, z: Float32Array, times: Unit[], duration: number): Section[] {
  const sorted = Array.from(d.levelDb).sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const low = q(0.1), high = q(0.9), range = Math.max(6, high - low), mid = (low + high) / 2;
  const medianLow = Array.from(d.lowDb).sort((a, b) => a - b)[Math.floor(unitsN / 2)];
  const stats = sections.map(({ a, b }) => {
    const n = b - a;
    let level = 0, lowDb = 0;
    for (let u = a; u < b; u++) { level += d.levelDb[u]; lowDb += d.lowDb[u]; }
    level /= n; lowDb /= n;
    // Trend: least-squares slope of the unit levels, as the rise across the section over the track's range.
    let slope = 0;
    if (n >= 3) {
      const mu = (n - 1) / 2;
      let num = 0, den = 0;
      for (let u = a; u < b; u++) { num += (u - a - mu) * (d.levelDb[u] - level); den += (u - a - mu) ** 2; }
      slope = num / den * (n - 1) / range;
    }
    // Repetition: the best match of each unit among units at least 8 away, outside this section.
    let rep = 0, counted = 0;
    for (let u = a; u < b; u += Math.max(1, Math.floor(n / 8))) {
      let m = 0;
      for (let v = 0; v < unitsN; v++) if ((v < a - 8 || v >= b + 8) && (v < a || v >= b)) m = Math.max(m, similarity(z, d.dim, u, v));
      rep += m; counted++;
    }
    return { level01: clamp01(0.5 + (level - mid) / range), lowRel: lowDb - medianLow, rise: slope, repetition: counted ? rep / counted : 0 };
  });
  const mainScore = (s: typeof stats[number]) => clamp01((s.level01 - 0.35) / 0.5) * (s.lowRel > -6 ? 1 : 0.5) * (0.7 + 0.6 * s.repetition);
  // Everything after the last main section is the way out, not only the final cut.
  let lastMain = -1;
  stats.forEach((s, i) => { if (mainScore(s) >= 0.4) lastMain = i; });
  return sections.map(({ a, b }, i) => {
    const s = stats[i], first = i === 0, last = i === sections.length - 1 || (lastMain >= 0 && i > lastMain);
    const start = times[a].start, end = times[b - 1].end;
    const next = stats[i + 1];
    const raw = {
      intro: first && end <= duration * 0.4 ? Math.max(0, 0.9 - 0.7 * s.level01) : 0,
      outro: last && start >= duration * 0.5 ? Math.max(0, 0.9 - 0.6 * s.level01 + 0.3 * clamp01(-s.rise)) : 0,
      buildup: i === sections.length - 1 ? 0 : clamp01(s.rise - 0.1) * 1.6 + (next && next.level01 - s.level01 > 0.2 ? 0.3 : 0) * (s.rise > 0 ? 1 : 0.4),
      breakdown: first || last ? 0 : (0.2 + 0.8 * clamp01(-s.lowRel / 10)) * clamp01((0.55 - s.level01) / 0.3) * (1 - clamp01(s.rise / 0.3)) * 1.1,
      main: mainScore(s),
    };
    const unknown = 0.3, total = raw.intro + raw.outro + raw.buildup + raw.breakdown + raw.main + unknown;
    const scores = { intro: raw.intro / total, buildup: raw.buildup / total, main: raw.main / total, breakdown: raw.breakdown / total, outro: raw.outro / total, unknown: unknown / total };
    const top = (Object.entries(scores).filter(([k]) => k !== "unknown") as [Exclude<SectionLabel, "section">, number][]).sort((x, y) => y[1] - x[1])[0];
    const r = (v: number) => Math.round(v * 1000) / 1000;
    return {
      start, end: i === sections.length - 1 ? duration : end, label: top[1] >= 0.4 ? top[0] : "section",
      scores: { intro: r(scores.intro), buildup: r(scores.buildup), main: r(scores.main), breakdown: r(scores.breakdown), outro: r(scores.outro), unknown: r(scores.unknown) },
      level: r(s.level01), repetition: r(s.repetition),
    };
  });
}

export function analyzeStructure(f: Features, rhythm: Rhythm, duration: number): Structure {
  const empty: Structure = { version: STRUCTURE_VERSION, unit: "time", bars: [], boundaries: [], sections: [], phrases: [], confidence: 0 };
  let { units, unit, bars } = unitsFor(rhythm, duration);
  if (units.length < 8) return empty;
  // A very long file: merge neighbouring units so the repetition pass stays bounded.
  if (units.length > MAX_UNITS) {
    const m = Math.ceil(units.length / MAX_UNITS);
    units = Array.from({ length: Math.floor(units.length / m) }, (_, k) => ({ start: units[k * m].start, end: units[k * m + m - 1].end }));
    bars = []; unit = "time";
  }
  const d = describe(f, units);
  const nov = novelty(d.z, d.dim, units.length);
  let cuts = peaks(nov, unit === "bar" ? 3 : 3);
  // Changes in the first or last two units are the track's own edges, not an interior boundary.
  cuts = cuts.filter(i => i >= 2 && i <= units.length - 2);
  const strengthOf = (i: number) => clamp01(nov[i] / 0.7);
  const phrases = unit === "bar" ? phraseLevels(cuts, cuts.map(strengthOf), units.length) : [];

  // Snap a boundary within one bar of the best phrase grid onto it.
  const best = phrases[0];
  if (best && best.confidence >= 0.5) {
    cuts = cuts.map(i => {
      const near = Math.round((i - best.offset) / best.bars) * best.bars + best.offset;
      return Math.abs(near - i) === 1 && near >= 2 && near <= units.length - 2 ? near : i;
    });
    cuts = [...new Set(cuts)].sort((a, b) => a - b);
  }
  const onGrid = (i: number) => phrases.some(p => p.confidence >= 0.5 && (i - p.offset) % p.bars === 0);
  const boundaries: Boundary[] = cuts.map(i => ({ time: Math.round(units[i].start * 1000) / 1000, strength: Math.round(strengthOf(i) * 1000) / 1000, onPhrase: onGrid(i) }));
  const major = cuts.filter(i => strengthOf(i) >= MAJOR);
  const edges = [0, ...major, units.length];
  const ranges = edges.slice(0, -1).map((a, k) => ({ a, b: edges[k + 1] })).filter(r => r.b > r.a);
  const sections = labelSections(ranges, d, units.length, d.z, units, duration);
  sections[0].start = 0;
  const confidence = boundaries.length ? Math.round(clamp01(boundaries.reduce((s, b) => s + b.strength, 0) / boundaries.length) * Math.min(1, boundaries.length / 2) * 1000) / 1000 : 0;
  return { version: STRUCTURE_VERSION, unit, bars: bars.map(t => Math.round(t * 1000) / 1000), boundaries, sections, phrases, confidence };
}
