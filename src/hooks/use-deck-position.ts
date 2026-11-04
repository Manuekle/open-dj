"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { DeckId } from "@/lib/types";

/**
 * Each deck's playhead, outside React state. The 10 Hz poll writes it here instead of into the decks state, so a playing
 * deck re-renders only the few components that show its position (the time, the waveform, the jog, the set timeline),
 * not the whole page: the page tree is thousands of components, and re-rendering it ten times a second is what made the
 * app lag while a track played.
 */
export class DeckPositions {
  private values: Record<DeckId, number> = { A: 0, B: 0 };
  private listeners = new Set<() => void>();
  get(id: DeckId) { return this.values[id]; }
  set(id: DeckId, position: number) {
    if (this.values[id] === position) return;
    this.values = { ...this.values, [id]: position };
    this.listeners.forEach(listener => listener());
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
}

/** A deck's position in seconds, rounded down to `step` so a reader that shows whole seconds re-renders once a second. */
export function useDeckPosition(positions: DeckPositions, id: DeckId | null, step = 0) {
  const read = useCallback(() => {
    if (!id) return 0;
    const at = positions.get(id);
    return step > 0 ? Math.floor(at / step) * step : at;
  }, [positions, id, step]);
  return useSyncExternalStore(positions.subscribe, read, read);
}
