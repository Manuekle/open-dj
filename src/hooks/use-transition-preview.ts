"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { covers, decodeWindow, renderPreview, type AudioWindow, type PreviewSpec } from "@/lib/transition-preview";
import type { Track } from "@/lib/types";

export type PreviewInput = Omit<PreviewSpec, "a" | "b"> & { from: Track; to: Track };

/** Seconds two renders cross over when an edit swaps one for the next, short enough to feel instant and not click. */
const SWAP = 0.04;

type Voice = { src: AudioBufferSourceNode; gain: GainNode; startedAt: number; seconds: number };

/**
 * A transition preview that loops on its own audio context, apart from the decks and the master (it is not recorded).
 * `play` renders and starts it; while it plays, `update` renders the edited plan and swaps it in at the same point of
 * the loop, so a change is heard on the next pass without starting over. `progress` reads where the loop is, 0..1.
 */
export function useTransitionPreview() {
  const ctx = useRef<AudioContext | null>(null);
  const voice = useRef<Voice | null>(null);
  const windows = useRef(new Map<string, AudioWindow>());
  /** Bumped by every render and by stop: a render that finds it changed was overtaken and is dropped. */
  const token = useRef(0);
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  const [error, setError] = useState<string | null>(null);

  const windowOf = useCallback(async (track: Track, from: number, to: number) => {
    const have = windows.current.get(track.id);
    if (covers(have, from, to, track.duration)) return have!;
    const next = await decodeWindow(track.blob, from, to, ctx.current?.sampleRate ?? 44100);
    windows.current.set(track.id, next);
    return next;
  }, []);

  const render = useCallback(async (input: PreviewInput) => {
    const { from, to, ...spec } = input;
    const [a, b] = await Promise.all([
      windowOf(from, spec.aStart, spec.aStart + spec.seconds * spec.aRate),
      windowOf(to, spec.bStart, spec.bStart + spec.seconds * spec.bRate),
    ]);
    return renderPreview({ ...spec, a, b });
  }, [windowOf]);

  /** Starts a rendered buffer at `phase` (0..1) of its loop, crossing over from what plays now. */
  const start = useCallback((buffer: AudioBuffer, phase: number) => {
    const c = ctx.current!;
    const gain = c.createGain(), src = c.createBufferSource();
    src.buffer = buffer; src.loop = true;
    src.connect(gain).connect(c.destination);
    const now = c.currentTime, offset = phase * buffer.duration;
    gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(1, now + SWAP);
    src.start(now, offset);
    const old = voice.current;
    if (old) { old.gain.gain.setValueAtTime(old.gain.gain.value, now); old.gain.gain.linearRampToValueAtTime(0, now + SWAP); old.src.stop(now + SWAP + 0.01); }
    voice.current = { src, gain, startedAt: now - offset, seconds: buffer.duration };
  }, []);

  const progress = useCallback(() => {
    const v = voice.current, c = ctx.current;
    if (!v || !c) return null;
    return ((c.currentTime - v.startedAt) % v.seconds) / v.seconds;
  }, []);

  const stop = useCallback(() => {
    token.current++;
    const v = voice.current, c = ctx.current;
    voice.current = null;
    if (v && c) { v.gain.gain.setValueAtTime(v.gain.gain.value, c.currentTime); v.gain.gain.linearRampToValueAtTime(0, c.currentTime + SWAP); v.src.stop(c.currentTime + SWAP + 0.01); }
    setState("idle");
  }, []);

  const play = useCallback(async (input: PreviewInput) => {
    const mine = ++token.current;
    ctx.current ??= new AudioContext();
    setError(null); setState("loading");
    try {
      // Not awaited: a context the browser holds until a gesture would hold the render too. The click that started the
      // preview is that gesture, and the loop starts as soon as the context runs.
      void ctx.current.resume();
      const buffer = await render(input);
      if (mine !== token.current) return;
      start(buffer, 0);
      setState("playing");
    } catch (e) {
      if (mine !== token.current) return;
      setError(e instanceof Error ? e.message : "The preview could not be rendered."); setState("idle");
    }
  }, [render, start]);

  /** Renders an edited plan into the running loop, at the point it has reached. Does nothing when stopped. */
  const update = useCallback(async (input: PreviewInput) => {
    if (!voice.current) return;
    const mine = ++token.current;
    try {
      const buffer = await render(input);
      if (mine !== token.current || !voice.current) return;
      start(buffer, progress() ?? 0);
    } catch { /* the loop keeps the last render */ }
  }, [render, start, progress]);

  // Closing the editor stops the loop and frees the decoded audio.
  useEffect(() => () => {
    token.current++;
    voice.current?.src.stop();
    voice.current = null;
    void ctx.current?.close();
    ctx.current = null;
    windows.current.clear();
  }, []);

  return { state, error, play, stop, update, progress };
}
