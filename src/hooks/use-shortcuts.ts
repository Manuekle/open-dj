"use client";

import { useEffect, useRef } from "react";
import type { DeckId } from "@/lib/types";
import type { DJ } from "@/hooks/use-dj";

/* Keyboard play for the console. One key per action, no modifiers, so a hand can stay on the keys while mixing.
   Deck 1 sits on the left of the keyboard and deck 2 mirrors it on the right. */

type Shortcut = { keys: string; label: string; run: (dj: DJ, help: () => void) => void };
const CROSS_STEP = 0.1;

/** Each deck's keys, also shown in the tooltips of the controls they press. */
export const DECK_KEYS: Record<DeckId, { play: string; cue: string; sync: string; cues: string[] }> = {
  A: { play: "q", cue: "w", sync: "e", cues: ["1", "2", "3", "4"] },
  B: { play: "p", cue: "o", sync: "i", cues: ["7", "8", "9", "0"] },
};
export const MIX_KEY = "m";

const deck = (id: DeckId): Shortcut[] => {
  const n = id === "A" ? 1 : 2, keys = DECK_KEYS[id];
  const loaded = (dj: DJ) => !!dj.decks[id].trackId;
  return [
    { keys: keys.play, label: `Play or pause deck ${n}`, run: dj => { if (loaded(dj)) void dj.togglePlay(id); } },
    { keys: keys.cue, label: `Cue deck ${n}`, run: dj => { if (loaded(dj)) dj.cue(id); } },
    { keys: keys.sync, label: `Sync deck ${n} to the other deck`, run: dj => { if (loaded(dj)) dj.sync(id); } },
    ...keys.cues.map((key, i): Shortcut => ({ keys: key, label: `Hot cue ${i + 1} on deck ${n}`, run: dj => { if (loaded(dj)) dj.pad(id, i); } })),
  ];
};
const fade = (dj: DJ, to: number) => { if (!dj.transition) dj.crossfade(Math.max(-1, Math.min(1, Math.round(to * 10) / 10))); };

export const SHORTCUT_GROUPS: { title: string; items: Shortcut[] }[] = [
  { title: "Deck 1", items: deck("A") },
  { title: "Deck 2", items: deck("B") },
  { title: "Mixer", items: [
    { keys: "z", label: "Move the crossfader toward deck 1", run: dj => fade(dj, dj.cross - CROSS_STEP) },
    { keys: "x", label: "Center the crossfader", run: dj => fade(dj, 0) },
    { keys: "c", label: "Move the crossfader toward deck 2", run: dj => fade(dj, dj.cross + CROSS_STEP) },
    { keys: MIX_KEY, label: "Mix now, or stop the mix", run: dj => {
      if (dj.transition) dj.cancelMix();
      else if (dj.plan) void dj.mix(dj.plan, true);
    } },
  ] },
  { title: "Auto DJ", items: [
    { keys: "n", label: "Skip to the next track in the queue", run: dj => { dj.auto.skip(); } },
  ] },
  { title: "App", items: [
    { keys: "/", label: "Search the library", run: () => {} },
    { keys: "?", label: "Show keyboard shortcuts", run: (_, help) => help() },
  ] },
];

const BY_KEY = new Map(SHORTCUT_GROUPS.flatMap(g => g.items).filter(s => s.keys !== "/").map(s => [s.keys, s]));
// Keys go to the field, menu or dialog that has focus; a slider or a switch keeps only its own keys.
const OWNS_KEYS = "textarea, select, [contenteditable]:not([contenteditable=false]), input:not([type=range], [type=checkbox], [type=radio], [type=button]), [role=dialog], [role=alertdialog], [role=listbox], [role=menu], [role=combobox]";

export function useShortcuts(dj: DJ, onHelp: () => void) {
  const latest = useRef({ dj, onHelp });
  useEffect(() => { latest.current = { dj, onHelp }; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof Element && e.target.closest(OWNS_KEYS)) return;
      const hit = BY_KEY.get(e.key.toLowerCase());
      if (!hit) return;
      e.preventDefault();
      hit.run(latest.current.dj, latest.current.onHelp);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
