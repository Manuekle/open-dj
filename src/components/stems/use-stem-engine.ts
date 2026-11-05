"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { applyColor, applyEffect, centsOf, colorCutoffs, createDeckGraph, type DeckGraph } from "@/lib/deck-graph";
import { covers, lengthOf, localTime, stemGain, timelineTime, type Loop, type Placement, type TrackEdit } from "@/lib/stem-mix";
import type { EffectName, StoredTrack } from "@/lib/types";

/* The audio of the Stems page: up to two players, each a media element playing a stems file through the eight-channel
   split a deck uses (lib/deck-graph), with a filter and a pan inserted on every stem. One transport clock runs the
   timeline: the first player that is sounding is the master and the clock follows its media time, the other player is
   kept on it (a small rate nudge for a few ms of drift, a seek past that), and where no player has media the context's
   clock carries the timeline on. The cuts, the loop and the end of the timeline are read off that clock every frame. */

export type EngineLayer = { track: StoredTrack | null; placement: Placement; edit: TrackEdit; fadeBeats: number };

type Player = {
  el: HTMLAudioElement; graph: DeckGraph;
  lp: BiquadFilterNode[]; hp: BiquadFilterNode[]; pan: StereoPannerNode[];
  trackId: string | null; url: string | null; applied: number[];
};

const PLAYERS = 2;
/** Drift between the players that a rate nudge corrects; past HARD_DRIFT the follower seeks. */
const SOFT_DRIFT = 0.008, HARD_DRIFT = 0.06, MAX_NUDGE = 0.004;

export function useStemEngine({ layers, speed, keepPitch, loop, onFrame, onDurations }: {
  layers: EngineLayer[]; speed: number; keepPitch: boolean; loop: Loop | null;
  /** Called with the timeline time on every frame while playing, and after every seek. */
  onFrame: (t: number) => void;
  /** Called with each player's media length once known (0 while it loads). */
  onDurations: (d: [number, number]) => void;
}) {
  const [playing, setPlaying] = useState(false);
  const durations = useRef<[number, number]>([0, 0]);
  const ctxRef = useRef<AudioContext | null>(null);
  const players = useRef<Player[]>([]);
  const time = useRef(0);
  const anchor = useRef({ ctx: 0, t: 0 });
  const playingRef = useRef(false);
  const live = useRef({ layers, speed, loop, onFrame, onDurations });
  useEffect(() => { live.current = { layers, speed, loop, onFrame, onDurations }; });
  const setDuration = (i: number, d: number) => {
    durations.current = durations.current.map((x, j) => j === i ? d : x) as [number, number];
    live.current.onDurations(durations.current);
  };

  // The players and their graphs live as long as the page.
  useEffect(() => {
    const ctx = new AudioContext();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.001; limiter.release.value = 0.1;
    limiter.connect(ctx.destination);
    const made: Player[] = [];
    for (let i = 0; i < PLAYERS; i++) {
      const el = new Audio(); el.preload = "auto";
      const graph = createDeckGraph(ctx, limiter);
      ctx.createMediaElementSource(el).connect(graph.splitter);
      const lp: BiquadFilterNode[] = [], hp: BiquadFilterNode[] = [], pan: StereoPannerNode[] = [];
      // A filter pair and a pan on each stem, between its gain and the deck's own stem lane.
      graph.stems.forEach((gain, k) => {
        const l = ctx.createBiquadFilter(); l.type = "lowpass"; l.frequency.value = 1000; l.detune.value = centsOf(20000); l.Q.value = 0.9;
        const h = ctx.createBiquadFilter(); h.type = "highpass"; h.frequency.value = 1000; h.detune.value = centsOf(12); h.Q.value = 0.9;
        const p = ctx.createStereoPanner();
        gain.disconnect(); gain.connect(l); l.connect(h); h.connect(p); p.connect(graph.mix.stems[k]);
        lp.push(l); hp.push(h); pan.push(p);
      });
      const meta = () => { if (Number.isFinite(el.duration)) setDuration(i, el.duration); };
      el.addEventListener("loadedmetadata", meta); el.addEventListener("durationchange", meta);
      made.push({ el, graph, lp, hp, pan, trackId: null, url: null, applied: [-1, -1, -1, -1] });
    }
    players.current = made; ctxRef.current = ctx;
    return () => {
      for (const p of made) { p.el.pause(); p.el.removeAttribute("src"); p.el.load(); if (p.url) URL.revokeObjectURL(p.url); }
      void ctx.close(); players.current = []; ctxRef.current = null;
    };
  }, []);

  /** The layers that have a track, with their player. Stable: they read the latest layers through `live`. */
  const active = useCallback(() => live.current.layers.map((l, i) => ({ l, p: players.current[i] })).filter(x => x.l.track && x.p), []);
  const total = useCallback(() => lengthOf(active().map(x => x.l.placement)), [active]);

  /** Sets each stem's gain for timeline time `t`. A change ramps over a few ms, so a cut never clicks. */
  const applyGains = useCallback((t: number) => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const list = active();
    const anySolo = list.some(x => x.l.edit.strips.some(s => s.solo));
    for (const { l, p } of list) {
      const beat = l.track?.bpm ? 60 / l.track.bpm : 0.5;
      for (let k = 0; k < 4; k++) {
        const g = covers(l.placement, t) || !playingRef.current ? stemGain(l.edit, l.placement, k, t, anySolo, l.fadeBeats * beat) : 0;
        if (Math.abs(g - p.applied[k]) < 0.002) continue;
        p.graph.stems[k].gain.setTargetAtTime(g, ctx.currentTime, 0.01);
        p.applied[k] = g;
      }
    }
  }, [active]);

  /** Moves the timeline to `t`: every player with media there is cued on it, the others stop. */
  const seek = useCallback((t: number) => {
    const ctx = ctxRef.current;
    const end = total();
    const to = Math.max(0, Math.min(end || t, t));
    time.current = to;
    anchor.current = { ctx: ctx?.currentTime ?? 0, t: to };
    for (const { l, p } of active()) {
      const local = localTime(l.placement, to);
      if (local >= 0 && local < l.placement.duration) p.el.currentTime = local;
      else { if (!p.el.paused) p.el.pause(); if (local < 0) p.el.currentTime = 0; }
    }
    applyGains(to);
    live.current.onFrame(to);
  }, [applyGains, active, total]);

  const pause = useCallback(() => {
    playingRef.current = false; setPlaying(false);
    for (const p of players.current) p.el.pause();
    anchor.current = { ctx: ctxRef.current?.currentTime ?? 0, t: time.current };
  }, []);

  const tick = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx || !playingRef.current) return;
    const { speed: s, loop: lp } = live.current;
    const list = active();
    const now = ctx.currentTime;
    let t = anchor.current.t + (now - anchor.current.ctx) * s;
    // The first sounding player is the clock.
    let master = -1;
    for (let i = 0; i < list.length; i++) {
      const { l, p } = list[i];
      if (p.el.paused || p.el.seeking || p.el.readyState < 2 || !covers(l.placement, t)) continue;
      t = timelineTime(l.placement, p.el.currentTime); master = i;
      anchor.current = { ctx: now, t };
      break;
    }
    if (lp && t >= lp.to) { seek(lp.from); return; }
    const end = total();
    if (end > 0 && t >= end - 0.02) { time.current = end; pause(); live.current.onFrame(end); return; }
    time.current = t;
    list.forEach(({ l, p }, i) => {
      const local = localTime(l.placement, t), base = s * l.placement.ratio;
      if (local < 0 || local >= l.placement.duration - 0.02) { if (!p.el.paused) p.el.pause(); return; }
      if (p.el.paused) { p.el.currentTime = local; p.el.playbackRate = base; void p.el.play().catch(() => undefined); return; }
      if (i === master || p.el.seeking) { if (Math.abs(p.el.playbackRate - base) > 1e-4) p.el.playbackRate = base; return; }
      const drift = p.el.currentTime - local;
      if (Math.abs(drift) > HARD_DRIFT) { p.el.currentTime = local; p.el.playbackRate = base; }
      else {
        const rate = Math.abs(drift) > SOFT_DRIFT ? base * (1 - Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, drift))) : base;
        if (Math.abs(p.el.playbackRate - rate) > 1e-4) p.el.playbackRate = rate;
      }
    });
    applyGains(t);
    live.current.onFrame(t);
  }, [applyGains, pause, seek, active, total]);

  useEffect(() => {
    if (!playing) return;
    let frame = requestAnimationFrame(function loop() { tick(); frame = requestAnimationFrame(loop); });
    return () => cancelAnimationFrame(frame);
  }, [playing, tick]);

  const play = useCallback(async () => {
    const ctx = ctxRef.current;
    if (!ctx || !active().length) return;
    await ctx.resume();
    const end = total(), lp = live.current.loop;
    let t = time.current;
    if (end > 0 && t >= end - 0.05) t = 0;
    if (lp && (t < lp.from || t >= lp.to)) t = lp.from;
    if (t !== time.current) seek(t);
    anchor.current = { ctx: ctx.currentTime, t };
    playingRef.current = true; setPlaying(true);
    tick();
  }, [seek, tick, active, total]);

  const toggle = useCallback(() => { if (playingRef.current) pause(); else void play(); }, [pause, play]);

  // Load each layer's stems file into its player; a player whose layer is empty stops.
  const ids = layers.map(l => l.track?.id ?? "").join("|");
  useEffect(() => {
    players.current.forEach((p, i) => {
      const track = live.current.layers[i]?.track ?? null;
      if ((track?.id ?? null) === p.trackId) return;
      p.el.pause();
      if (p.url) { URL.revokeObjectURL(p.url); p.url = null; }
      p.trackId = track?.id ?? null; p.applied = [-1, -1, -1, -1];
      setDuration(i, 0);
      if (track?.stems) { p.url = URL.createObjectURL(track.stems); p.el.src = p.url; p.el.load(); }
      else { p.el.removeAttribute("src"); p.el.load(); }
    });
    if (!live.current.layers.some(l => l.track)) { playingRef.current = false; setPlaying(false); }
    seek(Math.min(time.current, total()));
  }, [ids, seek, total]);

  // Pitch follows the speed only when asked; the element resets these when its source changes, so ids is a dependency.
  useEffect(() => {
    for (const p of players.current) {
      const m = p.el as HTMLAudioElement & { webkitPreservesPitch?: boolean };
      m.preservesPitch = keepPitch;
      if ("webkitPreservesPitch" in m) m.webkitPreservesPitch = keepPitch;
    }
  }, [keepPitch, ids]);

  // A speed change keeps the timeline where it is.
  useEffect(() => { anchor.current = { ctx: ctxRef.current?.currentTime ?? 0, t: time.current }; }, [speed]);

  // Per layer: EQ, color filter, effect; per stem: filter and pan. Gains follow buttons and cuts at once, also paused.
  const mixKey = JSON.stringify(layers.map(l => [l.edit.mix, l.edit.strips.map(s => [s.filter, s.pan])]));
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const t = ctx.currentTime;
    live.current.layers.forEach((l, i) => {
      const p = players.current[i];
      if (!p) return;
      const d = p.graph, m = l.edit.mix;
      d.low.gain.setTargetAtTime(m.eq[0], t, 0.02); d.mid.gain.setTargetAtTime(m.eq[1], t, 0.02); d.high.gain.setTargetAtTime(m.eq[2], t, 0.02);
      applyColor(ctx, d, m.color);
      applyEffect(ctx, d, m.fx as EffectName, m.fxAmount);
      l.edit.strips.forEach((s, k) => {
        const c = colorCutoffs(s.filter);
        p.lp[k].detune.setTargetAtTime(centsOf(c.lp), t, 0.02);
        p.hp[k].detune.setTargetAtTime(centsOf(c.hp), t, 0.02);
        p.pan[k].pan.setTargetAtTime(s.pan, t, 0.02);
      });
    });
  }, [mixKey]);

  const gainKey = JSON.stringify(layers.map(l => [l.edit.strips, l.edit.cuts, l.edit.mix.volume, l.edit.volume, l.edit.stemVolume, l.placement, l.fadeBeats]));
  useEffect(() => { if (!playingRef.current) applyGains(time.current); }, [gainKey, applyGains]);

  const now = useCallback(() => time.current, []);
  return { playing, play, pause, toggle, seek, now };
}
