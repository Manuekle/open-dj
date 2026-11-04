"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { DJEngine } from "@/lib/audio-engine";
import { DeckPositions } from "@/hooks/use-deck-position";
import { DEFAULT_GOVERNOR, DriftGovernor, UNLOCKED_MAX_RATE_DEVIATION, UNLOCKED_MAX_TRIM, phaseReading } from "@/lib/drift";
import { crossGains } from "@/lib/mix-session";
import { overlayMix } from "@/lib/mix-view";
import { LOOKAHEAD, LatencyTracker, prerollSeconds } from "@/lib/preroll";
import { AutoMix, PREROLL, type AutoMixHost } from "@/lib/automix";
import { MediaLoadError, whenMediaBuffered } from "@/lib/media-ready";
import { readQueue } from "@/lib/queue";
import { gridFromTempo } from "@/lib/manual-tempo";
import { gridBpm } from "@/lib/grid";
import { ANALYSIS_VERSION, analyzeFile, analyzeRhythmAndStructure, analyzeStems, fingerprintOf, staleness, clearSamples, dropSamples, inferName, probeDuration, type Analysis } from "@/lib/analyze";
import { autoTrim, foldMultiple, movesStems, planRatio, presetOf, shapeOfPlan, spanOn, swapsBassStem, syncRate } from "@/lib/transition";
import { mixFeatures } from "@/lib/mix-features";
import { DEFAULT_SMART_STYLE, planTransition, scorePlan, styleKey, styleOptions, withStyle, type Evaluation, type PlannerResult, type SmartStyle } from "@/lib/transition-planner";
import { clearTracks, loadMixes, loadTracks, removeMix, removeTrack, saveMix, saveTrack } from "@/lib/storage";
import { coverNeedsShrink, readTags, shrinkCover } from "@/lib/tags";
import { toast } from "@/components/sodium/ui/toast";
import { downloadFromLink, onDownloaded, onLyricsDone, onStemsDone, startLyricsJob, startStemJob, stemToastId, takePendingImports, useLyricsProgress, useStemProgress } from "@/lib/background-jobs";
import { makeDeck, type DeckId, type DeckState, type EffectName, type Session, type StoredMix, type StoredTrack, type Track, type TransitionPlan, type TransitionState } from "@/lib/types";

const DECK_IDS = ["A", "B"] as const;
const MAX_FILE_BYTES = 150 * 1024 * 1024;
const AUDIO_EXTENSION = /\.(mp3|wav|m4a|ogg|flac|aac)$/i;
const other = (id: DeckId): DeckId => id === "A" ? "B" : "A";
/** Seconds a skipped or broken-off blend takes to finish, and a blend that has lost sync takes to leave. */
const FINISH_SECONDS = 0.2;
const FALLBACK_SECONDS = 2;
/** How far a tempo match may sit from a deck's own tempo before the deck takes its tempo back after a blend. */
const MAX_KEEP_STRETCH = 0.08;
/** Seconds an AI plan for AutoMix must leave before its out point, or it arrives too late to play as planned. */
const AI_RUNWAY = 12;
/** How many queued tracks after the next one the set view plans ahead. */
const SET_AHEAD = 10;
/** One track of the set as it will play, and the plan that takes it into the next one (null for the last). */
export type SetEntry = { track: Track; uid: string | null; plan: TransitionPlan | null };
/** Resolves when a media element's clock moves (its audio is running), or after a second. */
async function audioMoving(media: HTMLMediaElement, limit = 1000) {
  const from = media.currentTime, began = performance.now();
  while (performance.now() - began < limit && !media.ended && Math.abs(media.currentTime - from) < 0.004) await wait(15);
}

/** What AutoMix asks of the player. Assigned every render, so it always sees the latest functions and state. */
type Bridge = {
  prepare(id: DeckId, track: Track, at: number): Promise<void>;
  analyze(track: Track): Promise<void>;
  preroll(): number;
  planFor(from: Track, to: Track): TransitionPlan;
  mix(plan: TransitionPlan, opts: { now: boolean; from: DeckId }): Promise<boolean>;
  abort(): void;
  cut(to: DeckId): Promise<boolean>;
  notify(message: string, kind: "info" | "fail"): void;
};
const NOT_READY = () => Promise.reject(new Error("Audio is not ready"));
const IDLE_BRIDGE: Bridge = { prepare: NOT_READY, analyze: NOT_READY, preroll: () => PREROLL, planFor: () => { throw new Error("Audio is not ready"); }, mix: () => Promise.resolve(false), abort: () => {}, cut: () => Promise.resolve(false), notify: () => {} };
type HostRefs = {
  engine: RefObject<DJEngine | null>; tracks: RefObject<Track[]>; decks: RefObject<Record<DeckId, DeckState>>;
  ids: RefObject<Record<DeckId, string | null>>; cross: RefObject<number>; bridge: RefObject<Bridge>; finish: RefObject<(() => void) | null>;
};
/** The player as AutoMix sees it. Positions and play state come from the media elements, never from React state, which
    lags a render behind; the track on a deck comes from a record written at the moment of every load. */
function makeHost(r: HostRefs): AutoMixHost {
  const media = (id: DeckId) => r.engine.current?.getMedia(id) ?? null;
  const playing = (id: DeckId) => { const m = media(id); return !!m && !m.paused && !m.ended; };
  return {
    track: id => r.tracks.current.find(t => t.id === id),
    deck: id => {
      const m = media(id), d = r.decks.current[id];
      return { trackId: r.ids.current[id], playing: playing(id), ended: !!m?.ended, position: m?.currentTime ?? d.position,
        duration: m && Number.isFinite(m.duration) ? m.duration : d.duration, rate: d.rate };
    },
    liveDeck: () => playing("A") && !playing("B") ? "A" : playing("B") && !playing("A") ? "B" : r.cross.current <= 0 ? "A" : "B",
    prepare: (id, track, at) => r.bridge.current.prepare(id, track, at),
    play: async id => { await r.engine.current?.play(id); },
    analyze: track => r.bridge.current.analyze(track),
    preroll: () => r.bridge.current.preroll(),
    planFor: (from, to) => r.bridge.current.planFor(from, to),
    startMix: (plan, opts) => r.bridge.current.mix(plan, opts),
    finishMix: () => r.finish.current?.(),
    abortMix: () => r.bridge.current.abort(),
    cut: to => r.bridge.current.cut(to),
    notify: (message, kind) => r.bridge.current.notify(message, kind),
  };
}
/** The planner's plans per pair, analysis and Smart AutoMix style, so a tick can ask for one without planning again. */
const planCache = new Map<string, PlannerResult>();

function toStored({ url, coverUrl, stemsUrl, ...stored }: Track): StoredTrack {
  void url; void coverUrl; void stemsUrl;
  return stored;
}
function revokeTrack(t: Track) {
  URL.revokeObjectURL(t.url);
  if (t.coverUrl) URL.revokeObjectURL(t.coverUrl);
  if (t.stemsUrl) URL.revokeObjectURL(t.stemsUrl);
}
const wait = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));
function downloadFile(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = fileName; a.style.display = "none";
  document.body.append(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function useDJ(inputRef: React.RefObject<HTMLInputElement | null>) {
  const engine = useRef<DJEngine | null>(null);
  const pendingTarget = useRef<DeckId | null>(null);
  const tracksRef = useRef<Track[]>([]);
  /** Fingerprints of files being imported right now, so the same file dropped twice at once is added once. */
  const importingPrints = useRef(new Set<string>());
  const decksRef = useRef<Record<DeckId, DeckState>>({ A: makeDeck(), B: makeDeck() });
  const [tracks, setTracks] = useState<Track[]>([]);
  const [mixes, setMixes] = useState<StoredMix[]>([]);
  const [decks, setDecks] = useState<Record<DeckId, DeckState>>({ A: makeDeck(), B: makeDeck() });
  /** Each deck's live playhead, for the components that show it; see DeckPositions. */
  const [positions] = useState(() => new DeckPositions());
  /** Starts an armed plan at its out point, from the poll (the decks state does not follow the playhead). */
  const armedRef = useRef<() => void>(() => {});
  const [cross, setCross] = useState(0);
  const [master, setMasterState] = useState(0.9);
  const [activeDeck, setActiveDeck] = useState<DeckId>("A");
  const [recording, setRecording] = useState(false);
  const [recordStart, setRecordStart] = useState(0);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [importing, setImporting] = useState(false);
  const [mixName, setMixName] = useState("");
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [transition, setTransition] = useState<TransitionState | null>(null);
  /** Whether the server can run Demucs (null until asked), and each separation under way, 0..1 by track id. */
  const [stemsAvailable, setStemsAvailable] = useState<boolean | null>(null);
  /** Whether /api/lyrics has whisper.cpp and a model (null until asked). */
  const [lyricsAvailable, setLyricsAvailable] = useState<boolean | null>(null);
  /** Whether /api/mix has a local model through Ollama, and the pair it is planning now ("from>to"). */
  const [aiAvailable, setAiAvailable] = useState<boolean | null>(null);
  const [planning, setPlanning] = useState<string | null>(null);
  const planningRef = useRef<string | null>(null);
  /** The library has loaded, so a saved session can be put back. */
  const [ready, setReady] = useState(false);
  /** Hot cues per track, so a track loaded again gets its cues back. */
  const cuesRef = useRef<Record<string, (number | null)[]>>({});
  const clock = useRef<number | null>(null);
  const seekCost = useRef(0.02);
  const mixing = useRef(false);
  /** The running mix, and whether its incoming deck was started by the mix (so a cancel can stop it again). */
  const activeMix = useRef<{ from: DeckId; to: DeckId; startedTo: boolean } | null>(null);
  /** Each deck's own tempo: what the DJ set by hand, 1 on load. A mix matches tempo on top of it, then hands it back. */
  const naturalRates = useRef<Record<DeckId, number>>({ A: 1, B: 1 });
  /** The timers gliding a deck back to its own tempo after a mix, so a load, a new mix or a cancel can drop them. */
  const rateRamps = useRef<Record<DeckId, number | null>>({ A: null, B: null });
  /** Wakes the Auto DJ at the moment its prepared transition is due, instead of waiting for the next 100 ms poll. The
      blend itself is already written to the audio thread ahead of time; this only starts the silent preroll on time. */
  const triggerTimer = useRef<number | null>(null);
  /** How long the incoming deck has taken to start, for the next preroll. */
  const latency = useRef(new LatencyTracker());
  const [savedPlans, setSavedPlans] = useState<Record<string, TransitionPlan>>({});
  /** Smart AutoMix's style (strategy, length, tempo matching, energy flow); "auto" leaves each to the planner. The ref
      is what AutoMix reads from its own clock. */
  const [smartStyle, setSmartStyleState] = useState<SmartStyle>(DEFAULT_SMART_STYLE);
  const smartStyleRef = useRef<SmartStyle>(DEFAULT_SMART_STYLE);
  const setSmartStyle = useCallback((patch: Partial<SmartStyle>) => setSmartStyleState(prev => {
    const next = { ...prev, ...patch };
    // The whole style, not only what shapes a plan: the AI and stems switches live in it too.
    if (styleKey(next) === styleKey(prev) && next.ai === prev.ai && next.autoStems === prev.autoStems) return prev;
    // AutoMix reads the style from its own clock, before React has re-rendered: keep the ref in step at once.
    smartStyleRef.current = next;
    return next;
  }), []);
  const [armed, setArmed] = useState<TransitionPlan | null>(null);
  /** Bumped by every cancel and every new mix: a mix that finds it changed after an await was cancelled, and stops. */
  const mixToken = useRef(0);
  /** False once the hook unmounts, so long jobs (stem polling) stop instead of running on. */
  const mounted = useRef(true);
  /** "from>to" of a mix that could not start (a track the browser cannot play), so auto mix does not retry it every render. */
  const failedMix = useRef<string | null>(null);
  /** The crossfader as the engine has it, for a cancel that runs from a timer's stale closure. */
  const crossRef = useRef(0);
  /** Pending beat-alignment re-checks, so a cancel, eject or unmount can drop them. */
  const alignTimers = useRef(new Set<number>());
  const mixRef = useRef<(plan: TransitionPlan, now: boolean) => void>(() => {});
  /** Which track each deck holds, written at the moment of every load: React state lags a render behind, AutoMix must not. */
  const trackIdsRef = useRef<Record<DeckId, string | null>>({ A: null, B: null });
  const savedPlansRef = useRef<Record<string, TransitionPlan>>({});
  /** Bumped by every load of a deck, so a wait for an older load knows it was replaced. */
  const loadTokens = useRef<Record<DeckId, number>>({ A: 0, B: 0 });
  /** Jumps the running mix to its end. */
  const finishRef = useRef<(() => void) | null>(null);
  const bridge = useRef<Bridge>(IDLE_BRIDGE);
  const [controller] = useState(() => new AutoMix(makeHost({ engine, tracks: tracksRef, decks: decksRef, ids: trackIdsRef, cross: crossRef, bridge, finish: finishRef })));
  const autoState = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => { tracksRef.current = tracks; }, [tracks]);
  // The state's position is frozen while a deck plays (see the poll), so the ref keeps the live one from the store.
  useEffect(() => {
    decksRef.current = { A: { ...decks.A, position: decks.A.playing ? positions.get("A") : decks.A.position },
      B: { ...decks.B, position: decks.B.playing ? positions.get("B") : decks.B.position } };
  }, [decks, positions]);
  useEffect(() => { savedPlansRef.current = savedPlans; }, [savedPlans]);
  useEffect(() => { smartStyleRef.current = smartStyle; }, [smartStyle]);
  // A plan saved by hand or by the AI, or a new style, changes what AutoMix will play next: let it publish that plan.
  useEffect(() => { controller.replan(); }, [controller, savedPlans, smartStyle]);

  const notify = useCallback((message: string, kind: "info" | "fail" = "info") => {
    if (kind === "fail") toast.fail(message); else toast(message);
  }, []);
  const updateDeck = useCallback((id: DeckId, patch: Partial<DeckState>) => {
    if (patch.trackId !== undefined) trackIdsRef.current[id] = patch.trackId;
    if (patch.position !== undefined) positions.set(id, patch.position);
    setDecks(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }, [positions]);
  /** Records that a track's file could not be decoded by the current analysis, in the library and on disk. */
  const markAnalysisFailed = useCallback(async (trackId: string) => {
    const current = tracksRef.current.find(t => t.id === trackId);
    if (!current || !mounted.current || (current.analysisFailed ?? 0) >= ANALYSIS_VERSION) return;
    const next: Track = { ...current, analysisFailed: ANALYSIS_VERSION };
    tracksRef.current = tracksRef.current.map(t => t.id === trackId ? next : t);
    setTracks(prev => prev.map(t => t.id === trackId ? { ...t, analysisFailed: ANALYSIS_VERSION } : t));
    await saveTrack(toStored(next)).catch(() => {});
  }, []);
  const level = useCallback((id: DeckId) => engine.current?.getLevel(id) ?? 0, []);
  /** The audio graph's clock and master bus, for the studio to play into, so a recording takes it too. */
  const output = useCallback(() => engine.current ? { context: engine.current.context, master: engine.current.master } : null, []);

  useEffect(() => {
    let alive = true;
    mounted.current = true;
    try {
      engine.current = new DJEngine();
      DECK_IDS.forEach(id => {
        const media = engine.current!.getMedia(id);
        media.addEventListener("ended", () => { if (alive) updateDeck(id, { playing: false }); });
        media.addEventListener("pause", () => { if (alive) updateDeck(id, { playing: false }); });
        media.addEventListener("play", () => { if (alive) updateDeck(id, { playing: true }); });
        media.addEventListener("error", () => { if (alive && trackIdsRef.current[id] && media.error) controller.deckError(id); });
      });
    } catch { window.setTimeout(() => { if (alive) notify("This browser does not support Web Audio. Try a recent Chrome, Edge or Safari.", "fail"); }, 100); }
    loadTracks().then(items => {
      if (!alive) return;
      const loaded = items.sort((a, b) => b.addedAt - a.addedAt).map(item => ({ ...item, url: URL.createObjectURL(item.blob),
        coverUrl: item.cover ? URL.createObjectURL(item.cover) : undefined, stemsUrl: item.stems ? URL.createObjectURL(item.stems) : undefined }));
      setTracks(loaded);
      tracksRef.current = loaded;
      setReady(true);
      void (async () => {
        // Tracks stored by an older analysis get tempo, beat grid, loudness, key and bands again, one at a time. A track
        // whose analysis is current but predates the beat tracker or the section analysis gets only those two (the
        // file is decoded again, nothing else is recomputed). Stems without a level map get one.
        for (const track of loaded) {
          if (!alive) return;
          const stale = staleness(track), unmapped = !!track.stems && !track.stemEnergy;
          // Tracks saved before content fingerprints existed get one here, once, so an import can recognise them.
          const needsFingerprint = !track.fingerprint;
          // Covers stored before they were re-encoded are shrunk to WebP once, so the library reads and decodes less.
          const heavyCover = !!track.cover && coverNeedsShrink(track.cover);
          if (!stale && !unmapped && !needsFingerprint && !heavyCover) continue;
          try {
            const result: Partial<StoredTrack> = stale === "all" ? await analyzeFile(track.blob)
              : stale === "features" ? await analyzeRhythmAndStructure(track.blob, track.bpm) : {};
            if (unmapped) result.stemEnergy = await analyzeStems(track.stems!).catch(() => undefined);
            if (needsFingerprint) result.fingerprint = await fingerprintOf(track.blob).catch(() => undefined);
            const cover = heavyCover ? await shrinkCover(track.cover!) : undefined;
            if (!alive) return;
            // Analysis can take long enough for the DJ to edit this track or delete it. Merge onto the latest version
            // so saving the results keeps those edits (and the newly computed fingerprint) instead of restoring `track`.
            const latest = tracksRef.current.find(t => t.id === track.id);
            if (!latest) continue;
            // A tempo the DJ set by hand is theirs: a new analysis does not replace it.
            if (latest.tempoManual) { delete result.bpm; delete result.pulse; delete result.firstBeat; delete result.rhythm; }
            const updated: Track = { ...latest, ...result };
            // Only when the DJ has not replaced the cover meanwhile.
            if (cover && cover !== track.cover && latest.cover === track.cover) {
              if (latest.coverUrl) URL.revokeObjectURL(latest.coverUrl);
              updated.cover = cover; updated.coverUrl = URL.createObjectURL(cover);
            }
            tracksRef.current = tracksRef.current.map(t => t.id === track.id ? updated : t);
            setTracks(prev => prev.map(t => t.id === track.id ? updated : t));
            await saveTrack(toStored(updated)).catch(() => {});
          } catch {
            // Keep the old numbers for a file the browser cannot decode offline, and remember the failure so the next start does not decode it again.
            if (alive) await markAnalysisFailed(track.id);
          }
        }
      })();
    }).catch(() => { if (alive) notify("Local library unavailable. You can keep mixing for this session.", "fail"); });
    loadMixes().then(items => { if (alive) setMixes(items.sort((a, b) => b.createdAt - a.createdAt)); }).catch(() => {});
    fetch("/api/stems").then(res => res.ok ? res.json() as Promise<{ available: boolean }> : { available: false })
      .then(res => { if (alive) setStemsAvailable(res.available); }).catch(() => { if (alive) setStemsAvailable(false); });
    fetch("/api/lyrics").then(res => res.ok ? res.json() as Promise<{ available: boolean }> : { available: false })
      .then(res => { if (alive) setLyricsAvailable(res.available); }).catch(() => { if (alive) setLyricsAvailable(false); });
    fetch("/api/mix").then(res => res.ok ? res.json() as Promise<{ available: boolean }> : { available: false })
      .then(res => { if (alive) setAiAvailable(res.available); }).catch(() => { if (alive) setAiAvailable(false); });
    const timer = window.setInterval(() => {
      const current = engine.current;
      if (!current) return;
      // The playhead goes to the positions store and the ref, which every action reads. React state takes it only
      // while a deck is paused (a seek, a cue): while one plays it would re-render the whole page ten times a second.
      DECK_IDS.forEach(id => {
        const d = decksRef.current[id]; if (!d.trackId) return;
        const media = current.getMedia(id);
        if (d.loopEnd !== null && d.loopStart !== null && media.currentTime >= d.loopEnd) current.seek(id, d.loopStart);
        const pos = media.currentTime || 0;
        positions.set(id, pos);
        decksRef.current = { ...decksRef.current, [id]: { ...decksRef.current[id], position: pos } };
      });
      setDecks(prev => {
        let changed = false;
        const next = { ...prev };
        DECK_IDS.forEach(id => {
          const d = prev[id]; if (!d.trackId) return;
          const media = current.getMedia(id);
          const dur = Number.isFinite(media.duration) ? media.duration : d.duration;
          const pos = media.currentTime || 0;
          const playing = !media.paused && !media.ended;
          if ((!playing && Math.abs(d.position - pos) > 0.06) || d.playing !== playing || Math.abs(d.duration - dur) > 0.2) {
            next[id] = { ...d, position: pos, playing, duration: dur }; changed = true;
          }
        });
        return changed ? next : prev;
      });
      armedRef.current();
      controller.tick();
    }, 100);
    return () => {
      alive = false; mounted.current = false; window.clearInterval(timer);
      controller.stop();
      if (clock.current !== null) window.clearInterval(clock.current);
      clock.current = null;
      // Read at cleanup on purpose: whatever mix or alignment is in flight when the hook unmounts must stop.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      mixToken.current++;
      // eslint-disable-next-line react-hooks/exhaustive-deps
      alignTimers.current.forEach(id => window.clearTimeout(id)); alignTimers.current.clear();
      // The AutoMix wake-up and any tempo glide are page timers, not audio automation: they must not outlive the hook.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      if (triggerTimer.current !== null) window.clearTimeout(triggerTimer.current);
      triggerTimer.current = null;
      // eslint-disable-next-line react-hooks/exhaustive-deps
      DECK_IDS.forEach(id => {
        // eslint-disable-next-line react-hooks/exhaustive-deps
        const ramp = rateRamps.current[id];
        if (ramp !== null) window.clearInterval(ramp);
        // eslint-disable-next-line react-hooks/exhaustive-deps
        rateRamps.current[id] = null;
      });
      engine.current?.destroy(); engine.current = null;
      tracksRef.current.forEach(revokeTrack);
      clearSamples();
    };
  }, [notify, updateDeck, controller, markAnalysisFailed, positions]);

  useEffect(() => {
    if (!recording) return;
    const tick = window.setInterval(() => setRecordSeconds(Math.floor((Date.now() - recordStart) / 1000)), 250);
    return () => window.clearInterval(tick);
  }, [recording, recordStart]);

  const trackA = useMemo(() => tracks.find(t => t.id === decks.A.trackId), [tracks, decks.A.trackId]);
  const trackB = useMemo(() => tracks.find(t => t.id === decks.B.trackId), [tracks, decks.B.trackId]);

  function beatsToSeconds(id: DeckId, beats: number) {
    const d = decksRef.current[id];
    const track = tracksRef.current.find(t => t.id === d.trackId);
    return track?.bpm ? beats * 60 / (track.bpm * d.rate) : beats * 0.5;
  }
  /** Puts a track on a deck, reset to its defaults and cued at `at`. It leaves the active deck alone and does not tell
      AutoMix, so AutoMix can use it for its own loads. */
  function loadInternal(id: DeckId, track: Track, at = 0): boolean {
    if (!engine.current) { notify("Audio is unavailable", "fail"); return false; }
    // A mix reads both decks' clocks; loading one of them under it would rewind or orphan it.
    if (activeMix.current && (activeMix.current.from === id || activeMix.current.to === id)) cancelMix();
    stopAligning(); failedMix.current = null;
    clearRateRamp(id); naturalRates.current[id] = 1;
    loadTokens.current[id]++;
    engine.current.load(id, track.stemsUrl ?? track.url, !!track.stemsUrl, at);
    engine.current.setVolume(id, 0.82);
    engine.current.setRate(id, 1);
    (["high", "mid", "low"] as const).forEach(band => engine.current?.setEQ(id, band, 0));
    engine.current.setEffect(id, "off", 0.45);
    engine.current.setEffectTime(id, track.bpm ? 60 / (gridBpm(track) ?? track.bpm) : null, makeDeck().fxBeats);
    const trimDb = autoTrim(track);
    engine.current.setTrim(id, trimDb);
    engine.current.setColor(id, 0);
    const hotCues = cuesRef.current[track.id] ?? makeDeck().hotCues;
    updateDeck(id, { ...makeDeck(), trackId: track.id, duration: track.duration, trim: trimDb, cue: track.firstBeat ?? 0, hotCues, position: at });
    return true;
  }
  /** A load by hand: the deck also becomes the active one, and AutoMix hears of it. */
  function loadToDeck(id: DeckId, track: Track) {
    if (!loadInternal(id, track)) return;
    setActiveDeck(id);
    controller.notifyManualLoad(id, track.id);
  }
  /** Everything a project keeps of the session: both decks as they stand, the mixer, plans, cues and auto mix. */
  function snapshot(): Session {
    return { decks: decksRef.current, cross, master, activeDeck, autoMix: controller.getSnapshot().enabled, plans: savedPlansRef.current, cues: cuesRef.current, selectedTrackId, queue: controller.queue, naturalRates: naturalRates.current, smartStyle: smartStyleRef.current };
  }
  /** Puts a saved session back: each deck reloads its track paused at its position, with every control as it was. */
  function restore(session: Session) {
    const current = engine.current;
    cancelMix(); stopAligning(); failedMix.current = null;
    clearRateRamp("A"); clearRateRamp("B");
    cuesRef.current = session.cues ?? {};
    savedPlansRef.current = session.plans ?? {};
    setSavedPlans(savedPlansRef.current);
    setSelectedTrackId(session.selectedTrackId ?? null);
    setActiveDeck(session.activeDeck ?? "A");
    const style = { ...DEFAULT_SMART_STYLE, ...session.smartStyle };
    smartStyleRef.current = style; setSmartStyleState(style);
    const next = { A: makeDeck(), B: makeDeck() };
    DECK_IDS.forEach(id => {
      const saved = { ...makeDeck(), ...session.decks?.[id], playing: false };
      naturalRates.current[id] = session.naturalRates?.[id] ?? saved.rate;
      const track = tracksRef.current.find(t => t.id === saved.trackId);
      if (!track || !current) { current?.getMedia(id).pause(); return; }
      current.load(id, track.stemsUrl ?? track.url, !!track.stemsUrl, saved.position);
      current.setRate(id, saved.rate); current.setVolume(id, saved.volume); current.setTrim(id, saved.trim); current.setColor(id, saved.color);
      (["high", "mid", "low"] as const).forEach(band => current.setEQ(id, band, saved.eq[band]));
      current.setEffect(id, saved.fx, saved.fxAmount);
      current.setEffectTime(id, track.bpm ? 60 / (track.bpm * saved.rate) : null, saved.fxBeats);
      (saved.stems ?? makeDeck().stems).forEach((on, i) => current.setStem(id, i, on));
      next[id] = saved;
    });
    DECK_IDS.forEach(id => positions.set(id, next[id].position));
    decksRef.current = next;
    trackIdsRef.current = { A: next.A.trackId, B: next.B.trackId };
    setDecks(next);
    crossfade(session.cross ?? 0);
    setMaster(session.master ?? 0.9);
    controller.setQueue(readQueue(session.queue));
    if (session.autoMix) controller.enable();
  }
  function browse(target?: DeckId) {
    pendingTarget.current = target ?? null;
    inputRef.current?.click();
  }
  /**
   * The track already in the library with the same content as `file`, if there is one. A track saved before fingerprints
   * existed is compared by size first and then hashed once, in the background, and the result is kept so the next import
   * is a string compare. Nothing is ever removed or rewritten because of a duplicate: the existing track is returned and
   * the caller decides what to do with it.
   */
  async function duplicateOf(file: File, fingerprint: string): Promise<Track | undefined> {
    for (const track of [...tracksRef.current]) {
      if (track.fingerprint === fingerprint) return track;
      if (track.fingerprint || track.blob.size !== file.size) continue;
      const known = await fingerprintOf(track.blob).catch(() => undefined);
      if (!known) continue;
      const updated: Track = { ...track, fingerprint: known };
      tracksRef.current = tracksRef.current.map(t => t.id === track.id ? updated : t);
      setTracks(prev => prev.map(t => t.id === track.id ? { ...t, fingerprint: known } : t));
      await saveTrack(toStored(updated)).catch(() => {});
      if (known === fingerprint) return updated;
    }
    return undefined;
  }
  /** Downloads one track from a link on the server (yt-dlp + ffmpeg), cut to start..end when given, and imports it like a dropped file. */
  async function importUrl(url: string, start: string, end: string): Promise<boolean> {
    // The download lives in lib/background-jobs: leaving this page does not cancel it; the file is imported when a deck page is open.
    return downloadFromLink(url, start, end);
  }
  async function importFiles(files: File[]) {
    const valid = files.filter(file => /^audio\//.test(file.type) || AUDIO_EXTENSION.test(file.name));
    if (!valid.length) { notify("Choose a supported audio file.", "fail"); return; }
    setImporting(true);
    const importToast = "import-files";
    toast.loading(valid.length === 1 ? `Importing ${valid[0].name}` : `Importing ${valid.length} files`, { id: importToast });
    const used = new Set<DeckId>();
    const nextDeck = (): DeckId | null => {
      if (pendingTarget.current && !used.has(pendingTarget.current)) return pendingTarget.current;
      return DECK_IDS.find(id => !used.has(id) && !decksRef.current[id].trackId) ?? null;
    };
    for (const file of valid) {
      if (file.size > MAX_FILE_BYTES) { notify(`${file.name} is larger than 150 MB.`, "fail"); continue; }
      let added: string | undefined;
      try {
        // The same file imported twice (a second drag, another folder, another name) is one library entry: its content
        // is the identity, not its name or when it arrived. The existing track is loaded on the target deck instead.
        const fingerprint = await fingerprintOf(file).catch(() => undefined);
        if (fingerprint && importingPrints.current.has(fingerprint)) continue;
        const existing = fingerprint ? await duplicateOf(file, fingerprint) : undefined;
        if (fingerprint && !existing) { importingPrints.current.add(fingerprint); added = fingerprint; }
        if (existing) {
          notify(`${existing.title} is already in the library.`);
          const target = nextDeck();
          if (target) { loadToDeck(target, existing); used.add(target); }
          continue;
        }
        const guess = inferName(file.name);
        const tags = await readTags(file);
        if (tags.cover) tags.cover = await shrinkCover(tags.cover);
        const meta = { title: tags.title ?? guess.title, artist: tags.artist ?? guess.artist, album: tags.album, year: tags.year, genre: tags.genre };
        let analysis: Partial<Analysis> & Pick<StoredTrack, "analysisFailed"> & { duration: number; peaks: number[]; bpm: number | null } = { duration: 0, peaks: [], bpm: null };
        try { analysis = await analyzeFile(file); } catch {
          // The browser may play a format OfflineAudioContext cannot decode: then the media element gives the duration. A
          // file it cannot play either (corrupt, truncated, not audio) throws here and is not added to the library.
          analysis = { duration: await probeDuration(file), peaks: [], bpm: null, analysisFailed: ANALYSIS_VERSION };
        }
        const stored: StoredTrack = { id: crypto.randomUUID(), ...meta, cover: tags.cover, blob: file, fileName: file.name, addedAt: Date.now(), ...analysis, fingerprint };
        const track: Track = { ...stored, url: URL.createObjectURL(file), coverUrl: tags.cover ? URL.createObjectURL(tags.cover) : undefined };
        tracksRef.current = [track, ...tracksRef.current];
        setTracks(prev => [track, ...prev]);
        try { await saveTrack(stored); } catch { notify("Local storage is full. This track is available for this session only.", "fail"); }
        const target = nextDeck();
        if (target) { loadToDeck(target, track); used.add(target); }
      } catch { notify(`Could not open ${file.name}`, "fail"); }
      finally { if (added) importingPrints.current.delete(added); }
    }
    pendingTarget.current = null;
    setImporting(false);
    toast.dismiss(importToast);
  }
  /**
   * Plays or pauses one deck by hand. A deck started on its own, with the other deck stopped and no mix running, must be
   * heard: if the crossfader sits on the other side (where the last mix left it), it moves to this deck first, and says
   * so. With the other deck playing the DJ is mixing by hand, so the crossfader is theirs and stays where it is; the deck
   * then shows that it is silent and why.
   */
  async function togglePlay(id: DeckId) {
    const current = engine.current; if (!current) return;
    const media = current.getMedia(id);
    if (!media.paused) { current.pause(id); return; }
    if (!decksRef.current[id].trackId || !media.src) { notify(`Load a track on deck ${id === "A" ? 1 : 2} first.`, "fail"); return; }
    const alone = current.getMedia(other(id)).paused && !activeMix.current;
    if (alone && crossGains(crossRef.current)[id] < 0.5) {
      crossfade(id === "A" ? -1 : 1);
      notify(`Crossfader moved to deck ${id === "A" ? 1 : 2} so you can hear it.`);
    }
    try { await current.play(id); }
    catch (e) {
      notify(media.error ? "This track could not be decoded. Try loading it again." : e instanceof Error && e.name === "NotAllowedError"
        ? "The browser blocked playback. Click play again." : "This track could not be played.", "fail");
      return;
    }
    if (alone) setActiveDeck(id);
  }
  /** Why a playing deck is not heard, or null when it is (or while a mix owns the faders). */
  function silentReason(id: DeckId, d: Record<DeckId, DeckState> = decks): string | null {
    const deck = d[id];
    // The media element, not the 10 Hz state: a mix that just ended pauses its outgoing deck a poll before the state knows.
    if (!deck.playing || transition || engine.current?.getMedia(id).paused !== false) return null;
    if (master < 0.02) return "Master volume is down";
    if (deck.volume < 0.02) return "Channel fader is down";
    if (crossGains(cross)[id] < 0.05) return `Crossfader is on deck ${id === "A" ? 2 : 1}`;
    const track = tracks.find(t => t.id === deck.trackId);
    if (track?.stems && deck.stems.every(on => !on)) return "Every stem is muted";
    return null;
  }
  /** Brings a silent deck back: whichever control was keeping it quiet goes back to where it is heard. */
  function makeHeard(id: DeckId) {
    const deck = decksRef.current[id];
    if (master < 0.02) setMaster(0.9);
    if (deck.volume < 0.02) volume(id, 0.82);
    if (crossGains(crossRef.current)[id] < 0.05) {
      // Mixing by hand: the center keeps the other deck heard too. Alone: all the way to this deck.
      const both = !engine.current?.getMedia(other(id)).paused;
      crossfade(both ? 0 : id === "A" ? -1 : 1);
    }
    if (deck.stems.every(on => !on)) stems(id, [true, true, true, true]);
  }
  function cue(id: DeckId) {
    const d = decksRef.current[id]; const current = engine.current;
    if (!current || !d.trackId) return;
    if (d.playing) { current.pause(id); current.seek(id, d.cue); }
    else if (Math.abs(d.position - d.cue) < 0.15) updateDeck(id, { cue: d.position });
    else current.seek(id, d.cue);
  }
  // Reads the media clock, not the polled deck state: a drag sends many nudges between two polls, and each must build on the last.
  function nudge(id: DeckId, seconds: number) { const e = engine.current; if (e) e.seek(id, e.getMedia(id).currentTime + seconds); }
  function skipBeats(id: DeckId, beats: number) { nudge(id, Math.sign(beats) * beatsToSeconds(id, Math.abs(beats))); }
  function seek(id: DeckId, seconds: number) { engine.current?.seek(id, seconds); }
  function pad(id: DeckId, index: number) {
    const d = decksRef.current[id]; if (!d.trackId) return;
    const cues = [...d.hotCues];
    if (cues[index] === null) { cues[index] = d.position; cuesRef.current = { ...cuesRef.current, [d.trackId]: cues }; updateDeck(id, { hotCues: cues }); }
    else engine.current?.seek(id, cues[index]!);
  }
  function clearPad(id: DeckId, index: number) {
    const d = decksRef.current[id];
    const cues = [...d.hotCues]; cues[index] = null;
    if (d.trackId) cuesRef.current = { ...cuesRef.current, [d.trackId]: cues };
    updateDeck(id, { hotCues: cues });
  }
  function loopIn(id: DeckId) {
    const d = decksRef.current[id]; if (!d.trackId) return;
    updateDeck(id, { loopStart: d.position, loopEnd: null });
  }
  function loopOut(id: DeckId) {
    const d = decksRef.current[id]; if (!d.trackId || d.loopStart === null || d.position <= d.loopStart) return;
    updateDeck(id, { loopEnd: d.position });
  }
  function beatLoop(id: DeckId, beats: number) {
    const d = decksRef.current[id]; if (!d.trackId) return;
    if (d.loopEnd !== null && d.loopBeats === beats) { updateDeck(id, { loopStart: null, loopEnd: null }); return; }
    updateDeck(id, { loopBeats: beats, loopStart: d.position, loopEnd: Math.min(d.duration, d.position + beatsToSeconds(id, beats)) });
  }
  function resizeLoop(id: DeckId, factor: 0.5 | 2) {
    setLoopBeats(id, Math.max(0.25, Math.min(32, decksRef.current[id].loopBeats * factor)));
  }
  function toggleLoop(id: DeckId) {
    const d = decksRef.current[id]; if (!d.trackId) return;
    if (d.loopEnd !== null) { updateDeck(id, { loopEnd: null, loopStart: null }); return; }
    updateDeck(id, { loopStart: d.position, loopEnd: Math.min(d.duration, d.position + beatsToSeconds(id, d.loopBeats)) });
  }
  function setLoopBeats(id: DeckId, beats: number) {
    const d = decksRef.current[id];
    const patch: Partial<DeckState> = { loopBeats: beats };
    if (d.loopStart !== null && d.loopEnd !== null) patch.loopEnd = Math.min(d.duration, d.loopStart + beatsToSeconds(id, beats));
    updateDeck(id, patch);
  }
  /** Applies a rate to a deck without making it the deck's own: a tempo match belongs to the mix, not to the DJ. */
  function applyRate(id: DeckId, n: number) { engine.current?.setRate(id, n); updateDeck(id, { rate: n }); retimeFx(id, n); }
  /** Heard seconds per beat on a deck at a rate, or null without a tempo. */
  function beatSeconds(id: DeckId, rate = decksRef.current[id].rate) {
    const track = tracksRef.current.find(t => t.id === trackIdsRef.current[id]);
    const bpm = track ? gridBpm(track) ?? track.bpm : null;
    return bpm ? 60 / (bpm * (rate || 1)) : null;
  }
  /** Keeps a deck's echo, flanger and phaser on its beat as its tempo moves. */
  function retimeFx(id: DeckId, rate?: number) { engine.current?.setEffectTime(id, beatSeconds(id, rate), decksRef.current[id].fxBeats); }
  function clearRateRamp(id: DeckId) {
    const timer = rateRamps.current[id];
    if (timer !== null) { window.clearInterval(timer); rateRamps.current[id] = null; }
  }
  /** Sets a deck's own tempo by hand (or by Sync): it is what the deck returns to after a mix, and it cancels a return. */
  function setRate(id: DeckId, n: number) {
    naturalRates.current[id] = n;
    clearRateRamp(id);
    applyRate(id, n);
  }
  /**
   * Gives a deck its own tempo back after a blend, over a few seconds, so the change is heard as a slow bend and not as a
   * step. It never touches a deck the DJ set by hand during the mix (that set the natural rate), and a new mix, a load or
   * an eject drops it.
   */
  function recoverRate(id: DeckId, seconds = 2.5) {
    const media = engine.current?.getMedia(id);
    if (!media) return;
    const target = naturalRates.current[id];
    const from = media.playbackRate || 1;
    clearRateRamp(id);
    if (Math.abs(from - target) < 0.001) {
      if (Math.abs(decksRef.current[id].rate - target) > 1e-4) applyRate(id, target);
      return;
    }
    const began = performance.now(), span = Math.max(300, seconds * 1000);
    const timer = window.setInterval(() => {
      const engineNow = engine.current;
      if (!engineNow) { clearRateRamp(id); return; }
      const k = Math.min(1, (performance.now() - began) / span);
      const eased = 1 - (1 - k) ** 3;
      const rate = from + (target - from) * eased;
      engineNow.setRate(id, rate);
      updateDeck(id, { rate });
      if (k >= 1) clearRateRamp(id);
    }, 50);
    rateRamps.current[id] = timer;
  }
  function sync(id: DeckId) {
    const other = id === "A" ? "B" : "A";
    const d = decksRef.current[id]; const o = decksRef.current[other];
    const ownTrack = tracksRef.current.find(t => t.id === d.trackId);
    const otherTrack = tracksRef.current.find(t => t.id === o.trackId);
    if (!gridBpm(ownTrack ?? ({} as Track)) || !gridBpm(otherTrack ?? ({} as Track))) { notify("Sync needs an estimated tempo on both decks.", "fail"); return; }
    setRate(id, syncRate(gridBpm(otherTrack!)! * o.rate, gridBpm(ownTrack!)!));
    if (o.playing) alignPhase(id);
  }
  const trackOn = (id: DeckId) => tracksRef.current.find(t => t.id === decksRef.current[id].trackId);
  /** Where a deck is inside its beat, 0..1, read live from the media element. scale: 2 reads the grid at double time,
      0.5 at half time, so a half-time track lines up against the other deck's beat. */
  function beatPhase(id: DeckId, scale = 1) {
    const track = trackOn(id);
    const media = engine.current?.getMedia(id);
    const gridTempo = track ? gridBpm(track) : null;
    if (!track || !gridTempo || !media) return null;
    const bpm = gridTempo * scale;
    const beats = (media.currentTime - (track.firstBeat ?? 0)) * bpm / 60;
    return { phase: beats - Math.floor(beats), beat: 60 / bpm, time: media.currentTime };
  }
  /** Seconds a deck must move to land its beats on the other deck's beats, or null without a grid. */
  function phaseError(id: DeckId) {
    const ownTrack = trackOn(id), themTrack = trackOn(other(id));
    const ownBpm = ownTrack ? gridBpm(ownTrack) : null, themBpm = themTrack ? gridBpm(themTrack) : null;
    if (!ownBpm || !themBpm) return null;
    const own = beatPhase(id, foldMultiple(themBpm, ownBpm)), them = beatPhase(other(id));
    if (!own || !them) return null;
    let diff = them.phase - own.phase;
    if (diff > 0.5) diff -= 1;
    if (diff < -0.5) diff += 1;
    return diff * own.beat;
  }
  /** Lands a deck's beats on the other deck's. A seek on a playing element restarts it a few ms late, so each seek
      aims ahead by the learned restart cost, then checks again and corrects, up to four times, until within 5 ms. */
  function alignPhase(id: DeckId, pass = 0) {
    const err = phaseError(id);
    const media = engine.current?.getMedia(id);
    if (err === null || !media || Math.abs(err) < 0.005 || pass > 3) return;
    const lead = media.paused ? 0 : seekCost.current;
    engine.current?.seek(id, media.currentTime + err + lead);
    const timer = window.setTimeout(() => {
      alignTimers.current.delete(timer);
      const left = phaseError(id);
      if (left === null) return;
      if (!media.paused) seekCost.current = Math.max(0, Math.min(0.08, seekCost.current + left * 0.8));
      alignPhase(id, pass + 1);
    }, 350);
    alignTimers.current.add(timer);
  }
  function stopAligning() { alignTimers.current.forEach(id => window.clearTimeout(id)); alignTimers.current.clear(); }
  function eq(id: DeckId, band: "high" | "mid" | "low", n: number) {
    engine.current?.setEQ(id, band, n);
    setDecks(prev => ({ ...prev, [id]: { ...prev[id], eq: { ...prev[id].eq, [band]: n } } }));
  }
  function fx(id: DeckId, effect: EffectName, amount?: number) {
    const actualAmount = amount ?? decksRef.current[id].fxAmount;
    engine.current?.setEffect(id, effect, actualAmount);
    updateDeck(id, { fx: effect, fxAmount: actualAmount });
  }
  function fxAmount(id: DeckId, amount: number) { fx(id, decksRef.current[id].fx, amount); }
  /** The effect's time in beats: the echo's delay, a quarter of a flanger or phaser sweep. */
  function fxBeats(id: DeckId, beats: number) {
    decksRef.current = { ...decksRef.current, [id]: { ...decksRef.current[id], fxBeats: beats } };
    updateDeck(id, { fxBeats: beats });
    engine.current?.setEffectTime(id, beatSeconds(id), beats);
  }
  function trim(id: DeckId, db: number) { engine.current?.setTrim(id, db); updateDeck(id, { trim: db }); }
  function color(id: DeckId, value: number) { engine.current?.setColor(id, value); updateDeck(id, { color: value }); }
  function loadSelected(id: DeckId) {
    const track = tracksRef.current.find(t => t.id === selectedTrackId) ?? tracksRef.current[0];
    if (track) loadToDeck(id, track); else notify("Add a track to your library first.", "fail");
  }
  /** Sets which stems sound on a deck, in STEMS order. */
  function stems(id: DeckId, on: boolean[]) {
    on.forEach((value, i) => engine.current?.setStem(id, i, value));
    updateDeck(id, { stems: on });
  }
  function toggleStem(id: DeckId, index: number) { stems(id, decksRef.current[id].stems.map((v, i) => i === index ? !v : v)); }
  /**
   * Sends a track to /api/stems, follows the Demucs job, and keeps the stems file with the track. A deck holding the
   * track switches to the stems at once while paused; a playing one keeps the full mix until the track loads again.
   */
  async function splitStems(trackId: string) {
    const track = tracksRef.current.find(t => t.id === trackId);
    // The job lives in lib/background-jobs, so it keeps running (and its toast keeps following it) when this page closes.
    if (!track || track.stems) return;
    await startStemJob({ id: track.id, title: track.title, blob: track.blob, fileName: track.fileName });
  }
  /** Puts a finished stems file on its track and on any paused deck holding it. Returns true when a deck is still playing it. */
  function applyStems(trackId: string, blob: Blob, stemEnergy: StoredTrack["stemEnergy"]) {
    const current = tracksRef.current.find(t => t.id === trackId);
    if (!current) return;
    const next: Track = { ...current, stems: blob, stemsUrl: URL.createObjectURL(blob), stemEnergy };
    tracksRef.current = tracksRef.current.map(t => t.id === trackId ? next : t);
    setTracks(prev => prev.map(t => t.id === trackId ? next : t));
    let waiting = false;
    DECK_IDS.forEach(id => {
      const d = decksRef.current[id];
      if (d.trackId !== trackId) return;
      const inMix = activeMix.current && (activeMix.current.from === id || activeMix.current.to === id);
      if (d.playing || inMix || !engine.current?.getMedia(id).paused) { waiting = true; return; }
      engine.current?.load(id, next.stemsUrl!, true, d.position);
      engine.current?.setRate(id, d.rate);
      updateDeck(id, { stems: [true, true, true, true] });
    });
    if (waiting) toast.update(stemToastId(trackId), "success", `Stems ready for ${current.title}. They play the next time it loads.`);
  }
  /** Sends a track to /api/lyrics and keeps the timed words with it. The vocals stem is transcribed when the track has stems. */
  async function transcribeLyrics(trackId: string, language?: string) {
    const track = tracksRef.current.find(t => t.id === trackId);
    if (!track) return;
    await startLyricsJob({ id: track.id, title: track.title, blob: track.blob, fileName: track.fileName, stems: track.stems, language });
  }
  const transcribing = useLyricsProgress();
  useEffect(() => onLyricsDone(d => {
    tracksRef.current = tracksRef.current.map(t => t.id === d.trackId ? { ...t, lyrics: d.lyrics } : t);
    setTracks(prev => prev.map(t => t.id === d.trackId ? { ...t, lyrics: d.lyrics } : t));
  }), []);
  const applyStemsRef = useRef(applyStems);
  useEffect(() => { applyStemsRef.current = applyStems; });
  const splitting = useStemProgress();
  // Results of jobs that finished while this page was open, and downloads that finished while it was not.
  useEffect(() => onStemsDone(d => applyStemsRef.current(d.trackId, d.blob, d.stemEnergy)), []);
  const importFilesRef = useRef(importFiles);
  useEffect(() => { importFilesRef.current = importFiles; });
  useEffect(() => {
    const waiting = takePendingImports();
    if (waiting.length) void importFilesRef.current(waiting);
    return onDownloaded(files => { void importFilesRef.current(files); });
  }, []);
  /** A deck's playback position, read live from its media element, for playheads that move every frame. */
  // Stable, so the playheads that read it every frame (and the memoized countdown) do not restart on each render.
  const mediaTime = useCallback((id: DeckId) => engine.current?.getMedia(id).currentTime ?? 0, []);
  function volume(id: DeckId, n: number) { engine.current?.setVolume(id, n); updateDeck(id, { volume: n }); }
  function crossfade(n: number) { engine.current?.setCrossfader(n); crossRef.current = n; setCross(n); }
  function setMaster(n: number) { engine.current?.setMaster(n); setMasterState(n); }

  /** The deck the audience hears now: the only one playing, else the crossfader's side. */
  function liveDeck(): DeckId {
    const { A, B } = decksRef.current;
    if (A.playing && !B.playing) return "A";
    if (B.playing && !A.playing) return "B";
    return crossRef.current <= 0 ? "A" : "B";
  }
  /** The deck that holds a plan's outgoing track, else the live deck. */
  function fromDeckOf(plan: TransitionPlan): DeckId {
    const { A, B } = decksRef.current;
    return A.trackId === plan.fromId ? "A" : B.trackId === plan.fromId ? "B" : liveDeck();
  }
  function cancelMix(opts: { silent?: boolean } = {}) {
    finishRef.current = null;
    // A mix stopped halfway gives everything back: the engine writes every lane it drove (faders to the crossfader's own
    // gains, bass, filters, send, vocals) back to rest, and nothing it scheduled outlives it. The DJ's knobs were never
    // moved by the mix, so they need nothing.
    const running = activeMix.current;
    if (running) {
      engine.current?.cancelMix(running.to);
      // The mix's tempo match was the mix's: the deck gets its own tempo back. Paused (the mix started it), at once;
      // still playing (the DJ had started it), on a short glide so the hand-back is not a step.
      if (running.startedTo) { clearRateRamp(running.to); applyRate(running.to, naturalRates.current[running.to]); }
      else recoverRate(running.to);
      // Only stop the incoming deck if the mix was the one that started it: one the DJ had already started keeps going.
      if (running.startedTo) engine.current?.pause(running.to);
      stopAligning();
    }
    mixToken.current++;
    activeMix.current = null;
    mixing.current = false;
    setArmed(null);
    if (clock.current !== null) window.clearInterval(clock.current);
    clock.current = null;
    setTransition(null);
    if (running && !opts.silent) controller.mixEvent("cancel");
  }
  /** The live deck, the other deck, and the plan between their tracks: the saved one, else the automatic one. */
  const live: DeckId = decks.A.playing && !decks.B.playing ? "A" : decks.B.playing && !decks.A.playing ? "B" : cross <= 0 ? "A" : "B";
  const liveTrack = tracks.find(t => t.id === decks[live].trackId);
  const nextTrack = tracks.find(t => t.id === decks[other(live)].trackId);
  /** Smart AutoMix's planner result for a pair (lib/transition-planner), cached by pair, analysis and style. The
      transition panel and AutoMix both read it, so what is shown is what plays. */
  function smartFor(from: Track, to: Track, style: SmartStyle = smartStyleRef.current): PlannerResult {
    const key = `${from.id}>${to.id}|${from.analysis ?? 0}|${from.rhythm?.version ?? 0}|${from.structure?.version ?? 0}|${to.rhythm?.version ?? 0}|${to.structure?.version ?? 0}|${from.bpm}|${to.bpm}|${from.camelot}|${to.camelot}|${from.duration}|${to.duration}|${!!from.stems}|${!!to.stems}|${!!from.stemEnergy}|${!!to.stemEnergy}|${styleKey(style)}`;
    const hit = planCache.get(key);
    if (hit) return hit;
    const made = withStyle(planTransition(from, to, styleOptions(style)), from, to, style);
    planCache.set(key, made);
    if (planCache.size > 300) planCache.delete(planCache.keys().next().value!);
    return made;
  }
  /** The planner's plan for a pair, shared by the transition panel and AutoMix so what is shown is what plays. */
  function automaticFor(from: Track, to: Track, style: SmartStyle = smartStyleRef.current): TransitionPlan {
    return smartFor(from, to, style).plan;
  }
  const smart = useMemo(() => liveTrack && nextTrack ? smartFor(liveTrack, nextTrack, smartStyle) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [liveTrack, nextTrack, smartStyle]);
  const automatic = smart?.plan ?? null;
  const plan: TransitionPlan | null = liveTrack && nextTrack ? savedPlans[`${liveTrack.id}>${nextTrack.id}`] ?? automatic : null;
  /** How the plan that will play rates: the planner's own evaluation for its plan, else the same criteria applied to a
      saved, edited or AI plan, so dragged points get a fresh score. */
  const planScore: Evaluation | null = useMemo(() => {
    if (!plan || !liveTrack || !nextTrack) return null;
    if (smart && plan === smart.plan) return smart.selected;
    return scorePlan(liveTrack, nextTrack, plan, styleOptions(smartStyle));
  }, [plan, liveTrack, nextTrack, smart, smartStyle]);
  /**
   * The set as it will play: the track heard now, the one that follows (the other deck in a running mix, AutoMix's next
   * pick, else the other deck), then the rest of the queue in play order. Each entry carries the plan that takes it into
   * the next one, the same plan AutoMix will run (a saved one, else the planner's), so the transition panel can show and
   * edit every transition of the set, not only the pair loaded on the decks.
   */
  const setList = useMemo(() => {
    const byId = new Map(tracks.map(t => [t.id, t]));
    const nowId = transition ? decks[transition.from].trackId : decks[live].trackId;
    const first = nowId ? byId.get(nowId) : undefined;
    if (!first) return [] as SetEntry[];
    const entries: SetEntry[] = [{ track: first, uid: autoState.currentUid, plan: null }];
    const nextId = transition ? decks[transition.to].trackId
      // With AutoMix on, only what it will actually mix into; off, the track waiting on the other deck.
      : autoState.enabled ? autoState.nextTrackId : decks[other(live)].trackId ?? autoState.nextTrackId;
    const next = nextId ? byId.get(nextId) : undefined;
    if (next) entries.push({ track: next, uid: autoState.nextTrackId === next.id ? autoState.nextUid : null, plan: null });
    const q = autoState.queue, at = q.items.findIndex(i => i.uid === q.currentUid);
    const order = [...q.items.slice(at + 1), ...(q.loop ? q.items.slice(0, Math.max(0, at)) : [])].filter(i => i.status !== "failed");
    const after = autoState.nextUid ? order.findIndex(i => i.uid === autoState.nextUid) : -1;
    for (const item of (after >= 0 ? order.slice(after + 1) : order).slice(0, SET_AHEAD)) {
      const track = byId.get(item.trackId);
      if (track) entries.push({ track, uid: item.uid, plan: null });
    }
    for (let i = 0; i < entries.length - 1; i++) {
      const a = entries[i].track, b = entries[i + 1].track;
      if (i === 0 && transition) { entries[i].plan = transition.plan; continue; }
      try { entries[i].plan = savedPlans[`${a.id}>${b.id}`] ?? automaticFor(a, b, smartStyle); } catch { entries[i].plan = null; }
    }
    return entries;
    // automaticFor reads the plan cache; the style and saved plans it depends on are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, decks.A.trackId, decks.B.trackId, live, transition, autoState.enabled, autoState.nextTrackId, autoState.nextUid, autoState.currentUid, autoState.queue, savedPlans, smartStyle]);
  /** Rates any plan of the set against the planner's criteria, so the panel can score a transition further down the queue. */
  // Stable: it reads only refs, so a memo keyed on it reruns when the plan changes, not on every 10 Hz render.
  const ratePlan = useCallback((next: TransitionPlan): Evaluation | null => {
    const a = tracksRef.current.find(t => t.id === next.fromId), b = tracksRef.current.find(t => t.id === next.toId);
    if (!a || !b) return null;
    try { return scorePlan(a, b, next, styleOptions(smartStyleRef.current)); } catch { return null; }
  }, []);
  function savePlan(next: TransitionPlan) {
    savedPlansRef.current = { ...savedPlansRef.current, [`${next.fromId}>${next.toId}`]: next };
    setSavedPlans(savedPlansRef.current);
    failedMix.current = null;
  }
  /** Makes a transition's shape (curves, eq, effect, stems) the one AutoMix gives every transition it plans. */
  function saveAsTemplate(next: TransitionPlan) {
    setSmartStyle({ template: shapeOfPlan(next) });
    notify("AutoMix will use this transition's shape. Clear it in the AutoMix settings.");
  }
  function resetPlan(fromId: string, toId: string) {
    const copy = { ...savedPlansRef.current };
    delete copy[`${fromId}>${toId}`];
    savedPlansRef.current = copy;
    setSavedPlans(copy);
    failedMix.current = null;
  }
  /**
   * Asks the local model, through /api/mix, for the transition between two tracks, and keeps its plan. By hand it plans
   * the live pair and says so. For AutoMix (quiet) it never replaces a plan the DJ saved meanwhile, and it drops a plan
   * that would start too soon to play as planned (the automatic one plays instead), so a slow answer cannot jolt a set.
   */
  async function aiPlanFor(from: Track, to: Track, quiet = false): Promise<boolean> {
    const key = `${from.id}>${to.id}`;
    if (planningRef.current) return false;
    const base = savedPlansRef.current[key] ?? automaticFor(from, to);
    planningRef.current = key; setPlanning(key);
    // By hand the person is waiting on the model: a toast stays until the plan is ready. AutoMix plans quietly.
    const jobToast = quiet ? undefined : `ai-plan-${key}`;
    let planSettled = false;
    if (jobToast) toast.loading(`AI is planning ${from.title} into ${to.title}`, { id: jobToast });
    try {
      const res = await fetch("/api/mix", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: mixFeatures(from), to: mixFeatures(to), auto: base }) });
      const body = await res.json() as { plan?: Omit<TransitionPlan, "fromId" | "toId" | "preset" | "by">; error?: string };
      if (!res.ok || !body.plan) throw new Error(body.error ?? "The AI plan failed");
      if (!mounted.current) return false;
      // The planner's own fields describe its plan, not the model's: the AI plan is matched as before and rated afresh.
      const next: TransitionPlan = { ...base, ...body.plan, strategy: undefined, score: undefined, confidence: undefined, sync: undefined,
        fromId: from.id, toId: to.id, preset: "custom", by: "ai" };
      next.preset = presetOf(next);
      if (quiet) {
        if (savedPlansRef.current[key]) return false;
        const deck = DECK_IDS.find(id => trackIdsRef.current[id] === from.id);
        const media = deck ? engine.current?.getMedia(deck) : null;
        const lead = AI_RUNWAY * (media?.playbackRate || 1);
        if (activeMix.current || (media && !media.paused && media.currentTime > next.outAt - lead)) return false;
      }
      savePlan(next);
      if (jobToast) { planSettled = true; toast.update(jobToast, "success", "AI transition ready. Preview it or mix now."); } else notify(`AI planned ${from.title} into ${to.title}.`);
      return true;
    } catch (e) {
      if (jobToast) { planSettled = true; toast.update(jobToast, "fail", e instanceof Error ? e.message : "The AI plan failed"); }
      return false;
    } finally {
      // Returned early (quiet drop, unmounted): never leave the loading toast behind.
      if (jobToast && !planSettled) toast.dismiss(jobToast);
      planningRef.current = null; setPlanning(null);
    }
  }
  /** The AI plan for any pair of the set, by hand; with no pair, the one between the decks. */
  async function aiPlan(pair?: { fromId: string; toId: string }) {
    const a = pair ? tracksRef.current.find(t => t.id === pair.fromId) : liveTrack;
    const b = pair ? tracksRef.current.find(t => t.id === pair.toId) : nextTrack;
    if (a && b) await aiPlanFor(a, b);
  }
  /* AutoMix with AI on: each pair it is about to play gets a plan from the local model, once, in the background. Until
     the answer comes (or if it never does), the planner's plan stands; a plan the DJ edited is never asked about. */
  const aiTried = useRef(new Set<string>());
  const autoPair = autoState.plan ? `${autoState.plan.fromId}>${autoState.plan.toId}` : null;
  useEffect(() => {
    if (!smartStyle.ai || !aiAvailable || !autoState.enabled || !autoPair || planning || transition) return;
    if (savedPlansRef.current[autoPair] || aiTried.current.has(autoPair)) return;
    const [fromId, toId] = autoPair.split(">");
    const from = tracksRef.current.find(t => t.id === fromId), to = tracksRef.current.find(t => t.id === toId);
    if (!from?.bpm || !to?.bpm) return;
    aiTried.current.add(autoPair);
    void aiPlanFor(from, to, true);
    // aiPlanFor reads refs and the latest state; the pair, the switches and what is in flight decide when it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [smartStyle.ai, aiAvailable, autoState.enabled, autoPair, planning, transition]);
  /* AutoMix with auto stems on: Demucs splits what is about to play, one track at a time (the server runs one job at a
     time anyway): the next track first, then the one playing, then the rest of the queue in order. A track whose split
     failed is not tried again this session. */
  const stemsTried = useRef(new Set<string>());
  const splittingNow = Object.keys(splitting).length > 0;
  useEffect(() => {
    if (!smartStyle.autoStems || !stemsAvailable || !autoState.enabled || splittingNow) return;
    const q = autoState.queue, at = q.items.findIndex(i => i.uid === q.currentUid);
    const order = [autoState.nextTrackId, trackIdsRef.current[live], ...q.items.slice(at + 1).map(i => i.trackId), ...(q.loop ? q.items.slice(0, Math.max(0, at)).map(i => i.trackId) : [])];
    const target = order.map(id => id && tracksRef.current.find(t => t.id === id)).find((t): t is Track => !!t && !t.stems && !stemsTried.current.has(t.id));
    if (!target) return;
    stemsTried.current.add(target.id);
    void splitStems(target.id);
    // splitStems reads refs; the queue, the next pick and the switches decide what to split next.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [smartStyle.autoStems, stemsAvailable, autoState.enabled, autoState.queue, autoState.nextTrackId, splittingNow, tracks, live]);

  /** Loads a track on a deck for AutoMix and waits until the browser can play it. A newer load of the same deck replaces it. */
  async function prepareDeck(id: DeckId, track: Track, at: number) {
    const current = engine.current;
    if (!current) throw new Error("Audio is unavailable");
    if (activeMix.current) throw new MediaLoadError("A mix is running");
    if (trackIdsRef.current[id] !== track.id) loadInternal(id, track, at);
    else if (current.getMedia(id).paused) current.seek(id, at);
    const token = loadTokens.current[id];
    // Metadata, then a short wait for enough buffered audio that the deck starts at once when its turn comes.
    await whenMediaBuffered(current.getMedia(id));
    if (token !== loadTokens.current[id] || trackIdsRef.current[id] !== track.id) throw new MediaLoadError("The load was replaced");
  }
  /** Runs the analysis again for a track and keeps the result in the library. */
  async function analyzeTrack(track: Track) {
    let result: Analysis;
    try { result = await analyzeFile(track.blob); } catch (e) { await markAnalysisFailed(track.id); throw e; }
    if (!mounted.current) return;
    const updated = tracksRef.current.map(t => t.id === track.id ? { ...t, ...result } : t);
    tracksRef.current = updated;
    setTracks(updated);
    const latest = updated.find(t => t.id === track.id);
    if (latest) await saveTrack(toStored(latest)).catch(() => {});
  }
  /** Starts a deck from its beginning and makes it the live one with no overlap, for a track that ended or broke. */
  async function cut(to: DeckId): Promise<boolean> {
    const current = engine.current; if (!current) return false;
    cancelMix({ silent: true });
    failedMix.current = null;
    setRate(to, 1); current.seek(to, 0);
    try { await current.play(to); } catch { return false; }
    current.pause(other(to));
    crossfade(to === "B" ? 1 : -1);
    setActiveDeck(to);
    return true;
  }
  /**
   * Runs a plan from the deck holding plan.fromId into the other one, in four steps.
   * 1. Preroll. The incoming deck is silenced on its own mix lane and starts playing early, by an adaptive preroll built
   *    from how long its starts have actually taken. Its tempo is set and its beats are aligned while nobody hears it,
   *    with seeks, by the drift governor.
   * 2. Schedule. The whole transition is written to the audio thread as AudioParam automation against the context
   *    clock (lib/mix-session): volume, bass swap, filters, send, vocals, the crossfader hand-off. From here no timer
   *    executes anything critical; a stalled page cannot move a fade or a bass swap.
   * 3. Watch. A 100 ms monitor (it only observes and corrects, nothing depends on its punctuality) measures beat drift
   *    between the decks and slews the incoming rate by under 1 % to hold it, re-anchors the lanes if the outgoing
   *    tempo is changed by hand or the media clock and the lanes part ways, and leaves early if sync cannot be kept.
   * 4. Complete, on the first tick after the automation has run out.
   * now: start at once (manual mix).
   */
  async function mix(plan: TransitionPlan, now = false, opts: { quiet?: boolean; from?: DeckId } = {}): Promise<boolean> {
    const current = engine.current; if (!current || mixing.current) return false;
    cancelMix();
    const token = mixToken.current;
    if (now) failedMix.current = null;
    const from = opts.from ?? fromDeckOf(plan), to = other(from);
    const fromDeck = decksRef.current[from], toDeck = decksRef.current[to];
    const fromTrack = tracksRef.current.find(t => t.id === fromDeck.trackId);
    const toTrack = tracksRef.current.find(t => t.id === toDeck.trackId);
    if (!fromTrack) { notify(`Load a track on deck ${from === "A" ? 1 : 2} first.`, "fail"); return false; }
    if (!toTrack) { notify(`Load a track on deck ${to === "A" ? 1 : 2} first.`, "fail"); return false; }
    if (fromDeck.trackId !== plan.fromId || toDeck.trackId !== plan.toId) {
      notify("The decks changed since that transition was planned. Plan it again.", "fail");
      return false;
    }
    mixing.current = true;
    setArmed(null);
    stopAligning();
    clearRateRamp(from); clearRateRamp(to);
    const fromMedia = current.getMedia(from), toMedia = current.getMedia(to);
    // The rate the media elements are actually at, not the polled deck state, which can lag a glide or a seek.
    const fromRate = fromMedia.playbackRate || fromDeck.rate;
    const toRate = toMedia.playbackRate || toDeck.rate;
    const naturalTo = naturalRates.current[to];
    const startedTo = toMedia.paused;
    activeMix.current = { from, to, startedTo };
    const dir = to === "B" ? 1 : -1;
    // Whatever the crossfader gives the outgoing deck now is where its curve starts, so nothing jumps.
    const outStart = crossGains(crossRef.current)[from];
    const outAt = now ? fromMedia.currentTime + prerollNow() * fromRate : plan.outAt;
    // Tempo match: the incoming deck's rate. Without a browser that keeps pitch under a rate change, a match past a few
    // cents would be a pitch shift, so the blend stays unmatched and short instead. A track whose beat grid moves has no
    // tempo worth stretching to, so gridBpm, not a bare bpm, decides.
    const fromBpm = gridBpm(fromTrack), toBpm = gridBpm(toTrack);
    const gridded = plan.sync !== false && fromBpm !== null && toBpm !== null;
    const matchRate = gridded ? planRatio(plan, fromTrack, toTrack, fromRate, toRate) * fromRate : toRate;
    const synced = gridded && (current.pitchLock || Math.abs(matchRate - 1) <= UNLOCKED_MAX_RATE_DEVIATION);
    if (gridded && !synced && !opts.quiet) notify("This browser cannot keep pitch when the tempo changes, so this blend is not beat-matched.");
    let run: TransitionPlan = gridded && !synced ? { ...plan, bars: Math.min(plan.bars, 4) } : plan;
    const span = spanOn(fromTrack, run.bars);
    // Unmatched, the incoming deck plays at its own tempo: a rate left over from an earlier match is given back here,
    // while the deck is still silent, so the blend never starts on a stretched track that was not matched on purpose.
    const base = { rate: synced ? matchRate : toMedia.paused ? naturalTo : toRate };
    // Media seconds the incoming deck covers per media second of the outgoing one.
    const ratio = base.rate / fromRate;

    current.prepareMix(to);
    if (synced || (toMedia.paused && Math.abs(toRate - base.rate) > 1e-4)) applyRate(to, base.rate);
    if (toMedia.paused) current.seek(to, Math.max(0, plan.inAt + (fromMedia.currentTime - outAt) * ratio));
    const started = performance.now();
    try { await current.play(to); } catch {
      // Cancelled while the play was pending: that cancel already cleaned up, and a newer mix owns the state now.
      if (token !== mixToken.current) return false;
      cancelMix({ silent: true });
      // Remember the pair: auto mix would otherwise try it again on every render and toast each time.
      failedMix.current = `${plan.fromId}>${plan.toId}`;
      if (!opts.quiet) notify("The incoming track could not be played.", "fail");
      return false;
    }
    // Cancelled (or the project changed, or the page closed) while the incoming deck was starting: do not go on.
    if (token !== mixToken.current) return false;
    if (fromMedia.paused) {
      try { await current.play(from); } catch { /* the mix still runs on the incoming deck */ }
      if (token !== mixToken.current) return false;
    }
    if (startedTo) {
      await audioMoving(toMedia);
      if (token !== mixToken.current) return false;
      latency.current.record((performance.now() - started) / 1000);
    }

    const seconds = () => performance.now() / 1000;
    const governor = new DriftGovernor({}, current.pitchLock ? undefined : UNLOCKED_MAX_TRIM);
    const readError = () => synced && fromBpm && toBpm ? phaseReading(
      { bpm: fromBpm, firstBeat: fromTrack.firstBeat ?? 0, time: fromMedia.currentTime },
      { bpm: toBpm, firstBeat: toTrack.firstBeat ?? 0, time: toMedia.currentTime, rate: toMedia.playbackRate || 1 },
    ).real : null;
    // Preroll alignment, while the incoming deck is silent: seeks are free here. It ends when the beats sit inside the
    // deadband or the preroll is used up; what error is left is slewed away once the blend is audible.
    if (synced) {
      let learnAt = 0;
      while (fromMedia.currentTime < outAt - (LOOKAHEAD + 0.05) * (fromMedia.playbackRate || 1)) {
        if (token !== mixToken.current) return false;
        const err = readError();
        const move = governor.update({ time: seconds(), error: err, audible: false, remaining: 0 });
        if (move.kind === "seek") {
          current.seek(to, toMedia.currentTime + move.by * (toMedia.playbackRate || 1) + (toMedia.paused ? 0 : seekCost.current));
          learnAt = seconds() + DEFAULT_GOVERNOR.settle + 0.1;
        } else if (governor.ready) break;
        else if (learnAt && seconds() >= learnAt && err !== null) {
          // What a seek on a playing element costs: the next reading after it says how far it fell short.
          seekCost.current = Math.max(0, Math.min(0.08, seekCost.current + err * 0.8)); learnAt = 0;
        }
        await wait(40);
      }
      if (token !== mixToken.current) return false;
    }

    // Place the start on the audio clock: the context time at which the outgoing media reaches outAt.
    current.sampleClock();
    const rateOut = fromMedia.playbackRate || fromRate;
    const start = current.contextTimeAt(seconds()) + (outAt - fromMedia.currentTime) / rateOut;
    // A vocal handover only moves stems the DJ left on; a muted stem stays muted (the lane multiplies the stem's own gain).
    // It needs the stems file on both decks right now: a deck that was loaded before its track was separated plays the
    // full mix, where the vocals lane has nothing to move.
    const handover = movesStems(run.stems) && current.stemMode(from) && current.stemMode(to);
    // A stem move that cannot run (a deck plays the full mix) still keeps two bass lines apart: on the eq instead.
    if (!handover && swapsBassStem(run.stems) && run.eq === "none") run = { ...run, eq: "bass" };
    const session = current.scheduleMix({ from, to, plan: run, start, duration: span / rateOut, outStart, handover,
      beat: fromBpm ? 60 / fromBpm / rateOut : undefined });

    let shown = -1, lastRateOut = rateOut, lastBase = base.rate, offClock = 0, fellBack = false, finishing = false;
    const complete = () => {
      if (clock.current !== null) window.clearInterval(clock.current);
      clock.current = null;
      // The outgoing deck is silent by now (its lane is at 0 and the crossfader has left it); only the decoder stops.
      current.pause(from);
      current.endMix();
      crossfade(dir);
      activeMix.current = null;
      mixing.current = false;
      setTransition(null);
      finishRef.current = null;
      setActiveDeck(to);
      controller.mixEvent("end", { from, to });
      // Tempo after the blend: AutoMix keeps the match while it goes on, has a next track and its next plan will sync to
      // this deck (so changing tempo now would only make the next blend jump); otherwise the deck gets its own tempo
      // back, slowly, as the track plays alone. A match that drifted far from the deck's own tempo is given back even
      // then, so a long set cannot stretch a track into a different key.
      const after = controller.getSnapshot();
      const next = after.nextTrackId ? tracksRef.current.find(t => t.id === after.nextTrackId) : undefined;
      const cur = tracksRef.current.find(t => t.id === toDeck.trackId);
      const going = after.phase !== "idle" && after.phase !== "error" && after.phase !== "paused";
      const stretch = Math.abs((decksRef.current[to].rate || 1) - naturalRates.current[to]);
      let keep = going && !!next && !!cur && stretch <= MAX_KEEP_STRETCH;
      if (keep && next && cur) {
        try { keep = (savedPlansRef.current[`${cur.id}>${next.id}`] ?? automaticFor(cur, next)).sync !== false; } catch { keep = false; }
      }
      if (keep) applyRate(to, decksRef.current[to].rate);
      else recoverRate(to);
    };
    /** Runs the rest of the blend out over `time` seconds. The lanes glide there from where they are. */
    const leave = (time: number) => { finishing = true; session.reanchor(time); };
    const tick = () => {
      current.sampleClock();
      // A deck that errors, or is paused by hand, stops the clock the blend follows: end the mix instead of leaving it half done.
      const broken = fromMedia.error ? fromMedia : toMedia.error ? toMedia : null;
      if (broken || (fromMedia.paused && !fromMedia.ended) || (toMedia.paused && !toMedia.ended)) {
        cancelMix({ silent: !!broken });
        if (broken) {
          // Music goes on from the deck that still works.
          const bad = broken === fromMedia ? from : to;
          current.pause(bad); crossfade(bad === "A" ? 1 : -1);
          notify("The mix stopped: a track failed while playing.", "fail");
          // The queue goes on: a broken outgoing track just ends the mix; a broken incoming one is skipped.
          if (bad === from) controller.mixEvent("end", { from, to }); else controller.deckError(to);
        }
        return;
      }
      const at = current.context.currentTime;
      if (session.isOver(at)) { complete(); return; }
      if (fromMedia.ended && !finishing) leave(FINISH_SECONDS);
      // A short incoming track can run out before the blend does: finish the fade quickly rather than hold a silent deck.
      if (toMedia.ended && !finishing) leave(FINISH_SECONDS);
      const progress = session.progressAt(at);
      if (!finishing) {
        const rateNow = fromMedia.playbackRate || rateOut;
        const media = (fromMedia.currentTime - outAt) / span;
        let rebased = false;
        if (media >= 0 && Math.abs(rateNow - lastRateOut) > 1e-4) {
          // The outgoing tempo was changed by hand: the rest of the track now takes a different time. The lanes are
          // written again for it, and a matched incoming deck follows the new tempo, so the two stay locked.
          lastRateOut = rateNow;
          session.reanchor((1 - media) * span / rateNow, media);
          if (synced) { base.rate = ratio * rateNow; lastBase = base.rate; applyRate(to, base.rate); current.setRate(to, base.rate * (1 + governor.trim)); }
          rebased = true;
        } else if (decksRef.current[to].rate !== lastBase && Math.abs(decksRef.current[to].rate - lastBase) > 1e-4) {
          // The DJ moved the incoming tempo: that is the new base, and the drift it causes is the governor's to judge.
          base.rate = lastBase = decksRef.current[to].rate;
          governor.reset(); current.setRate(to, base.rate * (1 + governor.trim));
        } else if (media >= 0 && progress > 0) {
          // The lanes follow the context clock; if the media has parted from it (a stall, a seek by hand) for two ticks
          // running, they are pulled back to where the media is.
          const apart = (media - progress) * span / rateNow;
          offClock = Math.abs(apart) > 0.04 ? offClock + 1 : 0;
          if (offClock >= 2) { offClock = 0; session.reanchor((1 - media) * span / rateNow, media); rebased = true; }
        }
        if (synced && !fellBack && !rebased) {
          const move = governor.update({ time: seconds(), error: readError(), audible: progress > 0.005, remaining: session.remaining(at) });
          if (move.kind === "trim") current.setRate(to, base.rate * (1 + move.trim));
          else if (move.kind === "seek") current.seek(to, toMedia.currentTime + move.by * (toMedia.playbackRate || 1) + seekCost.current);
          else if (move.kind === "fallback") {
            // Sync cannot be kept: stop chasing it and leave the overlap early, on the equal-power fade, rather than
            // let two beats that disagree play together.
            fellBack = true;
            current.setRate(to, base.rate);
            session.reanchor(Math.min(session.remaining(at), FALLBACK_SECONDS));
            notify(`The decks drifted apart (${move.reason}), so the blend leaves early.`);
          }
        }
      }
      // The knobs and the progress follow at a fiftieth of the range, so the page is not re-rendered on every tick.
      if (Math.abs(progress - shown) >= 0.02) { shown = progress; setTransition({ from, to, plan: { ...run, outAt }, progress }); }
    };
    setTransition({ from, to, plan: { ...run, outAt }, progress: 0 });
    // The monitor observes; the blend itself is already on the audio thread, so it also finishes in a throttled background tab.
    clock.current = window.setInterval(tick, 100);
    finishRef.current = () => { if (!finishing) leave(FINISH_SECONDS); };
    controller.mixEvent("start", { from, to });
    return true;
  }
  /** Seconds the incoming deck plays silent before a blend: what its starts and seeks have actually taken. */
  function prerollNow() { return prerollSeconds({ startLatency: latency.current.slow(), seekCost: seekCost.current }); }
  /** Plays the run-up into a plan: the outgoing deck from two bars before plan.outAt, the mix armed to start there. */
  async function preview(next: TransitionPlan) {
    const current = engine.current; if (!current) return;
    cancelMix();
    const from = fromDeckOf(next), to = other(from);
    const fromTrack = tracksRef.current.find(t => t.id === decksRef.current[from].trackId);
    if (!fromTrack || fromTrack.id !== next.fromId || decksRef.current[to].trackId !== next.toId) return;
    current.pause(to);
    current.seek(from, Math.max(0, next.outAt - 2 * spanOn(fromTrack, 1)));
    crossfade(from === "A" ? -1 : 1);
    try { await current.play(from); } catch { return; }
    setArmed(next);
  }
  useEffect(() => { mixRef.current = (next, now) => void mix(next, now); });
  useEffect(() => {
    bridge.current = {
      prepare: prepareDeck, analyze: analyzeTrack, preroll: prerollNow, cut, notify,
      planFor: (from, to) => savedPlansRef.current[`${from.id}>${to.id}`] ?? automaticFor(from, to),
      mix: (next, o) => mix(next, o.now, { quiet: true, from: o.from }),
      abort: () => { cancelMix({ silent: true }); },
    };
  });
  // The plan starts on its own at plan.outAt when auto mix is on or a preview armed it. The poll runs this check, with
  // the live playhead from the ref: the decks state does not follow a playing deck.
  useEffect(() => { armedRef.current = () => {
    const run = armed;
    if (!run || transition || mixing.current || failedMix.current === `${run.fromId}>${run.toId}`) return;
    const live = decksRef.current;
    const from: DeckId = live.A.trackId === run.fromId ? "A" : "B";
    const d = live[from], o = live[other(from)];
    if (!d.playing || o.playing || d.trackId !== run.fromId || o.trackId !== run.toId) return;
    if (d.position >= run.outAt - prerollNow() - 0.25 && d.position < run.outAt + 2) mixRef.current(run, false);
  }; });
  /**
   * AutoMix reaches "ready" a whole preroll before the out point, so one timeout wakes the controller exactly then,
   * instead of the 100 ms poll noticing up to a tenth of a second late. The blend itself is written to the audio thread
   * ahead of time (lib/mix-session), so this timeout only starts the silent preroll; the poll stays as the watchdog for
   * seeks, rate changes and manual intervention, which re-arm it. The timer is never the thing that moves a fader.
   */
  useEffect(() => {
    if (triggerTimer.current !== null) { window.clearTimeout(triggerTimer.current); triggerTimer.current = null; }
    const run = autoState.plan;
    if (autoState.phase !== "ready" || !run) return;
    const media = engine.current?.getMedia(liveDeck());
    if (!media || media.paused || media.ended) return;
    const rate = media.playbackRate || 1;
    const lead = (prerollNow() + 0.2) * rate;
    const remaining = (run.outAt - lead - media.currentTime) / rate;
    if (remaining <= 0) { controller.tick(); return; }
    // A hair late, never early: the controller compares the live media position with the same lead, so a timer that
    // lands a few milliseconds early would find the window not open yet and leave the work to the 100 ms poll.
    triggerTimer.current = window.setTimeout(() => {
      triggerTimer.current = null;
      controller.tick();
    }, Math.max(0, remaining * 1000 + 10));
    return () => {
      if (triggerTimer.current !== null) { window.clearTimeout(triggerTimer.current); triggerTimer.current = null; }
    };
    // The refs and the controller are stable; prerollNow and liveDeck read the live state, not a render's copy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoState.phase, autoState.plan, controller]);
  function matchGain(id: DeckId) {
    const track = tracksRef.current.find(t => t.id === decksRef.current[id].trackId);
    if (track) trim(id, autoTrim(track));
  }

  function toggleRecord() {
    const current = engine.current; if (!current) return;
    if (current.recording) { current.stopRecording(); setRecording(false); return; }
    try {
      const name = mixName.trim();
      current.startRecording(async (blob, mime, duration) => {
        if (!blob.size) { notify("The recording ended without audio.", "fail"); return; }
        const stamp = new Date().toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
        const item: StoredMix = { id: crypto.randomUUID(), title: name || `Shift mix · ${stamp}`, blob, format: mime, duration, createdAt: Date.now() };
        setMixes(prev => [item, ...prev]);
        try { await saveMix(item); } catch { notify("Not enough space to keep this recording. Download it now.", "fail"); }
        notify("Mix saved to recordings.");
      });
      setRecordStart(Date.now()); setRecordSeconds(0); setRecording(true);
    } catch (e) { notify(e instanceof Error ? e.message : "Recording could not start.", "fail"); }
  }
  function ejectDeck(id: DeckId) {
    if (activeMix.current && (activeMix.current.from === id || activeMix.current.to === id)) cancelMix();
    stopAligning(); failedMix.current = null;
    clearRateRamp(id); naturalRates.current[id] = 1;
    const media = engine.current?.getMedia(id);
    media?.pause(); media?.removeAttribute("src"); media?.load();
    updateDeck(id, makeDeck());
    controller.notifyEject(id);
  }
  async function deleteTrack(id: string) {
    DECK_IDS.forEach(deckId => { if (decksRef.current[deckId].trackId === id) ejectDeck(deckId); });
    dropSamples(id);
    tracksRef.current = tracksRef.current.filter(t => t.id !== id);
    // Anything that named this track goes with it: cached plans, saved transitions and its hot cues.
    for (const key of planCache.keys()) {
      const pair = key.slice(0, key.indexOf("|"));
      if (pair.split(">").includes(id)) planCache.delete(key);
    }
    const plans = Object.fromEntries(Object.entries(savedPlansRef.current).filter(([key]) => !key.split(">").includes(id)));
    savedPlansRef.current = plans;
    setSavedPlans(plans);
    const cues = { ...cuesRef.current };
    delete cues[id];
    cuesRef.current = cues;
    if (failedMix.current?.split(">").includes(id)) failedMix.current = null;
    controller.prune();
    setTracks(prev => { const removed = prev.find(t => t.id === id); if (removed) revokeTrack(removed); return prev.filter(t => t.id !== id); });
    try { await removeTrack(id); } catch {}
  }
  /** Adds tracks that came from somewhere else, such as the disk backup, to the library and this browser. */
  async function adoptTracks(items: StoredTrack[]) {
    const added: Track[] = items.map(item => ({ ...item, url: URL.createObjectURL(item.blob),
      coverUrl: item.cover ? URL.createObjectURL(item.cover) : undefined, stemsUrl: item.stems ? URL.createObjectURL(item.stems) : undefined }));
    const next = [...tracksRef.current.filter(t => !added.some(a => a.id === t.id)), ...added].sort((a, b) => b.addedAt - a.addedAt);
    tracksRef.current = next;
    setTracks(next);
    for (const item of items) await saveTrack(item).catch(() => {});
  }
  async function clearLibrary() {
    DECK_IDS.forEach(ejectDeck);
    clearSamples();
    planCache.clear();
    savedPlansRef.current = {};
    setSavedPlans({});
    cuesRef.current = {};
    failedMix.current = null;
    tracksRef.current.forEach(revokeTrack);
    tracksRef.current = [];
    controller.prune();
    setTracks([]);
    await clearTracks().catch(() => {});
  }
  /** Edits text tags and cover. `cover: null` removes the picture; omitting it keeps the current one. */
  /** `tempo`: a bpm and first beat set by hand (they become a steady grid), or "detect" to go back to the analysis. */
  async function updateTrack(id: string, patch: { title: string; artist: string; album: string; year: string; genre: string; cover?: Blob | null; tempo?: { bpm: number; firstBeat: number } | "detect" }) {
    const current = tracksRef.current.find(t => t.id === id); if (!current) return;
    const cover = patch.cover === undefined ? current.cover : patch.cover ? await shrinkCover(patch.cover) : undefined;
    const text = (v: string) => v.trim() || undefined;
    let tempo: Partial<Track> = {};
    if (patch.tempo === "detect") {
      try {
        const found = await analyzeFile(current.blob);
        tempo = { bpm: found.bpm, pulse: found.pulse, firstBeat: found.firstBeat, rhythm: found.rhythm, tempoManual: undefined };
      } catch { notify("Could not analyze this file again.", "fail"); }
    } else if (patch.tempo) {
      tempo = { bpm: patch.tempo.bpm, firstBeat: patch.tempo.firstBeat, rhythm: gridFromTempo(patch.tempo.bpm, patch.tempo.firstBeat, current.duration), tempoManual: true };
    }
    const next: Track = {
      ...current, title: patch.title.trim() || current.title, artist: patch.artist.trim() || current.artist,
      album: text(patch.album), year: text(patch.year), genre: text(patch.genre), cover, ...tempo,
      coverUrl: cover === current.cover ? current.coverUrl : cover ? URL.createObjectURL(cover) : undefined,
    };
    if (current.coverUrl && next.coverUrl !== current.coverUrl) URL.revokeObjectURL(current.coverUrl);
    tracksRef.current = tracksRef.current.map(t => t.id === id ? next : t);
    setTracks(prev => prev.map(t => t.id === id ? next : t));
    try { await saveTrack(toStored(next)); } catch { notify("Could not save the changes. They apply for this session only.", "fail"); }
  }
  /** Adds recordings that came back from the disk backup. */
  async function adoptMixes(items: StoredMix[]) {
    setMixes(prev => [...prev.filter(m => !items.some(i => i.id === m.id)), ...items].sort((a, b) => b.createdAt - a.createdAt));
    for (const item of items) await saveMix(item).catch(() => {});
  }
  async function deleteMix(id: string) { setMixes(prev => prev.filter(m => m.id !== id)); try { await removeMix(id); } catch {} }
  function exportMix(mix: StoredMix) {
    const ext = mix.format.includes("mp4") ? "m4a" : mix.format.includes("webm") ? "webm" : "audio";
    downloadFile(mix.blob, mix.title.replace(/[^a-z0-9 _-]/gi, "").trim().replace(/\s+/g, "_") + "." + ext);
  }

  const setAutoMix = (on: boolean) => { if (on) controller.enable(); else controller.stop(); };
  /** The Auto DJ: its state (phase, what comes next, the queue) and the controls on it. */
  const auto = {
    ...autoState,
    start: () => controller.start(), enable: () => controller.enable(), stop: () => controller.stop(), pause: () => controller.pause(),
    resume: () => controller.resume(), skip: () => controller.skip(), jumpTo: (uid: string) => controller.jumpTo(uid),
  };
  /** Edits to the play queue. */
  const queue = {
    add: (trackIds: string[], where: "end" | "next" | number = "end") => controller.add(trackIds, where),
    remove: (uid: string) => controller.remove(uid), clear: () => controller.clear(),
    move: (uid: string, delta: number) => controller.move(uid, delta), moveTo: (uid: string, index: number) => controller.moveTo(uid, index),
    playNext: (uid: string) => controller.playNext(uid), setLoop: (loop: boolean) => controller.setLoop(loop),
    setSmart: (smart: boolean) => controller.setSmart(smart), retryFailed: () => controller.retryFailed(),
  };

  // The knobs show the DJ's settings plus what a running transition does on its own lanes.
  const shownDecks = useMemo(() => transition ? overlayMix(decks, transition) : decks, [decks, transition]);
  const silent: Record<DeckId, string | null> = { A: silentReason("A"), B: silentReason("B") };
  return {
    tracks, mixes, decks: shownDecks, trackA, trackB, cross, master, activeDeck, recording, recordSeconds, importing, mixName, selectedTrackId, transition, mix: (next: TransitionPlan, now = false) => mix(next, now), cancelMix: () => cancelMix(), preview, plan, live, liveTrack, nextTrack, savePlan, resetPlan, saveAsTemplate, armed, smart, planScore, smartStyle, setSmartStyle, autoMix: autoState.enabled, setAutoMix, auto, queue, matchGain, alignPhase,
    setActiveDeck, setMixName, setSelectedTrackId, level, output, loadSelected, clearPad, loopIn, loopOut, beatLoop, resizeLoop, trim, color, browse, importFiles, importUrl, loadToDeck, togglePlay, cue, nudge, skipBeats, seek, pad,
    toggleLoop, setLoopBeats, setRate, sync, eq, fx, fxAmount, fxBeats, volume, crossfade, setMaster, toggleRecord, silent, makeHeard, setList, ratePlan,
    stemsAvailable, splitting, stems, toggleStem, splitStems, lyricsAvailable, transcribing, transcribeLyrics, aiAvailable, planning, aiPlan, ready, snapshot, restore, adoptTracks, adoptMixes,
    deleteTrack, updateTrack, clearLibrary, deleteMix, exportMix, mediaTime, positions,
  };
}

export type DJ = ReturnType<typeof useDJ>;
