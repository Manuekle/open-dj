/* The shapes of the rhythm and structure results. They live apart from the DSP so lib/types.ts (the stored track) and
   the planner can import them without pulling the analysis code in. Every number that is an estimate carries a
   confidence in 0..1, and a result with too little evidence says so (null, an empty list, or grid "none") rather than
   returning a guess dressed as a measurement. */

/** Bump when beat tracking, downbeats or tempo confidence change. Stored tracks with an older number are re-derived
    from the audio (the tempo, key and loudness analysis are not touched; see ANALYSIS_VERSION). */
export const RHYTHM_VERSION = 2;
/** Bump when sections, phrases or labels change. */
export const STRUCTURE_VERSION = 1;

/** How much of a beat grid can be trusted:
    - steady: beats stay within 0.15 of a beat of one constant tempo, so a constant-rate sync and bar extrapolation are safe;
    - variable: beats are real but the tempo moves (live playing, ramps); use the beat positions, never extrapolate;
    - weak: some pulse, not enough to place a mix on; beats are kept for display only;
    - none: no pulse found (ambient, silence, a held tone); beats is empty. */
export type GridKind = "steady" | "variable" | "weak" | "none";

export type Rhythm = {
  version: number;
  /** Seconds of each individual beat, as tracked (not a bpm grid). Empty when grid is "none". */
  beats: number[];
  /** Onset support of each beat, 0..1. A beat the tracker filled in across a gap reads near 0. */
  strength: number[];
  /** Median tempo of the beats, bpm; null without beats. */
  bpm: number | null;
  /** How sure the beat positions are, 0..1: beat-to-offbeat onset contrast and the share of beats with a real onset. */
  beatConfidence: number;
  tempo: {
    /** beatConfidence discounted when this tracker and the legacy tempo estimate disagree. */
    confidence: number;
    /** Largest swing of the local tempo (median of 9 beats) as a fraction of the median tempo. Quantization of the beat
        positions alone reads a few percent here; wander is what tells a steady tempo from a moving one. */
    drift: number;
    /** Largest distance of the beats (9-beat median) from the line of one constant tempo, in beats. Under 0.15 the grid
        is "steady". Absent in results stored before it was measured (RHYTHM_VERSION 1). */
    wander?: number;
    /** Half or double time would fit about as well; the planner folds these, but the label may be off by an octave. */
    octaveAmbiguous: boolean;
  };
  /** Which beat (0..3) of beats[] starts a bar, assuming 4/4. `assumed` is true when no cue separated the four phases
      and the phase is just the first beat. */
  downbeat: { phase: number; confidence: number; assumed: boolean };
  grid: GridKind;
};

export type SectionLabel = "intro" | "buildup" | "main" | "breakdown" | "outro" | "section";

export type Section = {
  start: number; end: number;
  /** The most likely label, or "section" when no label reaches 0.4. */
  label: SectionLabel;
  /** Normalized heuristic scores that sum to 1 with `unknown`: a ranking of the readings of this stretch, not a
      calibrated probability. */
  scores: Record<Exclude<SectionLabel, "section">, number> & { unknown: number };
  /** Loudness of the section against the track, 0 (quietest stretch) .. 1 (loudest); 0.5 when the track barely moves. */
  level: number;
  /** How closely the section's sound recurs elsewhere in the track (not next to it), 0..1. */
  repetition: number;
};

export type Boundary = {
  time: number;
  /** Novelty of the change here, 0..1. */
  strength: number;
  /** Whether the boundary sits on a bar of a phrase grid that has evidence. */
  onPhrase: boolean;
};

export type PhraseLevel = {
  /** Length in bars: 4, 8, 16 or 32. */
  bars: 4 | 8 | 16 | 32;
  /** Bars after the first downbeat at which phrases of this length start (0..bars-1). */
  offset: number;
  /** Chance-corrected share of the detected section changes that fall on this grid, times how much of the grid they use. */
  confidence: number;
};

export type Structure = {
  version: number;
  /** What the sections are cut from: bars of the beat grid, or fixed 2-second blocks without one. */
  unit: "bar" | "time";
  /** Bar start times when unit is "bar" (every downbeat); empty otherwise. */
  bars: number[];
  boundaries: Boundary[];
  sections: Section[];
  /** Phrase lengths with enough evidence, best first. Empty when none has: that is "not detected", not "no phrases". */
  phrases: PhraseLevel[];
  /** Overall trust in the sections: 0 when no change was found at all. */
  confidence: number;
};
