import { staleness } from "@/lib/analyze-dsp";
import { fitPlanFrom, skipPlan, smartOrder } from "@/lib/planner";
import {
  advance, bumpAttempt, clearQueue, currentIndex, currentItem, emptyQueue, enqueue, itemOf, markFailed, moveBy, moveItem, nextItem,
  playNext, pruneTracks, removeItem, reorderUpcoming, retryFailed, syncTo,
} from "@/lib/queue";
import type { DeckId, PlayQueue, QueueItem, Track, TransitionPlan } from "@/lib/types";

/* AutoMix: the Auto DJ. It plays a queue deck after deck: while one track sounds it analyzes the next, loads it on the
   other deck, plans the transition (the scoring planner, or the plan the DJ saved for the pair), waits for the out
   point, and mixes. All of it runs as an explicit state machine with one rule for races: every change that makes
   earlier work wrong (a skip, a queue edit, a manual load, stop) bumps an epoch, and each asynchronous step checks it
   after every await, so a late answer never lands on a newer situation.

   The controller knows nothing about React or Web Audio. It talks to a host (use-dj implements it over the engine). */

export type AutoPhase = "idle" | "analyzing" | "preparing" | "ready" | "mixing" | "recovering" | "paused" | "error";

/** Which phase can follow which. A move not listed here is refused, so a stray event cannot, say, start a mix from idle. */
const EDGES: Record<AutoPhase, AutoPhase[]> = {
  idle: ["analyzing"],
  analyzing: ["preparing", "ready", "mixing", "recovering", "paused", "idle", "error"],
  preparing: ["analyzing", "ready", "mixing", "recovering", "paused", "idle", "error"],
  ready: ["analyzing", "preparing", "mixing", "recovering", "paused", "idle", "error"],
  mixing: ["analyzing", "paused", "recovering", "idle", "error"],
  recovering: ["analyzing", "preparing", "ready", "paused", "idle", "error"],
  paused: ["analyzing", "idle", "error"],
  error: ["idle", "analyzing"],
};
export const canGo = (from: AutoPhase, to: AutoPhase) => from === to || EDGES[from].includes(to);

/** Seconds the incoming deck plays silent before a transition, while its beats are aligned, when the host has learned
    nothing better (AutoMixHost.preroll). */
export const PREROLL = 0.6;
/** Failed tracks in a row before AutoMix gives up: one bad file is a track, three are something wrong with the setup. */
export const MAX_FAILURES = 3;
const WORKING: AutoPhase[] = ["analyzing", "preparing", "ready", "recovering"];
const other = (id: DeckId): DeckId => id === "A" ? "B" : "A";
/** Whether the tempo, key, loudness and bands are missing or from an older analysis (a track whose file already failed to
    decode under the current one is not tried again). The beat and section extras are filled in by the library in the background. */
const needsAnalysis = (track: Track) => staleness(track) === "all";

export type DeckView = { trackId: string | null; playing: boolean; ended: boolean; position: number; duration: number; rate: number };

/** What the controller needs from the player. Every method must be safe to call at any time. */
export interface AutoMixHost {
  track(id: string): Track | undefined;
  deck(id: DeckId): DeckView;
  /** The deck the audience hears now. */
  liveDeck(): DeckId;
  /** Loads a track on a deck (unless it already holds it) and resolves once the browser can play it; rejects if it cannot.
      A newer call for the same deck replaces an older one. `at` is where to cue it. */
  prepare(deck: DeckId, track: Track, at: number): Promise<void>;
  play(deck: DeckId): Promise<void>;
  /** Runs the analysis again for a track stored by an older one, and keeps the result. */
  analyze(track: Track): Promise<void>;
  /** Seconds the incoming deck needs to start and align before a mix, from what its starts have actually taken. Optional:
      without it the fixed PREROLL applies. */
  preroll?(): number;
  /** The plan for a pair: the one the DJ saved, else the planner's. Must be cheap: it is read on every tick. */
  planFor(from: Track, to: Track): TransitionPlan;
  /** Starts the mix; resolves false if the incoming deck could not start (the host then leaves everything as it was). It
      reports its own progress through mixEvent. */
  startMix(plan: TransitionPlan, opts: { now: boolean; from: DeckId }): Promise<boolean>;
  /** Jumps a running mix to its end. */
  finishMix(): void;
  /** Drops a running mix without a trace, as if it never started: the outgoing deck keeps playing, the incoming one stops. */
  abortMix(): void;
  /** Starts a deck at once and makes it the live one, with no overlap: for a track that ended or broke. */
  cut(to: DeckId, at: number): Promise<boolean>;
  notify(message: string, kind: "info" | "fail"): void;
}

export interface AutoSnapshot {
  phase: AutoPhase;
  /** Following the queue: any phase but idle and error. */
  enabled: boolean;
  detail: string;
  error: string | null;
  queue: PlayQueue;
  currentUid: string | null;
  nextUid: string | null;
  nextTrackId: string | null;
  nextSource: "queue" | "manual" | null;
  /** The transition to the next track (saved or planned). */
  plan: TransitionPlan | null;
  skipPending: boolean;
  /** A pause was asked for during a mix and waits for it to finish. */
  pausing: boolean;
  failures: number;
}

type Pick = { source: "queue" | "manual"; uid: string | null; trackId: string };
type Prepared = Pick & { deck: DeckId; fromTrackId: string };

export class AutoMix {
  private q: PlayQueue = emptyQueue();
  private phase: AutoPhase = "idle";
  private detail = "AutoMix is off";
  private errorText: string | null = null;
  private epoch = 0;
  private running = -1;
  private inflight = new Set<Promise<void>>();
  private prepared: Prepared | null = null;
  private pinned: { deck: DeckId; trackId: string } | null = null;
  /** The track AutoMix itself last put on a deck, so a track it left there is not mistaken for one the DJ cued. */
  private loaded: { deck: DeckId; trackId: string } | null = null;
  private lastOut: string | null = null;
  private skipRequested = false;
  private pauseAfterMix = false;
  private wantPlay = false;
  private launching = false;
  private mixDecks: { from: DeckId; to: DeckId } | null = null;
  private failures = 0;
  private analysed = new Set<string>();
  /** Tracks left on a deck that already failed to start, so the manual fallback does not retry them on every tick. */
  private skipped = new Set<string>();
  private listeners = new Set<() => void>();
  private snap: AutoSnapshot;

  constructor(private host: AutoMixHost) { this.snap = this.build(); }

  /* ── observation ─────────────────────────────────────────────────────────────────────────────────────────────── */

  getSnapshot = () => this.snap;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get state(): AutoPhase { return this.phase; }
  get queue(): PlayQueue { return this.q; }
  /** Resolves when no background step is in flight (for tests and for waiting on a load). */
  async settled() { while (this.inflight.size) await Promise.all([...this.inflight]); }

  private build(): AutoSnapshot {
    const pick = this.phase === "idle" || this.phase === "error" ? null : this.safePick();
    let plan: TransitionPlan | null = null;
    if (pick) {
      const live = this.host.deck(this.host.liveDeck()).trackId;
      const from = live ? this.host.track(live) : undefined, to = this.host.track(pick.trackId);
      if (from && to) { try { plan = this.host.planFor(from, to); } catch { plan = null; } }
    }
    return {
      phase: this.phase, enabled: this.phase !== "idle" && this.phase !== "error", detail: this.detail, error: this.errorText,
      queue: this.q, currentUid: this.q.currentUid, nextUid: pick?.uid ?? null, nextTrackId: pick?.trackId ?? null, nextSource: pick?.source ?? null,
      plan, skipPending: this.skipRequested, pausing: this.pauseAfterMix, failures: this.failures,
    };
  }
  private emit() {
    this.snap = this.build();
    this.listeners.forEach(l => l());
  }
  private safePick() { try { return this.pick(); } catch { return null; } }

  /** Moves the machine, refusing a move the table does not allow. Returns whether it moved. */
  private go(next: AutoPhase, detail?: string): boolean {
    if (!canGo(this.phase, next)) return false;
    this.phase = next;
    if (detail !== undefined) this.detail = detail;
    if (next !== "error") this.errorText = null;
    this.emit();
    return true;
  }
  private say(detail: string) { if (detail !== this.detail) { this.detail = detail; this.emit(); } }
  private title(trackId: string) { return this.host.track(trackId)?.title ?? "the next track"; }

  /* ── control ─────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** Follows the queue from whatever is on the decks, without starting playback. */
  enable(): boolean {
    if (this.phase === "paused") { this.resume(); return true; }
    if (this.phase !== "idle" && this.phase !== "error") return false;
    this.q = retryFailed(this.q);
    this.failures = 0; this.lastOut = null; this.skipped.clear();
    // A track already cued on the other deck is the DJ's pick, as if it had been loaded by hand with AutoMix running:
    // it plays next, ahead of what the queue would choose.
    const live = this.host.liveDeck(), idle = this.host.deck(other(live)).trackId;
    const mine = this.loaded?.deck === other(live) && this.loaded.trackId === idle;
    this.pinned = idle && idle !== this.host.deck(live).trackId && !mine ? { deck: other(live), trackId: idle } : null;
    this.epoch++;
    if (this.phase === "error") this.phase = "idle";
    this.go("analyzing", "Looking for the next track");
    this.kick();
    return true;
  }
  /** Follows the queue and plays it: the track on the live deck, else the first one in the queue. */
  start(): boolean {
    if (this.phase === "paused") { this.resume(); return true; }
    const was = this.phase;
    if (was !== "idle" && was !== "error") return false;
    this.wantPlay = true;
    return this.enable();
  }
  /** Turns AutoMix off now. A mix already running finishes by itself, so the audio never breaks. */
  stop() {
    this.epoch++;
    this.prepared = null; this.pinned = null; this.skipRequested = false; this.pauseAfterMix = false; this.wantPlay = false;
    this.failures = 0; this.errorText = null; this.skipped.clear();
    if (this.phase !== "idle") { this.phase = "idle"; }
    this.detail = "AutoMix is off";
    this.emit();
  }
  /** Holds new transitions. During a mix it waits for the mix to end, so the audio never breaks. */
  pause() {
    if (this.phase === "idle" || this.phase === "error" || this.phase === "paused") return;
    if (this.phase === "mixing") { this.pauseAfterMix = true; this.say("Pausing after this mix"); this.emit(); return; }
    this.epoch++;
    this.skipRequested = false; this.wantPlay = false;
    this.go("paused", "Paused. The decks are yours");
  }
  resume() {
    if (this.phase !== "paused") { if (this.pauseAfterMix) { this.pauseAfterMix = false; this.emit(); } return; }
    this.epoch++;
    this.go("analyzing", "Looking for the next track");
    this.kick();
  }
  /** Mixes into the next track now, with a quick blend. During a mix it finishes that mix instead. Returns whether it acted. */
  skip(): boolean {
    if (this.phase === "idle" || this.phase === "error") return false;
    if (this.phase === "mixing") { this.host.finishMix(); return true; }
    if (!this.safePick()) { this.host.notify("There is no next track in the queue.", "info"); return false; }
    if (this.phase === "paused") this.resume();
    this.skipRequested = true;
    this.emit();
    if (this.phase === "ready") this.tick();
    return true;
  }
  /** Makes a queued track the next one and mixes into it now. */
  jumpTo(uid: string): boolean {
    if (!itemOf(this.q, uid)) return false;
    this.commit(playNext(this.manual(this.q), uid));
    return this.skip();
  }

  /* ── the queue ───────────────────────────────────────────────────────────────────────────────────────────────── */

  /** Puts a saved queue in (restoring a project), dropping entries whose track no longer exists. Stops AutoMix. */
  setQueue(queue: PlayQueue) {
    this.stop();
    this.q = pruneTracks(queue, id => !!this.host.track(id));
    this.emit();
  }
  add(trackIds: string[], where: "end" | "next" | number = "end"): QueueItem[] {
    const known = trackIds.filter(id => !!this.host.track(id));
    const { queue, added } = enqueue(this.q, known, where);
    this.commit(queue);
    return added;
  }
  remove(uid: string) { this.commit(removeItem(this.q, uid)); }
  clear() { this.commit(clearQueue(this.q)); }
  /** Manual order wins over Smart ordering: moving an entry by hand turns it off. */
  move(uid: string, delta: number) { this.commit(moveBy(this.manual(this.q), uid, delta)); }
  moveTo(uid: string, index: number) { this.commit(moveItem(this.manual(this.q), uid, index)); }
  playNext(uid: string) { this.commit(playNext(this.manual(this.q), uid)); }
  setLoop(loop: boolean) { this.commit({ ...this.q, loop }); }
  setSmart(smart: boolean) { this.commit({ ...this.q, smart }); }
  retryFailed() { this.commit(retryFailed(this.q)); }
  /** Drops entries for tracks deleted from the library. */
  prune() { this.commit(pruneTracks(this.q, id => !!this.host.track(id))); }

  private manual(q: PlayQueue): PlayQueue {
    if (!q.smart) return q;
    this.host.notify("Smart ordering is off: you set the order by hand.", "info");
    return { ...q, smart: false };
  }
  /** The entries after the current one, in the order that mixes best from the track playing now. */
  private sorted(q: PlayQueue): PlayQueue {
    const at = currentIndex(q), tail = q.items.slice(at + 1);
    if (tail.length < 2) return q;
    const live = this.host.deck(this.host.liveDeck()).trackId;
    const anchorId = at >= 0 ? q.items[at].trackId : live;
    const anchor = anchorId ? this.host.track(anchorId) : undefined;
    const order = smartOrder(tail, i => this.host.track(i.trackId), anchor).map(i => i.uid);
    return reorderUpcoming(q, order);
  }
  private commit(next: PlayQueue) {
    const q = next.smart ? this.sorted(next) : next;
    if (q === this.q) { this.emit(); return; }
    const before = nextItem(this.q)?.uid, after = nextItem(q)?.uid;
    this.q = q;
    // The entry that plays next changed: what was loaded, or is loading, for the old one is wrong now.
    if (this.phase !== "mixing" && WORKING.includes(this.phase) && before !== after) { this.invalidate(); return; }
    this.emit();
    if (WORKING.includes(this.phase) && !this.prepared) this.kick();
  }

  /* ── what the player tells it ────────────────────────────────────────────────────────────────────────────────── */

  /** The DJ loaded a track on a deck by hand. On the live deck that changes what is playing; on the other it picks the next track. */
  notifyManualLoad(deck: DeckId, trackId: string) {
    if (this.phase === "idle" || this.phase === "error" || this.phase === "mixing") return;
    // Loading it by hand is a fresh start for a track that failed before.
    this.skipped.delete(trackId);
    if (this.loaded?.deck === deck) this.loaded = null;
    if (deck === this.host.liveDeck()) { this.pinned = null; this.lastOut = null; }
    else this.pinned = { deck, trackId };
    this.invalidate();
  }
  /** The DJ emptied a deck. */
  notifyEject(deck: DeckId) {
    if (this.pinned?.deck === deck) this.pinned = null;
    if (this.phase === "idle" || this.phase === "error" || this.phase === "mixing") return;
    this.invalidate();
  }
  /** A mix started, ended or was stopped, whoever started it: AutoMix itself, the Mix now button, a shortcut. */
  mixEvent(kind: "start" | "end" | "cancel", decks?: { from: DeckId; to: DeckId }) {
    if (kind === "start") {
      this.mixDecks = decks ?? null;
      if (WORKING.includes(this.phase)) { this.epoch++; this.go("mixing", `Mixing into ${this.nextTitle()}`); }
      return;
    }
    if (kind === "cancel") {
      this.mixDecks = null; this.launching = false;
      if (this.phase !== "mixing") return;
      this.epoch++; this.prepared = null; this.skipRequested = false; this.pauseAfterMix = false;
      this.go("paused", "The mix was stopped. AutoMix is paused");
      return;
    }
    // end
    const toId = decks ? this.host.deck(decks.to).trackId : null, fromId = decks ? this.host.deck(decks.from).trackId : null;
    this.mixDecks = null; this.launching = false;
    if (fromId) this.lastOut = fromId;
    const done = this.prepared && this.prepared.trackId === toId ? this.prepared : null;
    this.q = done?.uid ? advance(this.q, done.uid) : syncTo(this.q, toId);
    if (this.q.smart) this.q = this.sorted(this.q);
    this.prepared = null; this.pinned = null; this.failures = 0;
    this.skipped.clear();
    this.epoch++;
    if (this.phase === "mixing" || WORKING.includes(this.phase)) {
      if (this.pauseAfterMix) { this.pauseAfterMix = false; this.go("paused", "Paused. The decks are yours"); }
      else { this.go("analyzing", "Looking for the next track"); this.kick(); }
    } else this.emit();
  }
  /** The media element of a deck failed while it was loaded or playing. */
  deckError(deck: DeckId) {
    if (this.phase === "idle" || this.phase === "error" || this.phase === "paused") return;
    if (this.phase === "mixing") {
      if (this.mixDecks?.to === deck) {
        const p = this.prepared;
        this.host.abortMix(); this.mixDecks = null; this.launching = false;
        this.epoch++;
        if (p) this.recover(p, new Error("It stopped playing while mixing in")); else this.go("analyzing");
      } else if (this.mixDecks?.from === deck) this.host.finishMix();
      return;
    }
    const live = this.host.liveDeck();
    if (deck === live) {
      // The track that was playing broke: leave it for the next one as soon as that is ready.
      const item = currentItem(this.q);
      if (item) { this.q = markFailed(this.q, item.uid, "It stopped playing"); this.host.notify(`${this.title(item.trackId)} stopped playing. Moving on.`, "fail"); }
      this.skipRequested = true;
      this.emit();
      return;
    }
    if (this.prepared?.deck === deck) { const p = this.prepared; this.epoch++; this.recover(p, new Error("It stopped loading")); }
  }

  /* ── clock ───────────────────────────────────────────────────────────────────────────────────────────────────── */

  /** Called about ten times a second: starts the mix when the out point comes, and notices a track that ended. */
  /** The plan for the next pair changed outside AutoMix (an edit, an AI plan, a new style): publish it again, so the
      panel and the wake-up timer read the plan that will play. */
  replan() { this.emit(); }
  tick() {
    if (!WORKING.includes(this.phase) || this.launching) return;
    const live = this.host.liveDeck(), cur = this.host.deck(live), cd = this.host.deck(other(live));
    if (cur.playing && cd.playing) return; // both decks are being played by hand
    if (this.phase === "ready") { this.tickReady(live, cur); return; }
    if (cur.trackId && cur.ended) {
      if (!this.safePick()) this.finish();
      else if (!this.skipRequested) { this.skipRequested = true; this.emit(); }
    } else if (this.running !== this.epoch && this.phase === "analyzing" && this.safePick()) this.kick();
  }
  private tickReady(live: DeckId, cur: DeckView) {
    const p = this.prepared;
    if (!p) { this.invalidate(); return; }
    const fromTrack = cur.trackId ? this.host.track(cur.trackId) : undefined, toTrack = this.host.track(p.trackId);
    // The decks must still hold what was prepared; a hand on a deck since then ends it.
    if (!fromTrack || !toTrack || p.deck === live || cur.trackId !== p.fromTrackId || this.host.deck(p.deck).trackId !== p.trackId) { this.invalidate(); return; }
    const plan = this.host.planFor(fromTrack, toTrack);
    if (this.skipRequested) {
      this.skipRequested = false;
      if (!cur.playing) this.track(this.cutTo(p));
      else this.track(this.launch(p, skipPlan(plan, fromTrack, cur.position), true));
      return;
    }
    if (cur.ended) { this.track(this.cutTo(p)); return; }
    if (!cur.playing) return;
    // The trigger leads the out point by the preroll the host has learned, in media seconds at the deck's rate.
    const lead = ((this.host.preroll?.() ?? PREROLL) + 0.2) * (cur.rate || 1);
    if (cur.position >= plan.outAt - lead) {
      // Past the window (the DJ seeked): mix from here with a blend that fits what is left.
      const late = cur.position > plan.outAt + 2;
      this.track(this.launch(p, late ? fitPlanFrom(plan, fromTrack, cur.position).plan : plan, late));
    }
  }
  private finish() {
    this.epoch++;
    this.prepared = null; this.skipRequested = false;
    this.go("idle", "The queue is finished");
  }

  /* ── the pipeline ────────────────────────────────────────────────────────────────────────────────────────────── */

  /** Makes everything computed so far wrong: bumps the epoch and works out the next step again. */
  private invalidate() {
    this.epoch++;
    if (this.phase !== "mixing") {
      this.prepared = null;
      if (this.phase === "ready" || this.phase === "preparing") this.go("analyzing", "Looking for the next track");
      else this.emit();
      if (WORKING.includes(this.phase)) this.kick();
    }
  }
  private kick() {
    if (this.running === this.epoch) return;
    const epoch = this.epoch;
    this.running = epoch;
    const run: Promise<void> = this.work(epoch).catch((e: unknown) => {
      if (epoch !== this.epoch) return;
      this.errorText = e instanceof Error ? e.message : "AutoMix failed";
      this.go("error", this.errorText);
    }).finally(() => { this.inflight.delete(run); if (this.running === epoch) this.running = -1; });
    this.inflight.add(run);
  }
  private stale(epoch: number) { return epoch !== this.epoch; }
  /** Counts a background step (a mix start, a cut) as in flight, so settled() waits for it. */
  private track(step: Promise<void>) {
    const done: Promise<void> = step.catch(() => {}).finally(() => { this.inflight.delete(done); });
    this.inflight.add(done);
  }

  /** The track to play after the current one: a track loaded by hand beats the queue; with the queue empty, a track left
      on the other deck that was not just played. */
  private pick(): Pick | null {
    const live = this.host.liveDeck(), od = this.host.deck(other(live)), cur = this.host.deck(live);
    if (this.pinned) {
      // Where the pick is also the queue's own next entry, it is that entry, so the queue moves on and does not repeat it.
      if (od.trackId === this.pinned.trackId && this.pinned.deck === other(live)) {
        const queued = nextItem(this.q);
        return queued?.trackId === this.pinned.trackId ? { source: "queue", uid: queued.uid, trackId: queued.trackId } : { source: "manual", uid: null, trackId: this.pinned.trackId };
      }
      this.pinned = null;
    }
    const item = nextItem(this.q);
    if (item) return { source: "queue", uid: item.uid, trackId: item.trackId };
    if (od.trackId && od.trackId !== this.lastOut && od.trackId !== cur.trackId && !this.skipped.has(od.trackId)) return { source: "manual", uid: null, trackId: od.trackId };
    return null;
  }

  private async work(epoch: number): Promise<void> {
    if (!WORKING.includes(this.phase) || this.stale(epoch)) return;
    const live = this.host.liveDeck();

    if (this.wantPlay) {
      this.wantPlay = false;
      const cur = this.host.deck(live);
      if (!cur.trackId) {
        const first = nextItem(this.q);
        if (!first) { this.say("Add tracks to the queue"); return; }
        const track = this.host.track(first.trackId);
        if (!track) { this.q = removeItem(this.q, first.uid); this.wantPlay = true; this.epoch++; this.kick(); return; }
        this.go("preparing", `Loading ${track.title}`);
        try { await this.host.prepare(live, track, 0); } catch (e) { if (!this.stale(epoch)) this.recover({ source: "queue", uid: first.uid, trackId: first.trackId }, e); return; }
        if (this.stale(epoch)) return;
        this.q = advance(this.q, first.uid);
      }
      if (!this.host.deck(live).playing) {
        try { await this.host.play(live); } catch { if (!this.stale(epoch)) { this.errorText = "The browser blocked playback. Press play on a deck, then start AutoMix."; this.go("error", this.errorText); } return; }
        if (this.stale(epoch)) return;
      }
    }

    const cur = this.host.deck(live), od = this.host.deck(other(live));
    if (cur.playing && od.playing) { this.say("Both decks are playing. AutoMix waits until one stops"); return; }
    const curTrack = cur.trackId ? this.host.track(cur.trackId) : undefined;
    if (!curTrack) { if (this.phase !== "recovering") this.go("analyzing", "Load a track on a deck, or start the queue"); return; }
    this.q = syncTo(this.q, curTrack.id);
    if (this.q.smart) this.q = this.sorted(this.q);

    const pick = this.pick();
    if (!pick) {
      this.prepared = null;
      if (this.phase !== "analyzing") this.go("analyzing");
      this.say(this.q.items.length > 1 || this.q.loop ? "Last track in the queue" : "Add tracks to the queue to keep going");
      return;
    }
    let next = this.host.track(pick.trackId);
    if (!next) {
      if (pick.uid) this.q = removeItem(this.q, pick.uid); else this.pinned = null;
      this.epoch++; this.kick(); return;
    }
    const nextDeck = other(live);
    const p = this.prepared;
    if (p && p.trackId === next.id && p.uid === pick.uid && p.deck === nextDeck && p.fromTrackId === curTrack.id && od.trackId === next.id) {
      this.go("ready", `Ready: ${next.title}`);
      return;
    }

    if (this.phase !== "recovering") this.go("analyzing", `Analyzing ${next.title}`);
    if (needsAnalysis(next) && !this.analysed.has(next.id)) {
      this.analysed.add(next.id);
      try { await this.host.analyze(next); } catch { /* A file that will not decode offline may still play: it mixes without a tempo. */ }
      if (this.stale(epoch)) return;
      next = this.host.track(next.id) ?? next;
    }

    this.go("preparing", `Loading ${next.title}`);
    const plan = this.host.planFor(curTrack, next);
    this.loaded = { deck: nextDeck, trackId: next.id };
    try { await this.host.prepare(nextDeck, next, Math.max(0, plan.inAt - 2)); } catch (e) { if (!this.stale(epoch)) this.recover(pick, e); return; }
    if (this.stale(epoch)) return;
    this.prepared = { ...pick, deck: nextDeck, fromTrackId: curTrack.id };
    this.go("ready", `Ready: ${next.title}`);
  }

  /** The next track could not be loaded or started: mark it, tell the DJ, and carry on with the one after it. The deck
      that is playing is never touched. */
  private recover(pick: Pick, error: unknown) {
    const message = error instanceof Error ? error.message : "It could not be played";
    const retryable = error instanceof Error && error.name === "TimeoutError";
    this.prepared = null;
    this.epoch++;
    this.go("recovering", `Recovering: ${this.title(pick.trackId)} was skipped`);
    if (pick.uid) {
      const item = itemOf(this.q, pick.uid);
      if (retryable && (item?.attempts ?? 0) < 1) this.q = bumpAttempt(this.q, pick.uid);
      else { this.q = markFailed(this.q, pick.uid, message); this.failures++; this.host.notify(`${this.title(pick.trackId)} was skipped: ${message}.`, "fail"); }
    } else { this.pinned = null; this.failures++; this.skipped.add(pick.trackId); this.host.notify(`${this.title(pick.trackId)} was skipped: ${message}.`, "fail"); }
    if (this.failures >= MAX_FAILURES) {
      this.errorText = `${this.failures} tracks in a row could not be played. Check the files, then start AutoMix again.`;
      this.go("error", this.errorText);
      return;
    }
    this.emit();
    this.kick();
  }

  private nextTitle() { return this.prepared ? this.title(this.prepared.trackId) : "the next track"; }

  private async launch(p: Prepared, plan: TransitionPlan, now: boolean) {
    if (this.launching || this.phase !== "ready") return;
    this.launching = true;
    const epoch = ++this.epoch;
    this.go("mixing", `Mixing into ${this.title(p.trackId)}`);
    const settledPhase = () => this.phase as AutoPhase;
    let ok = false;
    try { ok = await this.host.startMix(plan, { now, from: other(p.deck) }); } catch { ok = false; }
    if (!ok) {
      this.launching = false;
      if (!this.stale(epoch) && settledPhase() === "mixing") this.recover(p, new Error("The incoming deck could not start"));
    }
  }
  /** No overlap: the old track ended, broke, or is not playing, so the next one just starts. */
  private async cutTo(p: Prepared) {
    if (this.launching || this.phase !== "ready") return;
    this.launching = true;
    const epoch = ++this.epoch;
    const from = other(p.deck);
    this.go("mixing", `Starting ${this.title(p.trackId)}`);
    let ok = false;
    try { ok = await this.host.cut(p.deck, 0); } catch { ok = false; }
    this.launching = false;
    if (this.stale(epoch) || (this.phase as AutoPhase) !== "mixing") return;
    if (!ok) { this.recover(p, new Error("The incoming deck could not start")); return; }
    this.mixEvent("end", { from, to: p.deck });
  }
}
