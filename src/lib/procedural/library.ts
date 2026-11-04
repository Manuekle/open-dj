import data from "./library.json";
import type { Patch } from "./synth";

/* A curated cut of the procedural-sounds library (https://github.com/m1ckc3s/procedural-sounds, MIT): twelve recipes
   from each of its kept pools, picked evenly across each pool and capped at three seconds. Recipes are a few numbers
   each, so the whole set is about 25 KB and no audio files ship. */
export const FX_CATEGORIES = [
  { id: "tap", label: "Tap" },
  { id: "hover", label: "Hover" },
  { id: "success", label: "Success" },
  { id: "error", label: "Error" },
  { id: "notification", label: "Alert" },
] as const;
export type FxCategory = typeof FX_CATEGORIES[number]["id"];
export const FX_LIBRARY = data as unknown as Record<FxCategory, Patch[]>;
