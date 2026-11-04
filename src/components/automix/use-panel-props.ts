"use client";

import { useEffect, useMemo, useRef } from "react";
import type { DJ } from "@/hooks/use-dj";
import type { DeckId, Track } from "@/lib/types";
import type { AutoControls, AutoView, CriterionView, DeckLite, QueueActions, ScoreView } from "./model";
import type { AutoMixPanelProps } from "./automix-panel";


/* Turns the DJ hook into the AutoMix panel's props, each one referentially stable until what it holds changes: the
   hook builds new objects on every render (ten a second while a deck plays), and the panel is memoized on these. The
   actions forward to the hook of the latest render, so a click always reaches the engine as it stands. */
export function useAutoMixPanelProps(dj: DJ, library: Track[]): { props: AutoMixPanelProps; decks: Record<DeckId, DeckLite> } {
  const latest = useRef(dj);
  useEffect(() => { latest.current = dj; });

  const a = dj.auto;
  const auto: AutoView = useMemo(() => ({
    phase: a.phase, enabled: a.enabled, detail: a.detail, error: a.error, queue: a.queue, currentUid: a.currentUid,
    nextUid: a.nextUid, nextTrackId: a.nextTrackId, nextSource: a.nextSource, plan: a.plan,
    skipPending: a.skipPending, pausing: a.pausing, failures: a.failures,
  }), [a.phase, a.enabled, a.detail, a.error, a.queue, a.currentUid, a.nextUid, a.nextTrackId, a.nextSource, a.plan, a.skipPending, a.pausing, a.failures]);

  const controls: AutoControls = useMemo(() => ({
    start: () => latest.current.auto.start(), enable: () => latest.current.auto.enable(), stop: () => latest.current.auto.stop(),
    pause: () => latest.current.auto.pause(), resume: () => latest.current.auto.resume(), skip: () => latest.current.auto.skip(),
  }), []);
  const queue: QueueActions = useMemo(() => ({
    add: (ids, where) => latest.current.queue.add(ids, where), remove: uid => latest.current.queue.remove(uid),
    move: (uid, delta) => latest.current.queue.move(uid, delta), playNext: uid => latest.current.queue.playNext(uid),
    jumpTo: uid => { latest.current.auto.jumpTo(uid); },
    clear: () => latest.current.queue.clear(), setLoop: on => latest.current.queue.setLoop(on), setSmart: on => latest.current.queue.setSmart(on),
    retryFailed: () => latest.current.queue.retryFailed(),
  }), []);
  const mediaTime = useMemo(() => (id: DeckId) => latest.current.mediaTime(id), []);

  const { A, B } = dj.decks;
  const decks = useMemo(() => ({
    A: { trackId: A.trackId, rate: A.rate, playing: A.playing }, B: { trackId: B.trackId, rate: B.rate, playing: B.playing },
  }), [A.trackId, A.rate, A.playing, B.trackId, B.rate, B.playing]);

  const rating = dj.planScore;
  const score: ScoreView | null = useMemo(() => rating ? {
    score: rating.score, confidence: rating.confidence,
    criteria: Object.fromEntries((["harmony", "tempo", "energy"] as const).flatMap(k => rating.criteria[k] ? [[k, rating.criteria[k] as CriterionView]] : [])),
  } : null, [rating]);


  return {
    decks,
    props: {
      auto, controls, queue, tracks: dj.tracks, library, decks, live: dj.live, transition: dj.transition, mediaTime,
      score, fallback: dj.smart?.fallback ?? null, style: dj.smartStyle, onStyle: dj.setSmartStyle,
    },
  };
}
