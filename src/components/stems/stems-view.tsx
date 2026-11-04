"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadTracks } from "@/lib/storage";
import { onStemsDone, startStemJob, useStemProgress } from "@/lib/background-jobs";
import { stemPeaks, type StemPeaks } from "@/lib/stem-peaks";
import { applyColor, applyEffect, createDeckGraph, type DeckGraph } from "@/lib/deck-graph";
import { EFFECTS, STEMS, formatTime, type EffectName, type StoredTrack } from "@/lib/types";
import { cn } from "@/lib/sodium/utils";
import { Button } from "@/components/sodium/ui/button";
import { Slider } from "@/components/sodium/ui/slider";
import { SegmentedControl, SegmentedControlItem } from "@/components/sodium/ui/segmented-control";
import { Switch } from "@/components/sodium/ui/switch";
import { Status } from "@/components/sodium/ui/status";
import { ArrowLeft, Icon, Pause, Play, Previous } from "@/components/sodium/icon";

/* The stems of a track laid out like a DAW playlist: one lane per Demucs stem with its waveform under a bar ruler, and
   at the left of each lane its name, mute, solo and level. The track plays through the same eight-channel split the
   decks use (lib/deck-graph), so muting a stem here is the same as muting it on a deck. Click or drag on the lanes to move. */

/** Chart series tokens per stem, in STEMS order. */
const LANE_COLORS = ["--data-1", "--data-6", "--data-2", "--data-5"];
const BAR_STEPS = [1, 2, 4, 8, 16, 32, 64];

export type Grid = { beat: number; first: number } | null;
export const gridOf = (t: StoredTrack): Grid => t.bpm && t.bpm > 0 ? { beat: 60 / t.bpm, first: t.firstBeat ?? 0 } : null;
export const token = (name: string) => getComputedStyle(document.body).getPropertyValue(name).trim();

/** Canvas sized to its box at the display's pixel ratio, redrawn through `draw` when the size or `deps` change. */
export function useCanvas(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, deps: unknown[]) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el || !size.w || !size.h) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.round(size.w * dpr); el.height = Math.round(size.h * dpr);
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    draw(ctx, size.w, size.h);
    // draw is rebuilt every render; deps names what it actually reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, ...deps]);
  return ref;
}

export function Ruler({ duration, grid }: { duration: number; grid: Grid }) {
  const ref = useCanvas((ctx, w, h) => {
    if (!duration) return;
    const line = token("--line"), text = token("--text-3"), mono = token("--font-mono");
    ctx.font = `11px ${mono}`; ctx.textBaseline = "top"; ctx.fillStyle = text; ctx.strokeStyle = line; ctx.lineWidth = 1;
    const px = w / duration;
    const tick = (x: number, tall: boolean) => { ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, h - (tall ? 12 : 5)); ctx.lineTo(Math.round(x) + 0.5, h); ctx.stroke(); };
    if (grid) {
      const barPx = grid.beat * 4 * px;
      const every = BAR_STEPS.find(s => s * barPx >= 44) ?? BAR_STEPS[BAR_STEPS.length - 1];
      for (let n = 0; ; n++) {
        const t = grid.first + n * grid.beat;
        if (t > duration) break;
        if (t < 0) continue;
        const bar = n % 4 === 0, x = t * px;
        if (bar) {
          const index = n / 4;
          tick(x, true);
          if (index % every === 0) ctx.fillText(String(index + 1), x + 4, 3);
        } else if (grid.beat * px >= 8) tick(x, false);
      }
    } else {
      const every = [1, 2, 5, 10, 15, 30, 60, 120].find(s => s * px >= 56) ?? 120;
      for (let t = 0; t <= duration; t += every) { tick(t * px, true); ctx.fillText(formatTime(t), t * px + 4, 3); }
    }
  }, [duration, grid]);
  return <canvas ref={ref} className="block h-7 w-full" aria-hidden="true"/>;
}

function Lane({ peaks, color, dim, duration, grid }: { peaks: StemPeaks | undefined; color: string; dim: boolean; duration: number; grid: Grid }) {
  const ref = useCanvas((ctx, w, h) => {
    const line = token("--line-faint"), strong = token("--line");
    const px = duration ? w / duration : 0;
    // Beat lines behind the wave, a stronger one at each bar.
    if (grid && px) {
      for (let n = 0; ; n++) {
        const t = grid.first + n * grid.beat;
        if (t > duration) break;
        if (t < 0) continue;
        const bar = n % 4 === 0;
        if (!bar && grid.beat * px < 8) continue;
        ctx.strokeStyle = bar ? strong : line; ctx.lineWidth = 1;
        const x = Math.round(t * px) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
    }
    if (!peaks) return;
    const mid = h / 2, amp = mid - 4, n = peaks.max.length;
    ctx.fillStyle = token(color); ctx.globalAlpha = dim ? 0.25 : 1;
    // One column per pixel, each the extremes of the buckets it covers.
    for (let x = 0; x < w; x++) {
      const from = Math.floor(x / w * n), to = Math.max(from + 1, Math.floor((x + 1) / w * n));
      let lo = 0, hi = 0;
      for (let i = from; i < to && i < n; i++) { if (peaks.min[i] < lo) lo = peaks.min[i]; if (peaks.max[i] > hi) hi = peaks.max[i]; }
      const top = mid - hi * amp, bottom = mid - lo * amp;
      ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
    ctx.globalAlpha = 1;
  }, [peaks, color, dim, duration, grid]);
  return <canvas ref={ref} className="block h-24 w-full" aria-hidden="true"/>;
}

/** Newest first, one entry per file (copies share a fingerprint). Of several copies the one with stems is kept, else the oldest. */
function withStems(all: StoredTrack[]) {
  const best = new Map<string, StoredTrack>();
  for (const t of [...all].sort((a, b) => a.addedAt - b.addedAt)) {
    const key = t.fingerprint ?? t.id, kept = best.get(key);
    if (!kept || (!kept.stems && t.stems)) best.set(key, t);
  }
  return [...best.values()].sort((a, b) => b.addedAt - a.addedAt);
}

export function StemsView() {
  const [tracks, setTracks] = useState<StoredTrack[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [peaks, setPeaks] = useState<StemPeaks[] | undefined>();
  const [state, setState] = useState<"idle" | "reading" | "failed">("idle");
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [mute, setMute] = useState([false, false, false, false]);
  const [solo, setSolo] = useState([false, false, false, false]);
  const [level, setLevel] = useState([1, 1, 1, 1]);
  const [eq, setEq] = useState([0, 0, 0]);
  const [color, setColor] = useState(0);
  const [fx, setFx] = useState<EffectName>("off");
  const [fxAmount, setFxAmount] = useState(0.5);
  const [speed, setSpeed] = useState(1);
  const [keepPitch, setKeepPitch] = useState(true);
  const splitting = useStemProgress();
  const [splitError, setSplitError] = useState<string | null>(null);

  const media = useRef<HTMLAudioElement | null>(null);
  const context = useRef<AudioContext | null>(null);
  const gains = useRef<GainNode[]>([]);
  const deck = useRef<DeckGraph | null>(null);
  const playhead = useRef<HTMLDivElement>(null);
  const clock = useRef<HTMLSpanElement>(null);
  const peakCache = useRef(new Map<string, StemPeaks[]>());

  const all = useMemo(() => tracks ? withStems(tracks) : null, [tracks]);
  const ready = useMemo(() => all?.filter(t => t.stems) ?? [], [all]);
  const missing = useMemo(() => all?.filter(t => !t.stems) ?? [], [all]);
  const track = ready.find(t => t.id === selected) ?? null;
  const grid = useMemo(() => track ? gridOf(track) : null, [track]);

  useEffect(() => {
    let live = true;
    loadTracks().then(list => { if (live) setTracks(list); }, () => { if (live) setTracks([]); });
    return () => { live = false; };
  }, []);

  // One element and one eight-channel split for the page's life; the track only changes the element's source.
  useEffect(() => {
    const el = new Audio();
    el.preload = "auto";
    const ctx = new AudioContext();
    // The same chain a deck has (stem lanes, three-band EQ, color filter, effects), into a limiter so a bass boost cannot clip.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.001; limiter.release.value = 0.1;
    limiter.connect(ctx.destination);
    const graph = createDeckGraph(ctx, limiter);
    ctx.createMediaElementSource(el).connect(graph.splitter);
    gains.current = graph.stems; deck.current = graph;
    media.current = el; context.current = ctx;
    return () => { el.pause(); el.removeAttribute("src"); el.load(); void ctx.close(); media.current = null; context.current = null; };
  }, []);

  // Writes only what changed: the playhead moves every frame, the clock text once a second.
  const drawn = useRef({ left: "", time: "" });
  const paint = useCallback(() => {
    const el = media.current;
    if (!el) return;
    const total = el.duration || 0;
    const left = total ? `${Math.min(100, el.currentTime / total * 100)}%` : "0%", time = formatTime(el.currentTime);
    if (playhead.current && drawn.current.left !== left) { playhead.current.style.left = left; drawn.current.left = left; }
    if (clock.current && drawn.current.time !== time) { clock.current.textContent = time; drawn.current.time = time; }
  }, []);

  useEffect(() => {
    const el = media.current;
    if (!el) return;
    const sync = () => { setPlaying(!el.paused); paint(); };
    const meta = () => { if (Number.isFinite(el.duration)) setDuration(el.duration); paint(); };
    el.addEventListener("play", sync); el.addEventListener("pause", sync); el.addEventListener("ended", sync);
    el.addEventListener("seeked", paint); el.addEventListener("loadedmetadata", meta); el.addEventListener("durationchange", meta);
    return () => {
      el.removeEventListener("play", sync); el.removeEventListener("pause", sync); el.removeEventListener("ended", sync);
      el.removeEventListener("seeked", paint); el.removeEventListener("loadedmetadata", meta); el.removeEventListener("durationchange", meta);
    };
  }, [paint]);

  // The playhead follows the element's clock every frame while it plays.
  useEffect(() => {
    if (!playing) return;
    let frame = requestAnimationFrame(function tick() { paint(); frame = requestAnimationFrame(tick); });
    return () => cancelAnimationFrame(frame);
  }, [playing, paint]);

  // Load the selected track: its stems file into the element, and its waveforms into the lanes.
  useEffect(() => {
    const el = media.current;
    if (!el) return;
    el.pause();
    if (!track?.stems) { el.removeAttribute("src"); el.load(); return; }
    const url = URL.createObjectURL(track.stems);
    el.src = url; el.load();
    const cached = peakCache.current.get(track.id);
    let live = true;
    if (cached) { queueMicrotask(() => { if (live) { setPeaks(cached); setState("idle"); } }); }
    else {
      queueMicrotask(() => { if (live) { setPeaks(undefined); setState("reading"); } });
      stemPeaks(track.stems).then(p => {
        peakCache.current.set(track.id, p);
        if (live) { setPeaks(p); setState("idle"); }
      }, () => { if (live) setState("failed"); });
    }
    return () => { live = false; URL.revokeObjectURL(url); };
  }, [track]);

  // Speed of the whole track. The element resets its rate to the default when the source changes, so both are set.
  // With keepPitch the pitch holds (time-stretch); without it the pitch moves with the speed, like a record.
  useEffect(() => {
    const el = media.current;
    if (!el) return;
    el.defaultPlaybackRate = speed; el.playbackRate = speed;
    const m = el as HTMLAudioElement & { webkitPreservesPitch?: boolean };
    m.preservesPitch = keepPitch;
    if ("webkitPreservesPitch" in m) m.webkitPreservesPitch = keepPitch;
  }, [speed, keepPitch, track]);

  // EQ in dB (-24 cuts the band out), the one-knob color filter and the effect, on the same graph a deck uses.
  useEffect(() => {
    const ctx = context.current, d = deck.current;
    if (!ctx || !d) return;
    const t = ctx.currentTime;
    d.low.gain.setTargetAtTime(eq[0], t, 0.02); d.mid.gain.setTargetAtTime(eq[1], t, 0.02); d.high.gain.setTargetAtTime(eq[2], t, 0.02);
    applyColor(ctx, d, color);
    applyEffect(ctx, d, fx, fxAmount);
  }, [eq, color, fx, fxAmount]);

  // A stem sounds when it is not muted and, if any lane is soloed, when it is one of them. Fades a few ms: no click.
  useEffect(() => {
    const ctx = context.current;
    if (!ctx) return;
    const anySolo = solo.some(Boolean);
    gains.current.forEach((g, k) => {
      const audible = anySolo ? solo[k] : !mute[k];
      g.gain.setTargetAtTime(audible ? level[k] : 0, ctx.currentTime, 0.015);
    });
  }, [mute, solo, level]);

  const pickRef = useRef<(id: string) => void>(() => {});
  const pick = (id: string) => { setSelected(id); setSpeed(1); setEq([0, 0, 0]); setColor(0); setFx("off"); setDuration(0); setPlaying(false); setMute([false, false, false, false]); setSolo([false, false, false, false]); setLevel([1, 1, 1, 1]); };
  useEffect(() => { pickRef.current = pick; });
  /** Separates a track with Demucs (/api/stems), keeps the stems file with it and opens it. One job at a time on the server. */
  async function split(t: StoredTrack) {
    if (splitting[t.id] !== undefined) return;
    setSplitError(null);
    // The job and its toast live in lib/background-jobs: leaving this page does not stop them.
    await startStemJob({ id: t.id, title: t.title, blob: t.blob, fileName: t.fileName });
  }
  // A job that finishes while this page is open (started here or elsewhere) lands on its track and opens it.
  useEffect(() => onStemsDone(d => {
    setTracks(list => list?.map(x => x.id === d.trackId ? { ...x, stems: d.blob, stemEnergy: d.stemEnergy } : x) ?? list);
    pickRef.current(d.trackId);
  }), []);
  const toggle = useCallback(async () => {
    const el = media.current;
    if (!el || !el.src) return;
    if (el.paused) { await context.current?.resume(); await el.play().catch(() => undefined); } else el.pause();
  }, []);
  const rewind = () => { const el = media.current; if (el) { el.currentTime = 0; paint(); } };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("button, input, a, [role=slider]") || t.isContentEditable)) return;
      e.preventDefault(); void toggle();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [toggle]);

  // Click or drag on the ruler and lanes to move the playhead.
  const scrub = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = media.current;
    if (!el || !el.duration) return;
    const box = e.currentTarget.getBoundingClientRect();
    el.currentTime = Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)) * el.duration;
    paint();
  };
  const set = <T,>(list: T[], k: number, v: T) => list.map((x, i) => i === k ? v : x);

  return <div className="flex min-h-dvh flex-col bg-page text-text-1">
    <div className="px-4 pt-4">
      <header className="flex h-12 items-stretch border border-line bg-panel">
        <Link href="/" className="flex items-center gap-2 border-e border-line px-4 type-label text-text-2 hover:text-text-1"><Icon icon={ArrowLeft}/>Decks</Link>
        <h1 className="flex items-center px-4 type-heading-sm">Stems</h1>
        <div className="ms-auto flex items-center border-s border-line px-4">
          <Status size="sm" status={state === "reading" ? "running" : state === "failed" ? "fail" : "idle"}>
            {state === "reading" ? "Reading waveforms" : state === "failed" ? "Could not read" : track ? "Ready" : "Pick a track"}
          </Status>
        </div>
      </header>
    </div>

    <main className="flex min-h-0 flex-1 flex-col gap-4 p-4 lg:flex-row">
      <section className="h-fit border border-line bg-panel lg:w-72 lg:shrink-0" aria-labelledby="tracks">
        <div className="flex h-12 items-center border-b border-line px-4"><h2 id="tracks" className="type-heading-sm">Tracks</h2></div>
        {all === null ? <p className="p-4 type-body-sm text-text-3">Loading the library…</p>
          : all.length === 0 ? <p className="p-4 type-body-sm text-text-2">The library is empty. Add tracks on the decks page.</p>
          : <>
            {ready.length === 0 && <p className="p-4 type-body-sm text-text-2">No track has stems yet. Split one from the stems pads on the decks page; it shows up here.</p>}
            <ul className="divide-y divide-line-faint">
              {ready.map(t => <li key={t.id}>
                <Button variant={selected === t.id ? "secondary" : "ghost"} size="sm" onClick={() => pick(t.id)} aria-pressed={selected === t.id} className="w-full justify-between">
                  <span className="min-w-0 truncate">{t.title}</span>
                  {t.bpm ? <span className="shrink-0 text-text-3">{Math.round(t.bpm)}</span> : null}
                </Button>
              </li>)}
            </ul>
            {missing.length > 0 && <div className="border-t border-line">
              <p className="px-4 py-2 type-label-sm text-text-3">Without stems</p>
              {splitError && <p role="alert" className="px-4 pb-2 type-body-sm text-fail-text">{splitError}</p>}
              <ul className="divide-y divide-line-faint border-t border-line-faint">
                {missing.map(t => <li key={t.id} className="flex items-center gap-2 px-4 py-1">
                  <span className="min-w-0 flex-1 truncate type-body-sm text-text-2">{t.title}</span>
                  <Button size="sm" variant="secondary" disabled={Object.keys(splitting).length > 0} onClick={() => void split(t)}>
                    {splitting[t.id] !== undefined ? `${Math.round(splitting[t.id] * 100)}%` : "Split"}
                  </Button>
                </li>)}
              </ul>
            </div>}
          </>}
      </section>

      <section className="min-w-0 flex-1 border border-line bg-panel" aria-labelledby="playlist">
        <div className="flex h-12 items-center gap-2 border-b border-line px-4">
          <Button size="icon-sm" variant="secondary" onClick={rewind} disabled={!track} aria-label="Back to start"><Icon icon={Previous}/></Button>
          <Button size="icon-sm" onClick={() => void toggle()} disabled={!track} aria-label={playing ? "Pause" : "Play"}><Icon icon={playing ? Pause : Play}/></Button>
          <span className="type-code-sm text-text-1"><span ref={clock}>0:00</span><span className="text-text-3"> / {formatTime(duration || track?.duration || 0)}</span></span>
          <h2 id="playlist" className="ms-auto min-w-0 truncate type-heading-sm">{track ? track.title : "Playlist"}</h2>
        </div>

        {track && <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2">
          <span className="type-label-sm text-text-3">Speed</span>
          <div className="w-48"><Slider aria-label="Playback speed" min={50} max={150} value={Math.round(speed * 100)}
            onValueChange={v => setSpeed((Array.isArray(v) ? v[0] : v) / 100)}/></div>
          <span className="w-12 type-code-sm text-text-1">{Math.round(speed * 100)}%</span>
          {track.bpm ? <span className="type-code-sm text-text-2">{(track.bpm * speed).toFixed(1)} BPM</span> : null}
          <label className="flex items-center gap-2 type-label-sm text-text-2"><Switch checked={keepPitch} onCheckedChange={setKeepPitch} aria-label="Keep pitch"/>Keep pitch</label>
          {!keepPitch && speed !== 1 && <span className="type-code-sm text-text-3">{(12 * Math.log2(speed)).toFixed(1)} st</span>}
          <Button size="sm" variant="ghost" disabled={speed === 1} onClick={() => setSpeed(1)}>Reset</Button>
        </div>}

        {track && <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line px-4 py-2">
          {(["Low", "Mid", "High"] as const).map((name, i) => <div key={name} className="flex items-center gap-2">
            <span className="w-8 type-label-sm text-text-3">{name}</span>
            <div className="w-28"><Slider aria-label={`${name} EQ`} min={-24} max={12} value={eq[i]} onValueChange={v => setEq(e => e.map((x, j) => j === i ? (Array.isArray(v) ? v[0] : v) : x))}/></div>
            <span className="w-14 type-code-sm text-text-2">{eq[i] <= -24 ? "kill" : `${eq[i] > 0 ? "+" : ""}${eq[i]} dB`}</span>
          </div>)}
          <div className="flex items-center gap-2">
            <span className="w-12 type-label-sm text-text-3">Filter</span>
            <div className="w-32"><Slider aria-label="Filter" min={-100} max={100} value={Math.round(color * 100)} onValueChange={v => setColor((Array.isArray(v) ? v[0] : v) / 100)}/></div>
            <span className="w-12 type-code-sm text-text-2">{Math.abs(color) < 0.02 ? "off" : color < 0 ? "LP" : "HP"}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="type-label-sm text-text-3">Effect</span>
            <SegmentedControl size="sm" aria-label="Effect" value={fx} onValueChange={v => setFx(v as EffectName)}>
              <SegmentedControlItem value="off">Off</SegmentedControlItem>
              {EFFECTS.map(e => <SegmentedControlItem key={e.id} value={e.id}>{e.label}</SegmentedControlItem>)}
            </SegmentedControl>
            <div className="w-24"><Slider aria-label="Effect amount" min={0} max={100} disabled={fx === "off"} value={Math.round(fxAmount * 100)} onValueChange={v => setFxAmount((Array.isArray(v) ? v[0] : v) / 100)}/></div>
          </div>
          <Button size="sm" variant="ghost" disabled={eq.every(x => x === 0) && color === 0 && fx === "off"} onClick={() => { setEq([0, 0, 0]); setColor(0); setFx("off"); }}>Reset mixer</Button>
        </div>}

        {!track ? <p className="p-4 type-body-sm text-text-2">Choose a track to see its vocals, drums, bass and melody on their own lanes.</p>
          : <div className="flex overflow-hidden">
            <div className="w-44 shrink-0 border-e border-line">
              <div className="h-7 border-b border-line"/>
              {STEMS.map((s, k) => {
                const audible = solo.some(Boolean) ? solo[k] : !mute[k];
                return <div key={s.id} className="flex h-24 flex-col justify-between border-b border-line-faint px-3 py-2 last:border-b-0">
                  <div className="flex items-center gap-2">
                    <span className={cn("size-(--marker) shrink-0 bg-(--swatch)", !audible && "opacity-30")} style={{ "--swatch": `var(${LANE_COLORS[k]})` } as React.CSSProperties} aria-hidden="true"/>
                    <span className="min-w-0 flex-1 truncate type-label text-text-1">{s.label}</span>
                    <Button size="icon-sm" variant={mute[k] ? "primary" : "secondary"} aria-pressed={mute[k]} aria-label={`Mute ${s.label}`}
                      onClick={() => setMute(m => set(m, k, !m[k]))}><span className="type-label-sm">M</span></Button>
                    <Button size="icon-sm" variant={solo[k] ? "primary" : "secondary"} aria-pressed={solo[k]} aria-label={`Solo ${s.label}`}
                      onClick={() => setSolo(m => set(m, k, !m[k]))}><span className="type-label-sm">S</span></Button>
                  </div>
                  <Slider aria-label={`${s.label} level`} min={0} max={100} value={Math.round(level[k] * 100)}
                    onValueChange={v => setLevel(l => set(l, k, (Array.isArray(v) ? v[0] : v) / 100))}/>
                </div>;
              })}
            </div>

            <div className="relative min-w-0 flex-1 touch-none select-none"
              onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); scrub(e); }}
              onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) scrub(e); }}>
              <div className="border-b border-line"><Ruler duration={duration || track.duration} grid={grid}/></div>
              {STEMS.map((s, k) => {
                const audible = solo.some(Boolean) ? solo[k] : !mute[k];
                return <div key={s.id} className="border-b border-line-faint last:border-b-0">
                  <Lane peaks={peaks?.[k]} color={LANE_COLORS[k]} dim={!audible} duration={duration || track.duration} grid={grid}/>
                </div>;
              })}
              <div ref={playhead} className="pointer-events-none absolute inset-y-0 left-0 w-px bg-accent-edge" aria-hidden="true"/>
            </div>
          </div>}
      </section>
    </main>
    <p className="shrink-0 px-4 pb-4 type-label-sm text-text-3">Space play · click or drag the lanes to move · M mute · S solo</p>
  </div>;
}
