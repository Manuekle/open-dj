/* Shift was called Open DJ, and its localStorage keys started with "open-dj" ("open-dj-project",
   "open-dj.transition-presets", "open-dj:voice-range"...). On first load after the rename each one moves to the same key
   under "shift", unless that key already holds a value, and the old key is removed.
   Every module that reads such a key imports this file for its side effect, so the move runs before the first read. */
const OLD = "open-dj";
const NEW = "shift";

function migrate() {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key?.startsWith(OLD)) keys.push(key); }
    for (const key of keys) {
      const next = NEW + key.slice(OLD.length);
      const value = localStorage.getItem(key);
      if (value !== null && localStorage.getItem(next) === null) localStorage.setItem(next, value);
      localStorage.removeItem(key);
    }
  } catch { /* storage unavailable (private mode, blocked site data) */ }
}

if (typeof window !== "undefined") migrate();

export {};
