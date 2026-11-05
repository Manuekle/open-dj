"use client";

import { useSyncExternalStore } from "react";
import "@/lib/legacy-keys";
import type { TransitionShape } from "@/lib/types";

/** A transition shape the DJ named and saved from the editor, to apply to any pair like a built-in preset. */
export type UserPreset = { id: string; name: string; shape: TransitionShape };

const KEY = "shift.transition-presets";
const NONE: UserPreset[] = [];

function read(): UserPreset[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) as unknown : [];
    return Array.isArray(list) ? list.filter((p): p is UserPreset => !!p && typeof p.id === "string" && typeof p.name === "string" && !!p.shape) : NONE;
  } catch { return NONE; }
}

/* One list for the page, read from storage once and kept in step with every editor that shows it (and other tabs). */
let current: UserPreset[] | null = null;
const listeners = new Set<() => void>();
const snapshot = () => current ??= read();
function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) { current = read(); listeners.forEach(l => l()); } };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", onStorage); };
}
function write(next: UserPreset[]) {
  current = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode: kept for this visit only */ }
  listeners.forEach(l => l());
}

/** The DJ's own presets. They belong to this browser, not to a project, so every set can use them. */
export function useUserPresets() {
  const presets = useSyncExternalStore(subscribe, snapshot, () => NONE);
  return {
    presets,
    /** Saves a shape under a name; a preset of the same name is replaced. */
    add: (name: string, shape: TransitionShape) => write([...snapshot().filter(p => p.name !== name), { id: crypto.randomUUID(), name, shape }]),
    remove: (id: string) => write(snapshot().filter(p => p.id !== id)),
  };
}
