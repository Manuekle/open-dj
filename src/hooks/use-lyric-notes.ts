"use client";

import { useEffect, useRef, useState } from "react";
import { romanizeLocal, scriptOf } from "@/lib/romanize";

/* What goes under each lyric line: its romanization (Latin letters, for Japanese, Korean, Chinese and other scripts) and
   its translation into a language of the user's choice. Romanization is done in the browser by rule where it can be
   (lib/romanize) and by the local model for the rest; translation is the local model's (/api/translate). Answers are kept
   per track, language and line text in localStorage, so a song is asked once. */

export type Notes = { roman: string[] | null; translation: string[] | null };
type Status = "idle" | "loading" | "error";

const cacheKey = (kind: string, trackId: string, lang: string, lines: string[]) => {
  let h = 0; for (const c of lines.join("\n")) h = (h * 31 + c.charCodeAt(0)) | 0;
  return `shift:lyric-notes:${kind}:${trackId}:${lang}:${h}`;
};
const load = (key: string): string[] | null => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) as string[] : null; } catch { return null; } };
const save = (key: string, value: string[]) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked: asked again next time */ } };

async function ask(mode: "translate" | "romanize", lines: string[], target: string, source: string): Promise<string[]> {
  const res = await fetch("/api/translate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, lines, target, source }) });
  const body = await res.json() as { lines?: string[]; error?: string };
  if (!res.ok || !body.lines) throw new Error(body.error ?? "The local model did not answer.");
  return body.lines;
}

/** Whether any line is in a script that has a romanization. */
export const canRomanize = (lines: string[]) => lines.some(l => scriptOf(l) !== "latin");

export function useLyricNotes({ trackId, lines, language, romanize, target, targetName }: {
  trackId: string | null; lines: string[]; language: string; romanize: boolean; target: string | null; targetName: string;
}) {
  const [notes, setNotes] = useState<Notes>({ roman: null, translation: null });
  const [status, setStatus] = useState<{ roman: Status; translation: Status }>({ roman: "idle", translation: "idle" });
  const [error, setError] = useState<string | null>(null);
  const run = useRef(0);
  const text = lines.join("\n");

  useEffect(() => {
    if (!trackId || !romanize || !lines.length) { run.current++; queueMicrotask(() => { setNotes(n => n.roman ? { ...n, roman: null } : n); setStatus(s => ({ ...s, roman: "idle" })); }); return; }
    const token = ++run.current, key = cacheKey("roman", trackId, language, lines);
    const hit = load(key);
    if (hit) { queueMicrotask(() => { setNotes(n => ({ ...n, roman: hit })); setStatus(s => ({ ...s, roman: "idle" })); }); return; }
    queueMicrotask(() => { setStatus(s => ({ ...s, roman: "loading" })); setError(null); });
    (async () => {
      const out = await Promise.all(lines.map(l => romanizeLocal(l, language)));
      // What rules left (kanji, other scripts) goes to the model; Latin lines have nothing to romanize.
      const rest = lines.map((l, i) => out[i] === null && scriptOf(l) !== "latin" ? i : -1).filter(i => i >= 0);
      if (rest.length) {
        const got = await ask("romanize", rest.map(i => lines[i]), "", language);
        rest.forEach((i, k) => { out[i] = got[k] ?? ""; });
      }
      const done = out.map(v => v ?? "");
      if (token !== run.current) return;
      save(key, done);
      setNotes(n => ({ ...n, roman: done })); setStatus(s => ({ ...s, roman: "idle" }));
    })().catch(e => { if (token !== run.current) return; setError((e as Error).message); setStatus(s => ({ ...s, roman: "error" })); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId, romanize, text, language]);

  const wanted = useRef(0);
  useEffect(() => {
    if (!trackId || !target || !lines.length) { wanted.current++; queueMicrotask(() => { setNotes(n => n.translation ? { ...n, translation: null } : n); setStatus(s => ({ ...s, translation: "idle" })); }); return; }
    const token = ++wanted.current, key = cacheKey("translate", trackId, target, lines);
    const hit = load(key);
    if (hit) { queueMicrotask(() => { setNotes(n => ({ ...n, translation: hit })); setStatus(s => ({ ...s, translation: "idle" })); }); return; }
    queueMicrotask(() => { setStatus(s => ({ ...s, translation: "loading" })); setError(null); setNotes(n => ({ ...n, translation: null })); });
    ask("translate", lines, targetName, language).then(done => {
      if (token !== wanted.current) return;
      save(key, done);
      setNotes(n => ({ ...n, translation: done })); setStatus(s => ({ ...s, translation: "idle" }));
    }).catch(e => { if (token !== wanted.current) return; setError((e as Error).message); setStatus(s => ({ ...s, translation: "error" })); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId, target, text, language]);

  return { notes, status, error };
}
