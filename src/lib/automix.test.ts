import { describe, expect, it } from "vitest";
import { ANALYSIS_VERSION } from "@/lib/analyze-dsp";
import { AutoMix, PREROLL, canGo, type AutoMixHost, type AutoPhase, type DeckView } from "@/lib/automix";
import { track } from "@/lib/test-tracks";
import { autoPlan } from "@/lib/transition";
import { emptyQueue, enqueue } from "@/lib/queue";
import type { DeckId, PlayQueue, Track, TransitionPlan } from "@/lib/types";

const other = (id: DeckId): DeckId => id === "A" ? "B" : "A";

/** A player with no audio: two decks whose clocks the test moves, a library, and a log of everything asked of it. */
class FakeHost implements AutoMixHost {
  library = new Map<string, Track>();
  decks: Record<DeckId, DeckView> = { A: blank(), B: blank() };
  live: DeckId = "A";
  loads: { deck: DeckId; trackId: string }[] = [];
  verified: { deck: DeckId; trackId: string }[] = [];
  mixes: { plan: TransitionPlan; now: boolean; from: DeckId }[] = [];
  cuts: DeckId[] = [];
  played: DeckId[] = [];
  analyzed: string[] = [];
  notices: { message: string; kind: string }[] = [];
  finished = 0;
  aborted = 0;
  startOk = true;
  /** Tracks whose load fails, with how many times (Infinity: always). */
  failing = new Map<string, { times: number; name?: string }>();
  gates = new Map<string, () => void>();
  gated = new Set<string>();
  analyzeFails = false;
  ctl!: AutoMix;

  add(id: string, patch: Partial<Track> = {}) {
    const t = track({ title: id, bpm: 128, analysis: ANALYSIS_VERSION, camelot: "8A", key: "A minor", ...patch });
    this.library.set(id, t);
    return t;
  }
  track = (id: string) => this.library.get(id);
  deck = (id: DeckId) => ({ ...this.decks[id] });
  liveDeck = () => this.live;
  planFor = (from: Track, to: Track) => autoPlan(from, to);
  notify = (message: string, kind: "info" | "fail") => { this.notices.push({ message, kind }); };

  async prepare(deck: DeckId, t: Track) {
    if (this.decks[deck].trackId !== t.id) {
      this.loads.push({ deck, trackId: t.id });
      this.decks[deck] = { ...blank(), trackId: t.id, duration: t.duration };
    } else this.verified.push({ deck, trackId: t.id });
    if (this.gated.has(t.id)) await new Promise<void>(resolve => { this.gates.set(t.id, resolve); });
    const fail = this.failing.get(t.id);
    if (fail && fail.times > 0) {
      fail.times--;
      const error = new Error("The browser could not decode this file");
      if (fail.name) error.name = fail.name;
      throw error;
    }
  }
  async play(deck: DeckId) { this.played.push(deck); this.decks[deck].playing = true; this.decks[deck].ended = false; }
  async analyze(t: Track) {
    this.analyzed.push(t.id);
    if (this.analyzeFails) throw new Error("decode");
    this.library.set(t.id, { ...t, analysis: ANALYSIS_VERSION });
  }
  async startMix(plan: TransitionPlan, opts: { now: boolean; from: DeckId }) {
    if (!this.startOk) return false;
    this.mixes.push({ plan, now: opts.now, from: opts.from });
    const to = other(opts.from);
    this.decks[to] = { ...this.decks[to], playing: true, ended: false, position: plan.inAt };
    this.ctl.mixEvent("start", { from: opts.from, to });
    return true;
  }
  finishMix() { this.finished++; this.completeMix(); }
  abortMix() { this.aborted++; this.decks[other(this.live)].playing = false; }
  async cut(to: DeckId) {
    this.cuts.push(to);
    this.decks[other(to)].playing = false;
    this.decks[to] = { ...this.decks[to], playing: true, ended: false, position: 0 };
    this.live = to;
    return true;
  }
  release(trackId: string) { this.gated.delete(trackId); this.gates.get(trackId)?.(); this.gates.delete(trackId); }

  /** What the player does when a mix runs its course: the old deck stops, the new one is the live one. */
  completeMix() {
    const last = this.mixes.at(-1)!;
    const from = last.from, to = other(from);
    this.decks[from] = { ...this.decks[from], playing: false };
    this.live = to;
    this.ctl.mixEvent("end", { from, to });
  }
}
function blank(): DeckView { return { trackId: null, playing: false, ended: false, position: 0, duration: 240, rate: 1 }; }

/** A host with tracks a..e, the first one playing on deck A from `position`, and a controller on a queue of `queued`. */
function setup(queued = "abc", opts: { position?: number; patch?: (id: string) => Partial<Track>; queue?: Partial<PlayQueue> } = {}) {
  const host = new FakeHost();
  for (const id of "abcdefg") host.add(id, opts.patch?.(id));
  const ctl = new AutoMix(host);
  host.ctl = ctl;
  const first = queued[0];
  host.decks.A = { ...blank(), trackId: first, playing: true, position: opts.position ?? 10, duration: 240 };
  const { queue } = enqueue(emptyQueue(), queued.split(""));
  ctl.setQueue({ ...queue, ...opts.queue });
  return { host, ctl };
}
/** Moves every playing deck forward and lets the controller look. */
function advance(host: FakeHost, seconds: number, ctl: AutoMix) {
  for (const id of ["A", "B"] as const) if (host.decks[id].playing) host.decks[id].position += seconds;
  ctl.tick();
}
const planOf = (host: FakeHost, from: string, to: string) => host.planFor(host.library.get(from)!, host.library.get(to)!);
/** Plays deck A up to the moment the mix into the next track is due. */
function runUpToOutPoint(host: FakeHost, ctl: AutoMix, from: string, to: string) {
  const plan = planOf(host, from, to);
  host.decks[host.live].position = plan.outAt - PREROLL - 0.1;
  return plan;
}
const titlesOf = (ctl: AutoMix) => ctl.queue.items.map(i => i.trackId);
const phase = (ctl: AutoMix) => ctl.state;

describe("the state machine", () => {
  const phases: AutoPhase[] = ["idle", "analyzing", "preparing", "ready", "mixing", "recovering", "paused", "error"];

  it("never starts a mix from idle, and always lets a stop through", () => {
    expect(canGo("idle", "mixing")).toBe(false);
    expect(canGo("idle", "ready")).toBe(false);
    for (const from of phases) expect(canGo(from, "idle")).toBe(true);
  });

  it("reaches mixing only through a prepared next track", () => {
    for (const from of phases) expect(canGo(from, "mixing")).toBe(["analyzing", "preparing", "ready"].includes(from) || from === "mixing");
  });

  it("starts off, ignores a mix that nobody asked for, and refuses a skip", () => {
    const { host, ctl } = setup();
    expect(phase(ctl)).toBe("idle");
    expect(ctl.getSnapshot().enabled).toBe(false);
    ctl.mixEvent("start", { from: "A", to: "B" });
    expect(phase(ctl)).toBe("idle");
    expect(ctl.skip()).toBe(false);
    expect(host.loads).toEqual([]);
  });

  it("walks idle, analyzing, preparing, ready on its way to the first mix", async () => {
    const { host, ctl } = setup();
    const seen: AutoPhase[] = [];
    ctl.subscribe(() => { if (seen.at(-1) !== phase(ctl)) seen.push(phase(ctl)); });
    ctl.enable();
    await ctl.settled();
    expect(seen).toEqual(["analyzing", "preparing", "ready"]);
    expect(ctl.getSnapshot().enabled).toBe(true);
    expect(host.decks.B.trackId).toBe("b");
  });
});

describe("preparing the next track", () => {
  it("loads it on the idle deck while the current one plays, and only once", async () => {
    const { host, ctl } = setup();
    ctl.enable();
    await ctl.settled();
    expect(phase(ctl)).toBe("ready");
    expect(host.loads).toEqual([{ deck: "B", trackId: "b" }]);
    for (let i = 0; i < 20; i++) advance(host, 0.5, ctl);
    await ctl.settled();
    expect(host.loads).toHaveLength(1);
    expect(host.decks.A.playing).toBe(true);
    expect(host.mixes).toEqual([]);
  });

  it("exposes the planned transition for the next track", async () => {
    const { host, ctl } = setup();
    ctl.enable();
    await ctl.settled();
    const snap = ctl.getSnapshot();
    expect(snap.nextTrackId).toBe("b");
    expect(snap.nextSource).toBe("queue");
    expect(snap.plan).toEqual(planOf(host, "a", "b"));
  });

  it("analyzes a track stored by an older analysis before it plans", async () => {
    const { host, ctl } = setup("ab", { patch: id => id === "b" ? { analysis: 1 } : {} });
    ctl.enable();
    await ctl.settled();
    expect(host.analyzed).toEqual(["b"]);
    expect(phase(ctl)).toBe("ready");
  });

  it("goes on with an unanalyzed track when the analysis itself fails", async () => {
    const { host, ctl } = setup("ab", { patch: id => id === "b" ? { analysis: 1 } : {} });
    host.analyzeFails = true;
    ctl.enable();
    await ctl.settled();
    expect(phase(ctl)).toBe("ready");
    expect(host.decks.B.trackId).toBe("b");
  });

  it("waits, still playing, when the queue has nothing after the current track", async () => {
    const { host, ctl } = setup("a");
    ctl.enable();
    await ctl.settled();
    expect(phase(ctl)).toBe("analyzing");
    expect(ctl.getSnapshot().nextTrackId).toBeNull();
    expect(host.decks.A.playing).toBe(true);
    ctl.add(["b"]);
    await ctl.settled();
    expect(phase(ctl)).toBe("ready");
  });
});

describe("mixing", () => {
  it("starts the mix once at the out point, even if the clock ticks again before it answers", async () => {
    const { host, ctl } = setup();
    ctl.enable();
    await ctl.settled();
    const plan = planOf(host, "a", "b");
    host.decks.A.position = plan.outAt - 10;
    for (let i = 0; i < 5; i++) ctl.tick();
    expect(host.mixes).toHaveLength(0);
    host.decks.A.position = plan.outAt - PREROLL;
    for (let i = 0; i < 10; i++) ctl.tick();
    await ctl.settled();
    expect(host.mixes).toHaveLength(1);
    expect(host.mixes[0]).toMatchObject({ now: false, from: "A" });
    expect(host.mixes[0].plan.toId).toBe("b");
    expect(phase(ctl)).toBe("mixing");
  });

  it("alternates the decks and moves through the queue to its end", async () => {
    const { host, ctl } = setup();
    ctl.enable();
    await ctl.settled();

    runUpToOutPoint(host, ctl, "a", "b"); ctl.tick(); await ctl.settled();
    host.completeMix(); await ctl.settled();
    expect(host.live).toBe("B");
    expect(ctl.queue.items.find(i => i.uid === ctl.queue.currentUid)?.trackId).toBe("b");
    expect(phase(ctl)).toBe("ready");
    expect(host.decks.A.trackId).toBe("c");
    expect(host.loads.at(-1)).toEqual({ deck: "A", trackId: "c" });

    runUpToOutPoint(host, ctl, "b", "c"); ctl.tick(); await ctl.settled();
    expect(host.mixes[1]).toMatchObject({ from: "B" });
    host.completeMix(); await ctl.settled();
    expect(host.live).toBe("A");
    expect(phase(ctl)).toBe("analyzing");
    expect(ctl.getSnapshot().detail).toMatch(/last track/i);
  });

  it("finishes when the last track ends and the queue is not looping", async () => {
    const { host, ctl } = setup("ab");
    ctl.enable(); await ctl.settled();
    runUpToOutPoint(host, ctl, "a", "b"); ctl.tick(); await ctl.settled();
    host.completeMix(); await ctl.settled();
    host.decks.B = { ...host.decks.B, playing: false, ended: true };
    ctl.tick();
    expect(phase(ctl)).toBe("idle");
    expect(ctl.getSnapshot().detail).toMatch(/finished/i);
  });

  it("comes back to the first track when the queue loops", async () => {
    const { host, ctl } = setup("ab", { queue: { loop: true } });
    ctl.enable(); await ctl.settled();
    runUpToOutPoint(host, ctl, "a", "b"); ctl.tick(); await ctl.settled();
    host.completeMix(); await ctl.settled();
    expect(phase(ctl)).toBe("ready");
    expect(host.decks.A.trackId).toBe("a");
    expect(ctl.getSnapshot().nextSource).toBe("queue");
  });

  it("repeats a lone track when looping", async () => {
    const { host, ctl } = setup("a", { queue: { loop: true } });
    ctl.enable(); await ctl.settled();
    expect(phase(ctl)).toBe("ready");
    expect(host.decks.B.trackId).toBe("a");
  });

  it("mixes late with a blend that fits when the DJ seeked past the out point", async () => {
    const { host, ctl } = setup("ab");
    ctl.enable(); await ctl.settled();
    const plan = planOf(host, "a", "b");
    host.decks.A.position = 236;
    ctl.tick(); await ctl.settled();
    expect(host.mixes[0].now).toBe(true);
    expect(host.mixes[0].plan.bars).toBeLessThan(plan.bars);
  });

  it("plays the next track straight away when the old one ended before the mix", async () => {
    const { host, ctl } = setup("ab");
    ctl.enable(); await ctl.settled();
    host.decks.A = { ...host.decks.A, playing: false, ended: true, position: 240 };
    ctl.tick(); await ctl.settled();
    expect(host.cuts).toEqual(["B"]);
    expect(host.mixes).toEqual([]);
    expect(ctl.queue.items.find(i => i.uid === ctl.queue.currentUid)?.trackId).toBe("b");
    expect(host.live).toBe("B");
  });

  it("mixes two tracks with no tempo as a plain crossfade and goes on", async () => {
    const { host, ctl } = setup("ab", { patch: () => ({ bpm: null, camelot: undefined, key: undefined }) });
    ctl.enable(); await ctl.settled();
    const plan = planOf(host, "a", "b");
    expect(plan.eq).toBe("none");
    expect(plan.effect).toBe("none");
    host.decks.A.position = plan.outAt - PREROLL;
    ctl.tick(); await ctl.settled();
    expect(host.mixes).toHaveLength(1);
    expect(phase(ctl)).toBe("mixing");
  });
});

describe("skipping", () => {
  it("mixes into the next track now, with a quick blend", async () => {
    const { host, ctl } = setup("ab");
    ctl.enable(); await ctl.settled();
    expect(ctl.skip()).toBe(true);
    await ctl.settled();
    expect(host.mixes).toHaveLength(1);
    expect(host.mixes[0].now).toBe(true);
    expect(host.mixes[0].plan.bars).toBeLessThanOrEqual(4);
    expect(host.decks.A.position).toBe(10);
  });

  it("waits for the load when the next track is not ready yet, then mixes", async () => {
    const { host, ctl } = setup("ab");
    host.gated.add("b");
    ctl.enable();
    await Promise.resolve();
    expect(phase(ctl)).toBe("preparing");
    expect(ctl.skip()).toBe(true);
    expect(ctl.getSnapshot().skipPending).toBe(true);
    expect(host.mixes).toHaveLength(0);
    host.release("b"); await ctl.settled();
    expect(phase(ctl)).toBe("ready");
    ctl.tick(); await ctl.settled();
    expect(host.mixes).toHaveLength(1);
    expect(ctl.getSnapshot().skipPending).toBe(false);
  });

  it("finishes a running mix instead of starting another", async () => {
    const { host, ctl } = setup("abc");
    ctl.enable(); await ctl.settled();
    runUpToOutPoint(host, ctl, "a", "b"); ctl.tick(); await ctl.settled();
    expect(phase(ctl)).toBe("mixing");
    expect(ctl.skip()).toBe(true);
    expect(host.finished).toBe(1);
    expect(host.mixes).toHaveLength(1);
    await ctl.settled();
    expect(host.live).toBe("B");
    expect(phase(ctl)).toBe("ready");
  });

  it("does nothing, and says so, when there is no next track", async () => {
    const { host, ctl } = setup("a");
    ctl.enable(); await ctl.settled();
    expect(ctl.skip()).toBe(false);
    expect(host.mixes).toHaveLength(0);
    expect(host.notices.at(-1)?.message).toMatch(/no next track/i);
  });

  it("jumps to a chosen entry", async () => {
    const { host, ctl } = setup("abcd");
    ctl.enable(); await ctl.settled();
    const d = ctl.queue.items[3];
    expect(ctl.jumpTo(d.uid)).toBe(true);
    await ctl.settled();
    expect(host.decks.B.trackId).toBe("d");
    ctl.tick(); await ctl.settled();
    expect(host.mixes.at(-1)?.plan.toId).toBe("d");
    expect(titlesOf(ctl)).toEqual(["a", "d", "b", "c"]);
  });
});

describe("recovering", () => {
  it("skips a damaged next track, marks it, and keeps the session going", async () => {
    const { host, ctl } = setup("abc");
    host.failing.set("b", { times: Infinity });
    ctl.enable(); await ctl.settled();
    expect(phase(ctl)).toBe("ready");
    expect(host.decks.B.trackId).toBe("c");
    expect(ctl.queue.items[1]).toMatchObject({ trackId: "b", status: "failed", reason: "The browser could not decode this file" });
    expect(host.notices.some(n => n.kind === "fail" && /b was skipped/.test(n.message))).toBe(true);
    expect(host.decks.A.playing).toBe(true);
    host.decks.A.position = planOf(host, "a", "c").outAt - PREROLL;
    ctl.tick(); await ctl.settled();
    expect(host.mixes[0].plan.toId).toBe("c");
  });

  it("shows recovering while it looks for the replacement", async () => {
    const { host, ctl } = setup("abc");
    host.failing.set("b", { times: Infinity });
    host.gated.add("c");
    const seen: AutoPhase[] = [];
    ctl.subscribe(() => { if (seen.at(-1) !== phase(ctl)) seen.push(phase(ctl)); });
    ctl.enable(); await Promise.resolve(); await Promise.resolve();
    host.release("b");
    await new Promise(r => setTimeout(r, 0));
    expect(seen).toContain("recovering");
    host.release("c"); await ctl.settled();
    expect(phase(ctl)).toBe("ready");
  });

  it("retries a load that merely timed out once before giving up on it", async () => {
    const { host, ctl } = setup("ab");
    host.failing.set("b", { times: 1, name: "TimeoutError" });
    ctl.enable(); await ctl.settled();
    expect(phase(ctl)).toBe("ready");
    expect(ctl.queue.items[1].status).toBeUndefined();
    expect(ctl.queue.items[1].attempts).toBe(1);
    expect(host.notices).toEqual([]);
  });

  it("stops at error, with the current track still playing, after three failures in a row", async () => {
    const { host, ctl } = setup("abcdef");
    for (const id of "bcd") host.failing.set(id, { times: Infinity });
    ctl.enable(); await ctl.settled();
    expect(phase(ctl)).toBe("error");
    expect(ctl.getSnapshot().error).toMatch(/3 tracks in a row/);
    expect(host.decks.A.playing).toBe(true);
    // Starting again gives the failed ones another chance.
    for (const id of "bcd") host.failing.delete(id);
    ctl.enable(); await ctl.settled();
    expect(phase(ctl)).toBe("ready");
    expect(host.decks.B.trackId).toBe("b");
  });

  it("recovers when the incoming deck cannot start, and leaves the live deck playing", async () => {
    const { host, ctl } = setup("abc");
    ctl.enable(); await ctl.settled();
    host.startOk = false;
    runUpToOutPoint(host, ctl, "a", "b"); ctl.tick(); await ctl.settled();
    expect(host.mixes).toHaveLength(0);
    expect(ctl.queue.items[1].status).toBe("failed");
    expect(host.decks.A.playing).toBe(true);
    host.startOk = true;
    expect(phase(ctl)).toBe("ready");
    expect(ctl.getSnapshot().nextTrackId).toBe("c");
  });

  it("drops a track deleted from the library and carries on", async () => {
    const { host, ctl } = setup("abc");
    host.library.delete("b");
    ctl.enable(); await ctl.settled();
    expect(titlesOf(ctl)).toEqual(["a", "c"]);
    expect(host.decks.B.trackId).toBe("c");
  });

  it("moves on from a live track that broke, as soon as the next one is ready", async () => {
    const { host, ctl } = setup("abc");
    ctl.enable(); await ctl.settled();
    // A media element that failed is not playing any more.
    host.decks.A.playing = false;
    ctl.deckError("A");
    expect(ctl.queue.items[0].status).toBe("failed");
    ctl.tick(); await ctl.settled();
    expect(host.cuts).toEqual(["B"]);
  });

  it("recovers from a next deck that broke while waiting", async () => {
    const { host, ctl } = setup("abc");
    ctl.enable(); await ctl.settled();
    ctl.deckError("B"); await ctl.settled();
    expect(ctl.queue.items[1].status).toBe("failed");
    expect(host.decks.B.trackId).toBe("c");
    expect(phase(ctl)).toBe("ready");
  });

  it("skips the incoming track when it breaks mid-mix", async () => {
    const { host, ctl } = setup("abc");
    ctl.enable(); await ctl.settled();
    runUpToOutPoint(host, ctl, "a", "b"); ctl.tick(); await ctl.settled();
    ctl.deckError("B"); await ctl.settled();
    expect(host.aborted).toBe(1);
    expect(ctl.queue.items[1].status).toBe("failed");
    expect(host.decks.B.trackId).toBe("c");
  });
});

describe("races and edits while it works", () => {
  it("throws away a load the queue moved past", async () => {
    const { host, ctl } = setup("abc");
    host.gated.add("b");
    ctl.enable();
    await Promise.resolve();
    expect(host.decks.B.trackId).toBe("b");
    ctl.remove(ctl.queue.items[1].uid);
    await Promise.resolve();
    host.release("b"); await ctl.settled();
    expect(phase(ctl)).toBe("ready");
    expect(host.decks.B.trackId).toBe("c");
    expect(ctl.getSnapshot().nextTrackId).toBe("c");
    expect(host.mixes).toHaveLength(0);
  });

  it("prepares again when the entry that plays next changes", async () => {
    const { host, ctl } = setup("abcd");
    ctl.enable(); await ctl.settled();
    expect(host.decks.B.trackId).toBe("b");
    ctl.playNext(ctl.queue.items[3].uid); await ctl.settled();
    expect(host.decks.B.trackId).toBe("d");
    expect(phase(ctl)).toBe("ready");
  });

  it("does not reload when an edit leaves the next track alone", async () => {
    const { host, ctl } = setup("abcd");
    ctl.enable(); await ctl.settled();
    const loads = host.loads.length;
    ctl.remove(ctl.queue.items[3].uid);
    ctl.add(["e"]);
    ctl.moveTo(ctl.queue.items[3].uid, 2);
    await ctl.settled();
    expect(host.loads).toHaveLength(loads);
    expect(phase(ctl)).toBe("ready");
  });

  it("does not touch the decks while a mix runs when the queue changes", async () => {
    const { host, ctl } = setup("abc");
    ctl.enable(); await ctl.settled();
    runUpToOutPoint(host, ctl, "a", "b"); ctl.tick(); await ctl.settled();
    const loads = host.loads.length;
    ctl.remove(ctl.queue.items[1].uid);
    ctl.add(["e"], "next");
    await ctl.settled();
    expect(host.loads).toHaveLength(loads);
    expect(phase(ctl)).toBe("mixing");
    host.completeMix(); await ctl.settled();
    expect(phase(ctl)).toBe("ready");
  });

  it("follows a track the DJ loaded by hand onto the idle deck", async () => {
    const { host, ctl } = setup("abc");
    ctl.enable(); await ctl.settled();
    host.decks.B = { ...blank(), trackId: "f" };
    ctl.notifyManualLoad("B", "f"); await ctl.settled();
    expect(ctl.getSnapshot()).toMatchObject({ nextTrackId: "f", nextSource: "manual" });
    expect(phase(ctl)).toBe("ready");
    expect(host.loads.some(l => l.trackId === "f")).toBe(false);
    host.decks.A.position = planOf(host, "a", "f").outAt - PREROLL;
    ctl.tick(); await ctl.settled();
    expect(host.mixes[0].plan.toId).toBe("f");
    host.completeMix(); await ctl.settled();
    // Back to the queue afterwards: its place is kept.
    expect(ctl.getSnapshot().nextTrackId).toBe("b");
  });

  it("plays the track already cued on the other deck, not the one the queue would pick", async () => {
    // The queue goes a, b, c, d; the DJ cued "d" on deck B before turning AutoMix on.
    const { host, ctl } = setup("abcd");
    host.decks.B = { ...blank(), trackId: "d" };
    ctl.enable(); await ctl.settled();
    expect(ctl.getSnapshot()).toMatchObject({ nextTrackId: "d", nextSource: "manual", phase: "ready" });
    expect(host.loads.some(l => l.trackId === "b")).toBe(false);
    runUpToOutPoint(host, ctl, "a", "d"); ctl.tick(); await ctl.settled();
    expect(host.mixes[0].plan.toId).toBe("d");
  });

  it("takes the cued track as the queue's own entry when it is the one that comes next", async () => {
    const { host, ctl } = setup("abc");
    host.decks.B = { ...blank(), trackId: "b" };
    ctl.enable(); await ctl.settled();
    expect(ctl.getSnapshot()).toMatchObject({ nextTrackId: "b", nextSource: "queue" });
  });

  it("re-plans when the DJ loads a different track on the live deck", async () => {
    const { host, ctl } = setup("abcd");
    ctl.enable(); await ctl.settled();
    host.decks.A = { ...host.decks.A, trackId: "c", position: 5 };
    ctl.notifyManualLoad("A", "c"); await ctl.settled();
    expect(ctl.queue.items.find(i => i.uid === ctl.queue.currentUid)?.trackId).toBe("c");
    expect(ctl.getSnapshot().nextTrackId).toBe("d");
    expect(host.decks.B.trackId).toBe("d");
  });

  it("uses the track left on the other deck when the queue is empty, as auto mix always did", async () => {
    const { host, ctl } = setup("a");
    host.decks.B = { ...blank(), trackId: "b" };
    ctl.enable(); await ctl.settled();
    expect(ctl.getSnapshot()).toMatchObject({ nextTrackId: "b", nextSource: "manual", phase: "ready" });
    runUpToOutPoint(host, ctl, "a", "b"); ctl.tick(); await ctl.settled();
    host.completeMix(); await ctl.settled();
    // The track that just played stays on deck A: it must not come back as the "next" one.
    expect(ctl.getSnapshot().nextTrackId).toBeNull();
    expect(phase(ctl)).toBe("analyzing");
  });

  it("does not read a stale plan: an edited plan is used when the mix starts", async () => {
    const { host, ctl } = setup("ab");
    ctl.enable(); await ctl.settled();
    const edited = { ...planOf(host, "a", "b"), bars: 2, outAt: 100 };
    host.planFor = () => edited;
    host.decks.A.position = 100 - PREROLL;
    ctl.tick(); await ctl.settled();
    expect(host.mixes[0].plan).toBe(edited);
  });

  it("publishes a plan changed outside it (an edit, an AI plan) when asked to replan", async () => {
    const { host, ctl } = setup("ab");
    ctl.enable(); await ctl.settled();
    const edited = { ...planOf(host, "a", "b"), outAt: 120, by: "ai" as const };
    host.planFor = () => edited;
    expect(ctl.getSnapshot().plan).not.toBe(edited);
    ctl.replan();
    expect(ctl.getSnapshot().plan).toBe(edited);
  });
});

describe("taking control", () => {
  it("holds new mixes while paused and picks up where it was on resume, without loading again", async () => {
    const { host, ctl } = setup("abc");
    ctl.enable(); await ctl.settled();
    const loads = host.loads.length;
    ctl.pause();
    expect(phase(ctl)).toBe("paused");
    host.decks.A.position = planOf(host, "a", "b").outAt;
    ctl.tick(); await ctl.settled();
    expect(host.mixes).toHaveLength(0);
    ctl.resume(); await ctl.settled();
    expect(host.loads).toHaveLength(loads);
    expect(phase(ctl)).toBe("ready");
    ctl.tick(); await ctl.settled();
    expect(phase(ctl)).toBe("mixing");
  });

  it("waits for a running mix before it pauses, so the audio never breaks", async () => {
    const { host, ctl } = setup("abc");
    ctl.enable(); await ctl.settled();
    runUpToOutPoint(host, ctl, "a", "b"); ctl.tick(); await ctl.settled();
    ctl.pause();
    expect(phase(ctl)).toBe("mixing");
    expect(ctl.getSnapshot().pausing).toBe(true);
    host.completeMix(); await ctl.settled();
    expect(phase(ctl)).toBe("paused");
    expect(host.loads.at(-1)?.trackId).toBe("b");
  });

  it("pauses itself when the DJ stops the mix, and can be resumed", async () => {
    const { host, ctl } = setup("abc");
    ctl.enable(); await ctl.settled();
    runUpToOutPoint(host, ctl, "a", "b"); ctl.tick(); await ctl.settled();
    ctl.mixEvent("cancel");
    expect(phase(ctl)).toBe("paused");
    expect(ctl.getSnapshot().detail).toMatch(/stopped/);
    // Both decks are left playing by a stopped mix; AutoMix waits for the DJ to sort that out, then goes on.
    ctl.resume(); await ctl.settled();
    expect(phase(ctl)).toBe("analyzing");
    expect(ctl.getSnapshot().detail).toMatch(/both decks/i);
    host.decks.B.playing = false;
    ctl.tick(); await ctl.settled();
    expect(phase(ctl)).toBe("ready");
  });

  it("stops at once, and a mix already running finishes by itself", async () => {
    const { host, ctl } = setup("abc");
    ctl.enable(); await ctl.settled();
    runUpToOutPoint(host, ctl, "a", "b"); ctl.tick(); await ctl.settled();
    ctl.stop();
    expect(phase(ctl)).toBe("idle");
    expect(host.finished).toBe(0);
    expect(host.aborted).toBe(0);
    host.completeMix(); await ctl.settled();
    expect(phase(ctl)).toBe("idle");
    expect(host.loads.filter(l => l.trackId === "c")).toHaveLength(0);
    expect(ctl.queue.items.find(i => i.uid === ctl.queue.currentUid)?.trackId).toBe("b");
  });

  it("does not leave a late load behind after stop", async () => {
    const { host, ctl } = setup("abc");
    host.gated.add("b");
    ctl.enable(); await Promise.resolve();
    ctl.stop();
    host.release("b"); await ctl.settled();
    expect(phase(ctl)).toBe("idle");
    expect(ctl.getSnapshot().nextTrackId).toBeNull();
  });

  it("leaves manual playback alone while it is off", async () => {
    const { host, ctl } = setup("abc");
    advance(host, 1, ctl);
    ctl.notifyManualLoad("B", "e");
    ctl.deckError("A");
    expect(phase(ctl)).toBe("idle");
    expect(host.loads).toEqual([]);
    expect(host.mixes).toEqual([]);
    expect(host.cuts).toEqual([]);
  });

  it("does not fight a DJ who plays both decks by hand", async () => {
    const { host, ctl } = setup("abc");
    ctl.enable(); await ctl.settled();
    host.decks.B.playing = true;
    host.decks.A.position = planOf(host, "a", "b").outAt;
    ctl.tick(); await ctl.settled();
    expect(host.mixes).toHaveLength(0);
  });
});

describe("starting the queue", () => {
  it("loads and plays the first entry when the decks are empty, then prepares the next", async () => {
    const host = new FakeHost();
    for (const id of "abc") host.add(id);
    const ctl = new AutoMix(host);
    host.ctl = ctl;
    ctl.setQueue(enqueue(emptyQueue(), ["a", "b", "c"]).queue);
    ctl.start(); await ctl.settled();
    expect(host.loads[0]).toEqual({ deck: "A", trackId: "a" });
    expect(host.played).toEqual(["A"]);
    expect(host.decks.B.trackId).toBe("b");
    expect(phase(ctl)).toBe("ready");
    expect(ctl.queue.items.find(i => i.uid === ctl.queue.currentUid)?.trackId).toBe("a");
  });

  it("plays what is already on the live deck instead of reloading it", async () => {
    const { host, ctl } = setup("abc");
    host.decks.A.playing = false;
    ctl.start(); await ctl.settled();
    expect(host.loads.some(l => l.deck === "A")).toBe(false);
    expect(host.played).toEqual(["A"]);
  });

  it("says so, and keeps waiting, when the queue is empty", async () => {
    const host = new FakeHost();
    const ctl = new AutoMix(host);
    host.ctl = ctl;
    ctl.start(); await ctl.settled();
    expect(phase(ctl)).toBe("analyzing");
    expect(ctl.getSnapshot().detail).toMatch(/add tracks/i);
  });

  it("goes to error, not silence, when the browser blocks playback", async () => {
    const { host, ctl } = setup("abc");
    host.decks.A.playing = false;
    host.play = async () => { throw new Error("NotAllowedError"); };
    ctl.start(); await ctl.settled();
    expect(phase(ctl)).toBe("error");
    expect(ctl.getSnapshot().error).toMatch(/blocked playback/);
  });
});

describe("the queue", () => {
  it("is independent of the library: adding unknown tracks is ignored, removing never touches a track", async () => {
    const { host, ctl } = setup("ab");
    expect(ctl.add(["zzz"])).toEqual([]);
    ctl.remove(ctl.queue.items[1].uid);
    expect(host.library.has("b")).toBe(true);
    expect(titlesOf(ctl)).toEqual(["a"]);
  });

  it("sorts what comes next by fit when Smart ordering is on", async () => {
    const patch: Record<string, Partial<Track>> = {
      a: { bpm: 128, camelot: "8A" }, b: { bpm: 90, camelot: "3B" }, c: { bpm: 127, camelot: "9A" }, d: { bpm: 100, camelot: "2B" },
    };
    const { ctl } = setup("abcd", { patch: id => patch[id] ?? {} });
    ctl.setSmart(true);
    expect(titlesOf(ctl)[0]).toBe("a");
    expect(titlesOf(ctl)[1]).toBe("c");
    expect(ctl.queue.smart).toBe(true);
  });

  it("turns Smart ordering off when the DJ orders by hand, and says so", async () => {
    const { host, ctl } = setup("abc");
    ctl.setSmart(true);
    ctl.move(ctl.queue.items[2].uid, -1);
    expect(ctl.queue.smart).toBe(false);
    expect(host.notices.at(-1)?.message).toMatch(/smart ordering is off/i);
  });

  it("keeps Smart ordering when tracks are added", async () => {
    const patch: Record<string, Partial<Track>> = { a: { bpm: 128, camelot: "8A" }, b: { bpm: 90, camelot: "3B" }, c: { bpm: 127, camelot: "9A" } };
    const { ctl } = setup("ab", { patch: id => patch[id] ?? {} });
    ctl.setSmart(true);
    ctl.add(["c"]);
    expect(titlesOf(ctl)).toEqual(["a", "c", "b"]);
  });

  it("restores a saved queue without the entries that left the library", async () => {
    const { host, ctl } = setup("abc");
    host.library.delete("b");
    const saved = enqueue(emptyQueue(), ["a", "b", "c"]).queue;
    ctl.setQueue(saved);
    expect(titlesOf(ctl)).toEqual(["a", "c"]);
    expect(phase(ctl)).toBe("idle");
  });

  it("notifies listeners of every change, and not after they unsubscribe", async () => {
    const { ctl } = setup("abc");
    let calls = 0;
    const off = ctl.subscribe(() => { calls++; });
    ctl.add(["d"]);
    expect(calls).toBeGreaterThan(0);
    const before = calls;
    off();
    ctl.add(["e"]);
    expect(calls).toBe(before);
  });
});
