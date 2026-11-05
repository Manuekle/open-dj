import type { StemMove, TransitionEffect, TransitionEq, TransitionStems, VolumeCurve } from "@/lib/types";

/* The names and one-line descriptions of every transition shape, shared by the transition editor, the AutoMix settings
   and the AI planner's prompt, so each place offers the same moves under the same words. */

export const VOLUME_OPTIONS: { value: VolumeCurve; label: string; hint: string }[] = [
  { value: "smooth", label: "Crossfade", hint: "Equal-power crossfade: both tracks cross on curves that hold the level steady." },
  { value: "linear", label: "Linear", hint: "Straight lines: a slight dip in level at the middle, the classic fader move." },
  { value: "scurve", label: "S-curve", hint: "Both hold near full, then swap quickly through the middle." },
  { value: "overlap", label: "Overlap", hint: "The new track is up in the first quarter; the old one leaves in the last." },
  { value: "early", label: "Early in", hint: "The new track is up by 30% while the old one fades across the whole length." },
  { value: "late", label: "Hold out", hint: "The old track holds full to 70% and leaves fast over a new track that rises across." },
  { value: "fade", label: "Fade out, in", hint: "The old track fades out first, then the new one fades in, with a short gap." },
  { value: "cut", label: "Cut", hint: "A hard cut on the swap point: nothing overlaps." },
  { value: "custom", label: "Custom", hint: "Your own envelopes: click a curve to add a point, drag to move it, double-click or Delete to remove it." },
];
export const EQ_OPTIONS: { value: TransitionEq; label: string; hint?: string }[] = [
  { value: "none", label: "None", hint: "The lows cross with the volume." },
  { value: "bass", label: "Bass swap", hint: "The lows swap over a tenth of the length around the swap point, so two bass lines never stack." },
  { value: "gradual", label: "Gradual", hint: "The old lows ease down while the new ones ease up across the length." },
];
export const EFFECT_OPTIONS: { value: TransitionEffect; label: string; hint?: string }[] = [
  { value: "none", label: "None" },
  { value: "lowpass", label: "Low pass out", hint: "A low pass closes on the old track as it leaves." },
  { value: "hpout", label: "High pass out", hint: "A high pass thins the old track out as it leaves." },
  { value: "rise", label: "High pass in", hint: "A high pass opens on the new track as it arrives." },
  { value: "lpin", label: "Low pass in", hint: "The new track opens from a closed low pass." },
  { value: "swap", label: "Filter swap", hint: "The old track thins out under a rising high pass and reverb while the new one opens from a closed low pass." },
  { value: "echo", label: "Echo out", hint: "The old track feeds a beat-timed echo that grows over the second half." },
  { value: "dub", label: "Dub echo", hint: "The old track closes behind a low pass while a long beat-timed echo builds and takes over." },
  { value: "reverb", label: "Reverb wash", hint: "The old track closes behind a low pass and washes out into reverb." },
  { value: "flanger", label: "Flanger", hint: "A flanger sweeps over the old track to the middle and clears." },
];
export const STEM_OPTIONS: { value: TransitionStems; label: string; hint?: string }[] = [
  { value: "none", label: "None" },
  { value: "vocals", label: "Vocal handover", hint: "The old vocals leave by 40% and the new ones come in from 60%, so two voices never overlap." },
  { value: "bass", label: "Bass stem swap", hint: "The bass stems swap at the swap point: cleaner than an eq, the kicks stay." },
  { value: "drums", label: "Drums first", hint: "Only the new drums come in at first; the old drums leave in the middle and the rest of the new track follows." },
  { value: "acapella", label: "Acapella over", hint: "The old track drops to its vocals and sings over the new instrumental; the new vocals wait for the end." },
  { value: "full", label: "Full stem blend", hint: "Drums first, the bass stems swap and the vocals hand over, all in one blend." },
];
/** The moves one stem can make, for the per-stem rows. */
export const STEM_MOVE_OPTIONS: { value: StemMove; label: string }[] = [
  { value: "blend", label: "Blend" }, { value: "swap", label: "Swap" }, { value: "early", label: "Early" }, { value: "late", label: "Late" },
  { value: "custom", label: "Custom" },
];
export const STEM_MOVE_HINT = "Per stem: Blend follows the volume, Swap trades at the swap point, Early brings the new one in first, Late keeps the old one longer. Custom: draw the stem's own curve on the waveforms (or pick the stem above them).";
export const ECHO_BEATS = [0.25, 0.5, 0.75, 1, 2];
export const beatsLabel = (n: number) => n === 0.25 ? "1/4" : n === 0.5 ? "1/2" : n === 0.75 ? "3/4" : String(n);
export const labelOf = <T extends string>(options: { value: T; label: string }[], value: T | undefined) => options.find(o => o.value === value)?.label ?? value ?? "";
