import { barIndexAt, barStarts } from "@/lib/grid";
import type { Section } from "@/lib/analysis-types";
import type { Track } from "@/lib/types";

/* Where a track may be left and entered, from its phrases, sections and real bars. A point is judged by:
   - how well it sits on a phrase grid that has evidence (a blend that ends mid-phrase cuts the phrase off),
   - whether the stretch it covers is an outro or breakdown (leaving) or an intro that lands on the main section
     (entering), and not the middle of a full-energy section,
   - how late (leaving) or early (entering) in the track it falls.
   When a track has no usable structure these functions return null and the caller keeps the loudness heuristics.
   Nothing here looks for vocals: the analysis cannot tell a voice from a lead, so a phrase is never "protected" for
   having one. */

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export type MixPoint = {
  at: number;
  /** How well the point sits on a phrase grid: "phrase" (a grid with evidence), "bar", or "section" (time-based). */
  tier: "phrase" | "bar" | "section";
  /** 0..1: how far the cut end (leaving) or start (entering) is from a phrase boundary, weighted by how sure the phrase grid is. 0 is clean. */
  cut: number;
  /** 0..1 trust in this choice: phrase evidence and how decisively it beat the other bars. */
  confidence: number;
  why: string;
};

function usable(track: Track) {
  const bars = barStarts(track), s = track.structure;
  if (!bars || !s || s.unit !== "bar" || s.bars.length < 8) return null;
  return { bars: s.bars, structure: s };
}

/** How well bar index j (counted from the first downbeat) sits on a phrase grid that has evidence, 0..1. With no phrase
    evidence a bar line alone is worth 0.3. */
function alignment(track: Track, j: number): { score: number; tier: MixPoint["tier"]; level: number } {
  const levels = (track.structure?.phrases ?? []).filter(p => p.confidence >= 0.5);
  let score = 0, level = 0;
  for (const p of levels) {
    if (((j - p.offset) % p.bars + p.bars) % p.bars === 0 && p.confidence > score) { score = p.confidence; level = p.bars; }
  }
  return score > 0 ? { score, tier: "phrase", level } : { score: 0.3, tier: "bar", level: 0 };
}

/** The 0..1 chance that cutting at bar index j cuts a phrase: 0 on a phrase boundary or with no phrase evidence to
    judge by, up to the phrase grid's confidence in the middle of a phrase. */
export function cutPenalty(track: Track, time: number): number {
  const u = usable(track);
  if (!u) return 0;
  const levels = u.structure.phrases.filter(p => p.confidence >= 0.5);
  if (!levels.length) return 0;
  const j = barIndexAt(u.bars, time + 1e-3);
  if (j < 0) return 0;
  const frac = (time - u.bars[j]) / Math.max(0.1, (u.bars[j + 1] ?? u.bars[j] + 2) - u.bars[j]);
  const p = levels[0];
  const pos = ((j - p.offset) % p.bars + p.bars) % p.bars + clamp01(frac);
  // Distance to the nearest boundary of the best grid, in phrases: 0 on it, 0.5 in the middle.
  const d = Math.min(pos, p.bars - pos) / p.bars;
  return Math.round(clamp01(d * 2) * p.confidence * 1000) / 1000;
}

function sectionAt(sections: Section[], t: number) {
  return sections.find(s => t >= s.start && t < s.end) ?? sections[sections.length - 1];
}
/** The strongest boundary within `tol` seconds of t, 0..1 (0 when none). */
function boundaryNear(track: Track, t: number, tol: number) {
  let best = 0;
  for (const b of track.structure?.boundaries ?? []) if (Math.abs(b.time - t) <= tol) best = Math.max(best, b.strength);
  return best;
}

/** Where the outgoing track should start a blend of `bars` bars: the blend's end on a phrase boundary, the blend over
    an outro or breakdown rather than the middle of a main section, late in the track. */
export function exitPoint(track: Track, bars: number): MixPoint | null {
  const u = usable(track);
  if (!u) return null;
  const b = u.bars, sections = u.structure.sections, dur = track.duration;
  const scored: { k: number; total: number; end: number; start: number; tier: MixPoint["tier"]; cut: number; inside: boolean }[] = [];
  for (let k = 0; k + bars < b.length; k++) {
    const start = b[k], end = b[k + bars];
    if (start < dur * 0.4 || end > dur - 0.3) continue;
    const endAlign = Math.max(alignment(track, k + bars).score, boundaryNear(track, end, 0.4) * 0.9);
    const startAlign = alignment(track, k);
    const mid = sectionAt(sections, (start + end) / 2);
    const outroLike = mid ? mid.scores.outro + 0.6 * mid.scores.breakdown : 0;
    // The window sits entirely inside a main section: leaving here cuts a full-energy stretch short.
    const inside = sections.some(s => s.label === "main" && s.start < start - (b[1] - b[0]) && s.end > end + (b[1] - b[0]));
    const late = clamp01((start / dur - 0.5) / 0.4);
    const total = 1.2 * endAlign + 0.4 * startAlign.score + 0.8 * outroLike + 0.4 * late - (inside ? 0.8 : 0);
    scored.push({ k, total, end, start, tier: alignment(track, k + bars).tier, cut: 1 - clamp01(endAlign / Math.max(0.5, u.structure.phrases[0]?.confidence ?? 0.5)), inside });
  }
  if (!scored.length) return null;
  // Deterministic: the best total; among equals the later start.
  scored.sort((x, y) => y.total - x.total || y.start - x.start);
  const best = scored[0], next = scored.find(s => Math.abs(s.start - best.start) > 4 * (b[1] - b[0]));
  const phrase = u.structure.phrases[0]?.confidence ?? 0;
  return {
    at: best.start, tier: best.tier, cut: Math.round(cutPenalty(track, best.end) * 1000) / 1000,
    confidence: Math.round(clamp01(0.5 * phrase + 0.5 * clamp01((best.total - (next?.total ?? 0)) / 1.2)) * 1000) / 1000,
    why: best.tier === "phrase" ? `leaves so that it ends on a ${u.structure.phrases[0].bars}-bar phrase boundary` : "leaves on a bar line (no phrase grid with evidence)",
  };
}

/** Where the incoming track should enter for a blend of `bars` bars: at the start of a phrase, with its main section
    landing as the blend ends, and not already in a full-energy stretch. */
export function entryPoint(track: Track, bars: number): MixPoint | null {
  const u = usable(track);
  if (!u) return null;
  const b = u.bars, sections = u.structure.sections, dur = track.duration;
  const scored: { k: number; total: number; start: number; tier: MixPoint["tier"] }[] = [];
  for (let k = 0; k < b.length && b[k] < dur * 0.5; k++) {
    const start = b[k], landing = b[Math.min(b.length - 1, k + bars)];
    if (k + bars >= b.length) break;
    const startAlign = k === 0 ? Math.max(0.6, alignment(track, 0).score) : alignment(track, k).score;
    const land = sections.find(s => s.label === "main" && Math.abs(s.start - landing) <= 0.6 * (b[1] - b[0]));
    const landScore = land ? 1 : boundaryNear(track, landing, 0.4) * 0.6;
    const mid = sectionAt(sections, (start + landing) / 2);
    const introLike = mid ? mid.scores.intro + mid.scores.buildup + 0.5 * mid.scores.breakdown - 0.6 * mid.scores.main : 0;
    const earlier = -0.3 * clamp01(start / (dur * 0.5));
    scored.push({ k, total: 1.0 * startAlign + 1.0 * landScore + 0.6 * introLike + earlier, start, tier: alignment(track, k).tier });
  }
  if (!scored.length) return null;
  scored.sort((x, y) => y.total - x.total || x.start - y.start);
  const best = scored[0], next = scored.find(s => Math.abs(s.start - best.start) > 4 * (b[1] - b[0]));
  const phrase = u.structure.phrases[0]?.confidence ?? 0;
  return {
    at: best.start, tier: best.tier, cut: Math.round(cutPenalty(track, best.start) * 1000) / 1000,
    confidence: Math.round(clamp01(0.5 * phrase + 0.5 * clamp01((best.total - (next?.total ?? 0)) / 1.2)) * 1000) / 1000,
    why: best.tier === "phrase" ? "enters on a phrase start so its main section lands as the blend ends" : "enters on a bar line (no phrase grid with evidence)",
  };
}
