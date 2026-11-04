import { describe, expect, it } from "vitest";
import { track } from "@/lib/test-tracks";
import { advance, emptyQueue, enqueue, markFailed, moveBy } from "@/lib/queue";
import { spanOn } from "@/lib/transition";
import type { DeckId, TransitionPlan } from "@/lib/types";
import { PHASE, dueIn, formatDue, formatGap, mixMarks, pairView, phaseOf, queueRows, type AutoPhase, type DeckLite } from "./model";

/* The panel's view model against the real queue and transition functions: what the panel lists and labels has to be
   what the engine holds. */

const decks = (a: Partial<DeckLite> = {}, b: Partial<DeckLite> = {}): Record<DeckId, DeckLite> => ({
  A: { trackId: null, rate: 1, playing: false, ...a }, B: { trackId: null, rate: 1, playing: false, ...b },
});
const plan = (patch: Partial<TransitionPlan> = {}): TransitionPlan => ({
  fromId: "Out", toId: "In", outAt: 180, inAt: 16, bars: 8, volume: "smooth", eq: "bass", effect: "none", preset: "auto", by: "auto", ...patch,
});

describe("phase labels", () => {
  const phases: AutoPhase[] = ["idle", "analyzing", "preparing", "ready", "mixing", "recovering", "paused", "error"];
  it.each(phases)("%s has a label and a Sodium status", phase => {
    expect(PHASE[phase].label.length).toBeGreaterThan(0);
    expect(phaseOf({ enabled: true, phase })).toBe(phase);
  });
  it("reads off when the engine is not following the queue", () => {
    expect(phaseOf({ enabled: false, phase: "idle" })).toBe("off");
    expect(PHASE.off.label).toBe("Off");
  });
  it("still shows an error the engine reports as disabled", () => {
    expect(phaseOf({ enabled: false, phase: "error" })).toBe("error");
    expect(PHASE.error.status).toBe("fail");
  });
});

describe("pair readout", () => {
  const out = track({ title: "Out", bpm: 124, camelot: "8A", key: "Am" });
  const into = track({ title: "In", bpm: 128, camelot: "9A", key: "Em" });
  const tracks = new Map([[out.id, out], [into.id, into]]);

  it("names both sides, their decks and the tempo as heard", () => {
    const view = pairView(plan({ strategy: "beatmatch" }), tracks, decks({ trackId: "Out", rate: 1.02, playing: true }, { trackId: "In" }), "A", null);
    expect(view.from?.deck).toBe("A");
    expect(view.to?.deck).toBe("B");
    expect(view.from?.bpm).toBeCloseTo(124 * 1.02, 6);
    expect(view.relation).toBe("adjacent");
    // The gap is against the outgoing deck as heard, not its file: 128 against 126.48.
    expect(view.gap).toBeCloseTo(128 / (124 * 1.02) - 1, 6);
  });

  it("gives the length in beats and in seconds at the outgoing deck's rate", () => {
    const view = pairView(plan({ bars: 4 }), tracks, decks({ trackId: "Out", rate: 1.25 }, { trackId: "In" }), "A", null);
    expect(view.beats).toBe(16);
    expect(view.seconds).toBeCloseTo(spanOn(out, 4) / 1.25, 6);
  });

  it("names the transition from the strategy, the effect and the bass swap", () => {
    const d = decks({ trackId: "Out" }, { trackId: "In" });
    expect(pairView(plan({ strategy: "eq-transition", effect: "swap" }), tracks, d, "A", null).type).toBe("EQ transition · filter swap · bass swap");
    expect(pairView(plan({ strategy: "quick-cut", eq: "none", effect: "echo" }), tracks, d, "A", null).type).toBe("Quick cut · echo out");
    expect(pairView(plan({ preset: "custom", eq: "none" }), tracks, d, "A", null).type).toBe("Edited");
  });

  it("shows the queued next track before it is on a deck, with no plan yet", () => {
    const view = pairView(null, tracks, decks({ trackId: "Out", playing: true }), "A", "In");
    expect(view.to?.track.id).toBe("In");
    expect(view.to?.deck).toBeNull();
    expect(view.type).toBeNull();
  });

  it("reports an unknown relation without keys", () => {
    const bare = new Map([[out.id, { ...out, camelot: undefined }], [into.id, into]]);
    expect(pairView(plan(), bare, decks({ trackId: "Out" }, { trackId: "In" }), "A", null).relation).toBe("unknown");
  });
});

describe("waveform marks", () => {
  const out = track({ title: "Out", bpm: 128 });
  const into = track({ title: "In", bpm: 120 });
  const tracks = new Map([[out.id, out], [into.id, into]]);

  it("spans the outgoing track's bars and the incoming track's matched media time", () => {
    const marks = mixMarks(plan(), tracks, decks({ trackId: "Out" }, { trackId: "In" }))!;
    const span = spanOn(out, 8);
    expect(marks.out).toEqual([180, 180 + span]);
    // Synced: the incoming deck plays at 128/120, so it covers more of its own media in the same time.
    expect(marks.in[1] - marks.in[0]).toBeCloseTo(span * 128 / 120, 6);
  });

  it("leaves the incoming deck at its own rate when the plan does not sync", () => {
    const marks = mixMarks(plan({ sync: false }), tracks, decks({ trackId: "Out", rate: 1 }, { trackId: "In", rate: 1 }))!;
    expect(marks.in[1] - marks.in[0]).toBeCloseTo(spanOn(out, 8), 6);
  });

  it("has nothing to mark without a plan or its tracks", () => {
    expect(mixMarks(null, tracks, decks())).toBeNull();
    expect(mixMarks(plan({ toId: "gone" }), tracks, decks())).toBeNull();
  });
});

describe("countdown", () => {
  it("counts heard seconds to the out point", () => {
    expect(dueIn(100, 80, 1)).toBe(20);
    expect(dueIn(100, 80, 1.25)).toBe(16);
  });
  it("formats minutes, tenths near the end, and now", () => {
    expect(formatDue(75)).toBe("1:15");
    expect(formatDue(9.46)).toBe("0:09.5");
    expect(formatDue(0)).toBe("Now");
    expect(formatDue(-3)).toBe("Now");
    expect(formatDue(Number.NaN)).toBe("-");
  });
  it("signs the tempo gap", () => {
    expect(formatGap(0.0234)).toBe("+2.3%");
    expect(formatGap(-0.05)).toBe("-5.0%");
    expect(formatGap(null)).toBe("-");
  });
});

describe("queue rows", () => {
  const ids = ["a", "b", "c", "d"];
  const tracks = new Map(ids.map(id => [id, track({ title: id })]));
  const base = () => {
    const { queue } = enqueue(emptyQueue(), ids);
    return advance(queue, queue.items[0].uid);
  };

  it("lists the entry playing, then what follows, with the next one marked", () => {
    const q = base();
    const rows = queueRows(q, tracks, q.items[1].uid);
    expect(rows.map(r => [r.track?.id, r.state])).toEqual([["a", "current"], ["b", "next"], ["c", "upcoming"], ["d", "upcoming"]]);
  });

  it("follows a reorder made through the queue", () => {
    const q = base();
    const moved = moveBy(q, q.items[3].uid, -1);
    expect(queueRows(moved, tracks, null).map(r => r.track?.id)).toEqual(["a", "b", "d", "c"]);
  });

  it("wraps the played entries round when loop is on", () => {
    const q = { ...base(), loop: true };
    const at2 = advance(q, q.items[2].uid);
    expect(queueRows(at2, tracks, null).map(r => r.track?.id)).toEqual(["c", "d", "a", "b"]);
    expect(queueRows({ ...at2, loop: false }, tracks, null).map(r => r.track?.id)).toEqual(["c", "d"]);
  });

  it("moves failed entries to the end, with their reason", () => {
    const q = base();
    const failed = markFailed(q, q.items[1].uid, "The file could not be decoded");
    const rows = queueRows(failed, tracks, failed.items[2].uid);
    expect(rows.map(r => [r.track?.id, r.state])).toEqual([["a", "current"], ["c", "next"], ["d", "upcoming"], ["b", "failed"]]);
    expect(rows[3].item.reason).toBe("The file could not be decoded");
  });

  it("keeps an entry whose track left the library, unnamed", () => {
    const q = base();
    const rows = queueRows(q, new Map([...tracks].filter(([id]) => id !== "c")), null);
    expect(rows.find(r => r.item.trackId === "c")?.track).toBeUndefined();
  });
});
