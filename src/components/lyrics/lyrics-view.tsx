"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadTracks } from "@/lib/storage";
import { onLyricsDone, startLyricsJob, useLyricsProgress } from "@/lib/background-jobs";
import { createDeckGraph, type DeckGraph } from "@/lib/deck-graph";
import { groupLines, indexAt, shifted, toLrc } from "@/lib/lyrics";
import { formatTime, type StoredTrack } from "@/lib/types";
import { cn } from "@/lib/sodium/utils";
import { Button } from "@/components/sodium/ui/button";
import { Switch } from "@/components/sodium/ui/switch";
import { Status } from "@/components/sodium/ui/status";
import { Pick } from "@/components/pick";
import { ArrowLeft, Download, Icon, Pause, Play, Previous } from "@/components/sodium/icon";

/* Karaoke: a track's lyrics with a time on every word (lib/lyrics, from Whisper through /api/lyrics), shown as the track
   plays. The line being sung is large, the words already sung are dark and the word now sung is marked; click a line to
   jump to it. A track with stems plays through the same eight-channel split the decks use, so Vocals turns the singer
   off and leaves the instrumental. Whisper's times can run a little early or late, so Earlier and Later move all of them. */

const LANGUAGES = [
  { value: "auto", label: "Detect language" }, { value: "en", label: "English" }, { value: "es", label: "Spanish" },
  { value: "pt", label: "Portuguese" }, { value: "fr", label: "French" }, { value: "it", label: "Italian" },
  { value: "de", label: "German" }, { value: "ja", label: "Japanese" }, { value: "ko", label: "Korean" },
] as const;
const NUDGE = 0.1;

/** Newest first, one entry per file (copies share a fingerprint). Of several copies the one with lyrics is kept, else the one with stems. */
function unique(all: StoredTrack[]) {
  const best = new Map<string, StoredTrack>();
  const rank = (t: StoredTrack) => (t.lyrics ? 2 : 0) + (t.stems ? 1 : 0);
  for (const t of [...all].sort((a, b) => a.addedAt - b.addedAt)) {
    const key = t.fingerprint ?? t.id, kept = best.get(key);
    if (!kept || rank(t) > rank(kept)) best.set(key, t);
  }
  return [...best.values()].sort((a, b) => b.addedAt - a.addedAt);
}

const fileNameOf = (t: StoredTrack) => `${[t.artist, t.title].filter(Boolean).join(" - ").replace(/[\\/:*?"<>|]/g, "") || "lyrics"}.lrc`;

export function LyricsView() {
  const [tracks, setTracks] = useState<StoredTrack[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [language, setLanguage] = useState("auto");
  const [available, setAvailable] = useState<boolean | null>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [offset, setOffset] = useState(0);
  const [vocals, setVocals] = useState(true);
  /** The line and word being sung, as indexes into the lines. */
  const [at, setAt] = useState({ line: -1, word: -1 });
  const transcribing = useLyricsProgress();

  const media = useRef<HTMLAudioElement | null>(null);
  const context = useRef<AudioContext | null>(null);
  const graph = useRef<DeckGraph | null>(null);
  const clock = useRef<HTMLSpanElement>(null);
  const lineRefs = useRef<(HTMLElement | null)[]>([]);

  const all = useMemo(() => tracks ? unique(tracks) : null, [tracks]);
  const ready = useMemo(() => all?.filter(t => t.lyrics) ?? [], [all]);
  const missing = useMemo(() => all?.filter(t => !t.lyrics) ?? [], [all]);
  const track = ready.find(t => t.id === selected) ?? null;
  const words = useMemo(() => track?.lyrics ? shifted(track.lyrics.words, offset) : [], [track, offset]);
  const lines = useMemo(() => groupLines(words), [words]);
  const starts = useMemo(() => lines.map(l => l.t), [lines]);

  useEffect(() => {
    let live = true;
    loadTracks().then(list => { if (live) setTracks(list); }, () => { if (live) setTracks([]); });
    fetch("/api/lyrics").then(res => res.ok ? res.json() as Promise<{ available: boolean }> : { available: false })
      .then(res => { if (live) setAvailable(res.available); }, () => { if (live) setAvailable(false); });
    return () => { live = false; };
  }, []);

  // /lyrics?track=<id> opens that track, the way the library's Karaoke link does.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("track");
    if (id) queueMicrotask(() => setSelected(id));
  }, []);

  // One audio context and one deck graph for the page's life; each track brings its own element.
  useEffect(() => {
    const ctx = new AudioContext();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.001; limiter.release.value = 0.1;
    limiter.connect(ctx.destination);
    context.current = ctx; graph.current = createDeckGraph(ctx, limiter);
    return () => { void ctx.close(); context.current = null; graph.current = null; };
  }, []);

  const paint = useCallback(() => {
    const el = media.current;
    if (!el) return;
    const time = formatTime(el.currentTime);
    if (clock.current && clock.current.textContent !== time) clock.current.textContent = time;
  }, []);

  // The track's element: its stems file when it has one (so the vocals can be turned off), else the track itself.
  useEffect(() => {
    const ctx = context.current, g = graph.current;
    if (!ctx || !g || !track) return;
    const el = new Audio();
    el.preload = "auto";
    const url = URL.createObjectURL(track.stems ?? track.blob);
    el.src = url;
    const source = ctx.createMediaElementSource(el);
    source.connect(track.stems ? g.splitter : g.input);
    media.current = el;
    const sync = () => { setPlaying(!el.paused); paint(); };
    const meta = () => { if (Number.isFinite(el.duration)) setDuration(el.duration); paint(); };
    el.addEventListener("play", sync); el.addEventListener("pause", sync); el.addEventListener("ended", sync);
    el.addEventListener("seeked", paint); el.addEventListener("loadedmetadata", meta); el.addEventListener("durationchange", meta);
    return () => {
      el.pause(); source.disconnect();
      el.removeEventListener("play", sync); el.removeEventListener("pause", sync); el.removeEventListener("ended", sync);
      el.removeEventListener("seeked", paint); el.removeEventListener("loadedmetadata", meta); el.removeEventListener("durationchange", meta);
      el.removeAttribute("src"); el.load(); URL.revokeObjectURL(url);
      if (media.current === el) media.current = null;
      setPlaying(false); setDuration(0); setAt({ line: -1, word: -1 });
    };
  }, [track, paint]);

  // Vocals off keeps the other three stems; a track without stems has no vocals to turn off.
  useEffect(() => {
    const ctx = context.current, g = graph.current;
    if (!ctx || !g) return;
    g.stems[0].gain.setTargetAtTime(vocals || !track?.stems ? 1 : 0, ctx.currentTime, 0.015);
  }, [vocals, track]);

  // The line and word under the playhead, read every frame while it plays; state changes only when they move.
  const follow = useCallback(() => {
    const el = media.current;
    if (!el) return;
    const time = el.currentTime;
    const line = indexAt(starts, time);
    const word = line < 0 ? -1 : indexAt(lines[line].words.map(w => w.t), time);
    setAt(prev => prev.line === line && prev.word === word ? prev : { line, word });
    paint();
  }, [starts, lines, paint]);
  useEffect(() => {
    if (!playing) return;
    let frame = requestAnimationFrame(function tick() { follow(); frame = requestAnimationFrame(tick); });
    return () => cancelAnimationFrame(frame);
  }, [playing, follow]);
  // A seek or a nudge while paused still moves the highlight.
  useEffect(() => { queueMicrotask(follow); }, [follow, offset, track]);

  // Keep the line being sung in the middle of the box.
  useEffect(() => {
    if (at.line < 0) return;
    lineRefs.current[at.line]?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [at.line]);

  const toggle = useCallback(async () => {
    const el = media.current;
    if (!el) return;
    if (el.paused) { await context.current?.resume(); await el.play().catch(() => undefined); } else el.pause();
  }, []);
  const jump = (seconds: number) => { const el = media.current; if (el) { el.currentTime = Math.max(0, seconds); follow(); } };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("button, input, a, [role=button], [role=slider], [role=combobox]") || t.isContentEditable)) return;
      e.preventDefault(); void toggle();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [toggle]);

  // A transcription that finishes while this page is open (started here or in the library) lands on its track and opens it.
  useEffect(() => onLyricsDone(d => {
    setTracks(list => list?.map(x => x.id === d.trackId ? { ...x, lyrics: d.lyrics } : x) ?? list);
    setSelected(d.trackId); setOffset(0);
  }), []);

  const pick = (id: string) => { setSelected(id); setOffset(0); setVocals(true); };
  const transcribe = (t: StoredTrack) => {
    if (transcribing[t.id] !== undefined) return;
    // The job and its toast live in lib/background-jobs: leaving this page does not stop them.
    void startLyricsJob({ id: t.id, title: t.title, blob: t.blob, fileName: t.fileName, stems: t.stems, language });
  };
  const download = () => {
    if (!track) return;
    const url = URL.createObjectURL(new Blob([toLrc(lines, { title: track.title, artist: track.artist }, true)], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url; a.download = fileNameOf(track); a.click();
    URL.revokeObjectURL(url);
  };
  const busy = Object.keys(transcribing).length > 0;
  const state = busy ? "running" : track ? "ok" : "idle";

  return <div className="flex min-h-dvh flex-col bg-page text-text-1">
    <div className="px-4 pt-4">
      <header className="flex h-12 items-stretch border border-line bg-panel">
        <Link href="/" className="flex items-center gap-2 border-e border-line px-4 type-label text-text-2 hover:text-text-1"><Icon icon={ArrowLeft}/>Decks</Link>
        <h1 className="flex items-center px-4 type-heading-sm">Karaoke</h1>
        <div className="ms-auto flex items-center border-s border-line px-4">
          <Status size="sm" status={state}>{busy ? "Transcribing" : track ? "Ready" : "Pick a track"}</Status>
        </div>
      </header>
    </div>

    <main className="flex min-h-0 flex-1 flex-col gap-4 p-4 lg:flex-row">
      <section className="h-fit border border-line bg-panel lg:w-72 lg:shrink-0" aria-labelledby="tracks">
        <div className="flex h-12 items-center border-b border-line px-4"><h2 id="tracks" className="type-heading-sm">Tracks</h2></div>
        {all === null ? <p className="p-4 type-body-sm text-text-3">Loading the library…</p>
          : all.length === 0 ? <p className="p-4 type-body-sm text-text-2">The library is empty. Add tracks on the decks page.</p>
          : <>
            {ready.length === 0 && <p className="p-4 type-body-sm text-text-2">No track has lyrics yet. Transcribe one below, or from the library on the decks page.</p>}
            <ul className="divide-y divide-line-faint">
              {ready.map(t => <li key={t.id}>
                <Button variant={selected === t.id ? "secondary" : "ghost"} size="sm" onClick={() => pick(t.id)} aria-pressed={selected === t.id} className="w-full justify-between">
                  <span className="min-w-0 truncate">{t.title}</span>
                  {t.stems ? <span className="shrink-0 text-text-3">Stems</span> : null}
                </Button>
              </li>)}
            </ul>
            {missing.length > 0 && <div className="border-t border-line">
              <div className="flex items-center justify-between gap-2 px-4 py-2">
                <p className="type-label-sm text-text-3">Without lyrics</p>
                <Pick size="sm" items={LANGUAGES} value={language} onValueChange={setLanguage} aria-label="Language of the lyrics" className="w-36"/>
              </div>
              {available === false && <p role="alert" className="px-4 pb-2 type-body-sm text-fail-text">Whisper is not installed on this machine. Run npm run setup:whisper.</p>}
              <ul className="divide-y divide-line-faint border-t border-line-faint">
                {missing.map(t => <li key={t.id} className="flex items-center gap-2 px-4 py-1">
                  <span className="min-w-0 flex-1 truncate type-body-sm text-text-2">{t.title}</span>
                  <Button size="sm" variant="secondary" disabled={!available || busy} onClick={() => transcribe(t)}>
                    {transcribing[t.id] !== undefined ? `${Math.round(transcribing[t.id] * 100)}%` : "Transcribe"}
                  </Button>
                </li>)}
              </ul>
            </div>}
          </>}
      </section>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col border border-line bg-panel" aria-labelledby="lyrics">
        <div className="flex h-12 items-center gap-2 border-b border-line px-4">
          <Button size="icon-sm" variant="secondary" onClick={() => jump(0)} disabled={!track} aria-label="Back to start"><Icon icon={Previous}/></Button>
          <Button size="icon-sm" onClick={() => void toggle()} disabled={!track} aria-label={playing ? "Pause" : "Play"}><Icon icon={playing ? Pause : Play}/></Button>
          <span className="type-code-sm text-text-1"><span ref={clock}>00:00</span><span className="text-text-3"> / {formatTime(duration || track?.duration || 0)}</span></span>
          <h2 id="lyrics" className="ms-auto min-w-0 truncate type-heading-sm">{track ? track.title : "Lyrics"}</h2>
        </div>

        {track && <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2">
          <label className={cn("flex items-center gap-2 type-label-sm", track.stems ? "text-text-2" : "text-text-disabled")}>
            <Switch checked={vocals || !track.stems} disabled={!track.stems} onCheckedChange={setVocals} aria-label="Vocals"/>Vocals
          </label>
          {!track.stems && <span className="type-body-sm text-text-3">Split the stems to turn the singer off.</span>}
          <span className="ms-auto type-label-sm text-text-3">Timing</span>
          <Button size="sm" variant="secondary" onClick={() => setOffset(o => Math.round((o - NUDGE) * 10) / 10)}>Earlier</Button>
          <span className="w-16 text-center type-code-sm text-text-1">{`${offset > 0 ? "+" : ""}${offset.toFixed(1)} s`}</span>
          <Button size="sm" variant="secondary" onClick={() => setOffset(o => Math.round((o + NUDGE) * 10) / 10)}>Later</Button>
          <Button size="sm" variant="ghost" disabled={offset === 0} onClick={() => setOffset(0)}>Reset</Button>
          <Button size="sm" variant="ghost" onClick={download}><Icon icon={Download}/>Download LRC</Button>
        </div>}

        {!track ? <p className="p-4 type-body-sm text-text-2">Choose a track to sing along. Its words light up as they come, and a click on a line jumps to it.</p>
          : <div className="relative max-h-(--box) min-h-0 flex-1 overflow-y-auto" style={{ "--box": "calc(100dvh - 15rem)" } as React.CSSProperties} tabIndex={0} aria-label="Lyrics">
            <ol className="flex flex-col gap-4 px-6 py-[30vh]">
              {lines.map((line, i) => {
                const current = i === at.line, sung = i < at.line;
                return <li key={`${line.t}-${i}`} ref={el => { lineRefs.current[i] = el; }}>
                  <div role="button" tabIndex={0} onClick={() => jump(line.t)} aria-current={current ? "true" : undefined}
                    onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); jump(line.t); } }}
                    className={cn("w-full cursor-pointer text-start focus-visible:focus-ring-inset", current ? "type-heading" : "type-body", !current && (sung ? "text-text-2" : "text-text-3"))}>
                    {current ? line.words.map((w, k) => <span key={k} className={cn(k < at.word ? "text-text-1" : k === at.word ? "text-accent-text" : "text-text-3")}>{w.w}{k < line.words.length - 1 ? " " : ""}</span>) : line.text}
                  </div>
                </li>;
              })}
            </ol>
          </div>}
      </section>
    </main>
    <p className="shrink-0 px-4 pb-4 type-label-sm text-text-3">Space play · click a line to jump to it · Earlier and Later move the timing</p>
  </div>;
}
