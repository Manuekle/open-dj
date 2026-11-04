import { beforeEach, describe, expect, it } from "vitest";
import { ANALYSIS_VERSION } from "@/lib/analyze-dsp";
import { AutoMix, type AutoMixHost, type DeckView } from "@/lib/automix";
import { DEFAULT_SMART_STYLE, planTransition, scorePlan, styleOptions, type SmartStyle } from "@/lib/transition-planner";
import { spanOn } from "@/lib/transition";
import { track } from "@/lib/test-tracks";
import type { DeckId, Track, TransitionPlan } from "@/lib/types";
import { PHASE, mixMarks, pairView, phaseOf, queueRows, type DeckLite } from "./model";

/* The panel against the real Auto DJ controller and the real planner. Each test presses what a panel control presses
   (the same controller method dj.auto / dj.queue forward to), lets the engine settle, and checks two things: the
   engine's own state changed, and the panel's view model, built from the engine's snapshot, shows that change. The host
   stands in for use-dj and the audio engine: decks are plain objects, and loading or playing a deck resolves at once. */

const other = (id: DeckId): DeckId => id === "A" ? "B" : "A";
const blank = (): DeckView => ({ trackId: null, playing: false, ended: false, position: 0, duration: 0, rate: 1 });
const flat = (seconds: number, db: number) => Array.from({ length: seconds }, () => db);

class Host implements AutoMixHost {
  tracks = new Map<string, Track>();
  decks: Record<DeckId, DeckView> = { A: blank(), B: blank() };
  live: DeckId = "A";
  style: SmartStyle = DEFAULT_SMART_STYLE;
  /** Tracks whose file will not load. */
  bad = new Set<string>();
  mixes: { plan: TransitionPlan; now: boolean; from: DeckId }[] = [];
  notes: string[] = [];
  auto!: AutoMix;

  track(id: string) { return this.tracks.get(id); }
  deck(id: DeckId) { return { ...this.decks[id] }; }
  liveDeck(): DeckId {
    const { A, B } = this.decks;
    if (A.playing && !B.playing) return "A";
    if (B.playing && !A.playing) return "B";
    return this.live;
  }
  async prepare(deck: DeckId, t: Track, at: number) {
    if (this.bad.has(t.id)) throw new Error("The file could not be decoded");
    this.decks[deck] = { trackId: t.id, playing: false, ended: false, position: at, duration: t.duration, rate: 1 };
  }
  async play(deck: DeckId) { this.decks[deck].playing = true; this.live = deck; }
  async analyze() {}
  planFor(from: Track, to: Track) { return planTransition(from, to, styleOptions(this.style)).plan; }
  async startMix(plan: TransitionPlan, opts: { now: boolean; from: DeckId }) {
    this.mixes.push({ plan, ...opts });
    this.decks[other(opts.from)].playing = true;
    return true;
  }
  finishMix() { this.endMix(); }
  abortMix() {}
  async cut(to: DeckId, at: number) {
    this.decks[other(to)].playing = false;
    this.decks[to] = { ...this.decks[to], playing: true, position: at };
    this.live = to;
    return true;
  }
  notify(message: string) { this.notes.push(message); }
  /** What use-dj does when a mix completes: the old deck stops and the new one is the live deck. */
  endMix() {
    const m = this.mixes.at(-1)!;
    this.decks[m.from].playing = false;
    this.live = other(m.from);
    this.auto.mixEvent("end", { from: m.from, to: other(m.from) });
  }
}

let host: Host, auto: AutoMix;
const ids = ["a", "b", "c", "d"];
beforeEach(() => {
  host = new Host();
  ids.forEach((id, i) => host.tracks.set(id, track({
    title: id, bpm: 126 + i, camelot: `${8 + i}A`, key: "Am", keyClarity: 0.2, pulse: 8, analysis: ANALYSIS_VERSION,
    duration: 240, loudness: -10, energy: flat(240, -10), lufs: -10,
  })));
  auto = new AutoMix(host);
  host.auto = auto;
});

/** The panel's view of the engine right now, built the way the panel builds it. */
function view() {
  const s = auto.getSnapshot();
  const decks: Record<DeckId, DeckLite> = {
    A: { trackId: host.decks.A.trackId, rate: host.decks.A.rate, playing: host.decks.A.playing },
    B: { trackId: host.decks.B.trackId, rate: host.decks.B.rate, playing: host.decks.B.playing },
  };
  const live = host.liveDeck();
  return {
    snap: s, phase: phaseOf(s), label: PHASE[phaseOf(s)].label,
    rows: queueRows(s.queue, host.tracks, s.nextUid).map(r => `${r.track?.id ?? "?"}:${r.state}`),
    pair: pairView(s.plan, host.tracks, decks, live, s.nextTrackId),
  };
}
const uidOf = (trackId: string) => auto.getSnapshot().queue.items.find(i => i.trackId === trackId)!.uid;
async function startWith(list = ids) {
  auto.add(list);
  auto.start();
  await auto.settled();
}

describe("AutoMix on and off", () => {
  it("turning it on plays the first queued track and prepares the next one", async () => {
    expect(view().label).toBe("Off");
    await startWith();
    expect(host.decks.A).toMatchObject({ trackId: "a", playing: true });
    expect(host.decks.B).toMatchObject({ trackId: "b", playing: false });
    const v = view();
    expect(v.phase).toBe("ready");
    expect(v.label).toBe("Ready");
    expect(v.rows).toEqual(["a:current", "b:next", "c:upcoming", "d:upcoming"]);
    expect(v.pair.from?.track.id).toBe("a");
    expect(v.pair.from?.deck).toBe("A");
    expect(v.pair.to?.deck).toBe("B");
    expect(v.snap.plan?.score).toBeGreaterThanOrEqual(0);
    expect(v.snap.plan?.score).toBeLessThanOrEqual(100);
  });

  it("turning it off stops following the queue and the panel reads off", async () => {
    await startWith();
    auto.stop();
    expect(view().phase).toBe("off");
    expect(view().snap.enabled).toBe(false);
  });

  it("pause holds the next mix and resume brings it back", async () => {
    await startWith();
    auto.pause();
    expect(view().label).toBe("Paused");
    host.decks.A.position = view().snap.plan!.outAt;
    auto.tick();
    expect(host.mixes).toHaveLength(0);
    auto.resume();
    await auto.settled();
    expect(view().phase).toBe("ready");
  });
});

describe("the mix point", () => {
  it("mixes when the live deck reaches the out point, then advances the queue", async () => {
    await startWith();
    const plan = view().snap.plan!;
    host.decks.A.position = plan.outAt - 0.5;
    auto.tick();
    await auto.settled();
    expect(host.mixes).toHaveLength(1);
    expect(host.mixes[0]).toMatchObject({ now: false, from: "A" });
    expect(view().label).toBe("Mixing");

    host.endMix();
    await auto.settled();
    expect(host.decks.B).toMatchObject({ trackId: "b", playing: true });
    expect(host.decks.A.trackId).toBe("c");
    expect(view().rows).toEqual(["b:current", "c:next", "d:upcoming"]);
    expect(view().pair.from?.deck).toBe("B");
  });

  it("skip mixes into the next track now", async () => {
    await startWith();
    auto.skip();
    await auto.settled();
    expect(host.mixes).toHaveLength(1);
    expect(host.mixes[0].now).toBe(true);
    expect(view().phase).toBe("mixing");
  });
});

describe("the smart queue", () => {
  it("moving an entry changes what is prepared next and turns smart order off", async () => {
    await startWith();
    auto.setSmart(true);
    expect(view().snap.queue.smart).toBe(true);
    const order = view().rows.slice(1).map(r => r.split(":")[0]);
    // Move the last upcoming entry up one place.
    auto.move(uidOf(order.at(-1)!), -1);
    await auto.settled();
    expect(view().snap.queue.smart).toBe(false);
    expect(host.notes.some(n => /Smart ordering is off/.test(n))).toBe(true);
    const moved = [...order]; moved.splice(order.length - 2, 2, order.at(-1)!, order.at(-2)!);
    expect(view().rows.slice(1).map(r => r.split(":")[0])).toEqual(moved);
    expect(host.decks.B.trackId).toBe(moved[0]);
  });

  it("removing the next entry prepares the one after it", async () => {
    await startWith();
    auto.remove(uidOf("b"));
    await auto.settled();
    expect(host.decks.B.trackId).toBe("c");
    expect(view().rows).toEqual(["a:current", "c:next", "d:upcoming"]);
  });

  it("play next moves an entry to the front", async () => {
    await startWith();
    auto.playNext(uidOf("d"));
    await auto.settled();
    expect(host.decks.B.trackId).toBe("d");
    expect(view().rows[1]).toBe("d:next");
  });

  it("loop brings played tracks round again", async () => {
    await startWith(["a", "b", "c"]);
    host.decks.A.position = view().snap.plan!.outAt;
    auto.tick(); await auto.settled(); host.endMix(); await auto.settled();
    expect(view().rows).toEqual(["b:current", "c:next"]);
    auto.setLoop(true);
    await auto.settled();
    expect(view().snap.queue.loop).toBe(true);
    expect(view().rows).toEqual(["b:current", "c:next", "a:upcoming"]);
  });
});

describe("recovery and errors", () => {
  it("a track that will not load is marked failed and the queue moves on", async () => {
    host.bad.add("b");
    await startWith();
    expect(host.decks.B.trackId).toBe("c");
    const v = view();
    expect(v.phase).toBe("ready");
    expect(v.rows).toContain("b:failed");
    expect(v.snap.queue.items.find(i => i.trackId === "b")?.reason).toBe("The file could not be decoded");
    expect(host.notes.some(n => n.includes("b was skipped"))).toBe(true);
  });

  it("three failures in a row stop AutoMix with an error the panel still shows", async () => {
    ["b", "c", "d"].forEach(id => host.bad.add(id));
    await startWith();
    const v = view();
    expect(v.snap.enabled).toBe(false);
    expect(v.phase).toBe("error");
    expect(v.label).toBe("Error");
    expect(v.snap.error).toMatch(/3 tracks in a row/);
  });

  it("retry gives failed entries another chance", async () => {
    host.bad.add("b");
    await startWith();
    host.bad.delete("b");
    auto.retryFailed();
    await auto.settled();
    expect(view().rows).not.toContain("b:failed");
  });
});

describe("settings reach the plan the engine runs", () => {
  const out = () => host.tracks.get("a")!, into = () => host.tracks.get("b")!;

  it("style and length write the planner's strategy and bars", async () => {
    await startWith();
    host.style = { ...DEFAULT_SMART_STYLE, strategy: "quick-cut", bars: 1 };
    auto.setLoop(false); // any engine edit rebuilds the snapshot, and with it the plan
    const v = view();
    expect(v.snap.plan?.strategy).toBe("quick-cut");
    expect(v.pair.beats).toBe(4);
    expect(v.pair.type).toMatch(/^Quick cut/);
    expect(v.pair.seconds).toBeCloseTo(spanOn(out(), 1), 6);
  });

  it("tempo matching off leaves the incoming deck at its own tempo, and the marks follow", () => {
    const plan = planTransition(out(), into(), styleOptions({ ...DEFAULT_SMART_STYLE, tempo: "off" })).plan;
    expect(plan.sync).toBe(false);
    expect(["quick-cut", "fallback"]).toContain(plan.strategy);
    const decks = { A: { trackId: "a", rate: 1, playing: true }, B: { trackId: "b", rate: 1, playing: false } };
    const marks = mixMarks(plan, host.tracks, decks)!;
    expect(marks.in[1] - marks.in[0]).toBeCloseTo(marks.out[1] - marks.out[0], 6);
  });

  it("energy flow changes how the planner rates the same plan", () => {
    // The same integrated loudness, so both get the same trim, but the incoming body plays 4 dB hotter: a heard rise.
    const rising = { ...into(), energy: flat(240, -6) };
    const plan = planTransition(out(), rising).plan;
    const build = scorePlan(out(), rising, plan, { energy: "build" }).criteria.energy;
    const relax = scorePlan(out(), rising, plan, { energy: "relax" }).criteria.energy;
    expect(build.status).toBe("ok");
    expect(build.value!).toBeGreaterThan(relax.value!);
  });
});
