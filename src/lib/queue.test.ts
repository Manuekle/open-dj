import { describe, expect, it } from "vitest";
import {
  advance, clearQueue, currentIndex, emptyQueue, enqueue, markFailed, moveBy, moveItem, nextItem, playNext, pruneTracks, readQueue,
  removeItem, reorderUpcoming, retryFailed, syncTo, upcoming,
} from "@/lib/queue";
import type { PlayQueue } from "@/lib/types";

const ids = (q: PlayQueue) => q.items.map(i => i.trackId);
const upIds = (q: PlayQueue) => upcoming(q).map(i => i.trackId);
/** A queue of tracks a..e with the pointer on the given one. */
function of(list: string, current?: string, patch: Partial<PlayQueue> = {}): PlayQueue {
  const { queue } = enqueue(emptyQueue(), list.split(""));
  const at = current ? queue.items.find(i => i.trackId === current)!.uid : null;
  return { ...queue, currentUid: at, ...patch };
}

describe("queue editing", () => {
  it("adds at the end, right after the current entry, or at an index", () => {
    const q = of("abc", "a");
    expect(ids(enqueue(q, ["x"]).queue)).toEqual(["a", "b", "c", "x"]);
    expect(ids(enqueue(q, ["x", "y"], "next").queue)).toEqual(["a", "x", "y", "b", "c"]);
    expect(ids(enqueue(q, ["x"], 1).queue)).toEqual(["a", "x", "b", "c"]);
    expect(ids(enqueue(q, ["x"], 99).queue)).toEqual(["a", "b", "c", "x"]);
  });

  it("keeps entries for the same track apart", () => {
    const { queue, added } = enqueue(emptyQueue(), ["a", "a"]);
    expect(added[0].uid).not.toBe(added[1].uid);
    expect(ids(removeItem(queue, added[0].uid))).toEqual(["a"]);
  });

  it("does not change the queue when nothing is added", () => {
    const q = of("ab");
    expect(enqueue(q, []).queue).toBe(q);
  });

  it("moves entries, clamped to the list, and leaves the pointer on the same entry", () => {
    const q = of("abcd", "b");
    const [a, , , d] = q.items;
    expect(ids(moveItem(q, d.uid, 0))).toEqual(["d", "a", "b", "c"]);
    expect(ids(moveBy(q, a.uid, 2))).toEqual(["b", "c", "a", "d"]);
    expect(ids(moveBy(q, a.uid, -5))).toEqual(["a", "b", "c", "d"]);
    const moved = moveBy(q, a.uid, 2);
    expect(moved.items[currentIndex(moved)].trackId).toBe("b");
    expect(moveBy(q, "nope", 1)).toBe(q);
  });

  it("puts an entry right after the current one", () => {
    const q = of("abcde", "b");
    expect(ids(playNext(q, q.items[4].uid))).toEqual(["a", "b", "e", "c", "d"]);
    expect(ids(playNext(q, q.items[0].uid))).toEqual(["b", "a", "c", "d", "e"]);
    expect(playNext(q, q.currentUid!)).toBe(q);
  });

  it("removes an entry; removing the current one keeps the next entry next", () => {
    const q = of("abc", "b");
    const gone = removeItem(q, q.items[1].uid);
    expect(ids(gone)).toEqual(["a", "c"]);
    expect(gone.items[currentIndex(gone)].trackId).toBe("a");
    expect(upIds(gone)).toEqual(["c"]);
    const head = of("abc", "a");
    const first = removeItem(head, head.items[0].uid);
    expect(first.currentUid).toBeNull();
    expect(upIds(first)).toEqual(["b", "c"]);
  });

  it("empties everything except the entry now playing", () => {
    expect(ids(clearQueue(of("abc", "b")))).toEqual(["b"]);
    expect(ids(clearQueue(of("abc")))).toEqual([]);
  });

  it("drops entries whose track left the library", () => {
    const q = pruneTracks(of("abcd", "c"), id => id !== "c" && id !== "a");
    expect(ids(q)).toEqual(["b", "d"]);
    // The playing entry went: the pointer steps back to the entry before it, so "d" is still next.
    expect(q.items[currentIndex(q)].trackId).toBe("b");
    expect(upIds(q)).toEqual(["d"]);
    expect(pruneTracks(q, () => true)).toBe(q);
  });
});

describe("what plays next", () => {
  it("is the entries after the current one, in order", () => {
    const q = of("abcd", "b");
    expect(upIds(q)).toEqual(["c", "d"]);
    expect(nextItem(q)?.trackId).toBe("c");
  });

  it("starts from the top before anything has played", () => {
    expect(upIds(of("abc"))).toEqual(["a", "b", "c"]);
  });

  it("ends after the last entry, or wraps with loop on", () => {
    expect(nextItem(of("abc", "c"))).toBeNull();
    const looped = of("abc", "c", { loop: true });
    expect(upIds(looped)).toEqual(["a", "b", "c"]);
    expect(upIds({ ...looped, currentUid: looped.items[1].uid })).toEqual(["c", "a", "b"]);
  });

  it("repeats a single track when looping", () => {
    expect(upIds(of("a", "a", { loop: true }))).toEqual(["a"]);
    expect(upIds(of("a", "a"))).toEqual([]);
  });

  it("skips failed entries until they are retried", () => {
    let q = of("abcd", "a");
    q = markFailed(q, q.items[1].uid, "bad file");
    expect(upIds(q)).toEqual(["c", "d"]);
    expect(q.items[1]).toMatchObject({ status: "failed", reason: "bad file", attempts: 1 });
    q = retryFailed(q);
    expect(upIds(q)).toEqual(["b", "c", "d"]);
    expect(q.items[1].status).toBeUndefined();
  });
});

describe("following the track that plays", () => {
  it("moves the pointer to the entry of the playing track", () => {
    const q = of("abc", "a");
    expect(syncTo(q, "c").currentUid).toBe(q.items[2].uid);
    expect(syncTo(q, "a")).toBe(q);
  });

  it("takes the next entry with that track when it appears twice", () => {
    const q = of("abab", "a");
    expect(syncTo(q, "b").currentUid).toBe(q.items[1].uid);
    expect(syncTo({ ...q, currentUid: q.items[1].uid }, "a").currentUid).toBe(q.items[2].uid);
  });

  it("keeps the place when a track from outside the queue plays", () => {
    const q = of("abc", "b");
    expect(syncTo(q, "zzz")).toBe(q);
    expect(syncTo(q, null)).toBe(q);
  });

  it("advances to a given entry", () => {
    const q = of("abc");
    expect(advance(q, q.items[2].uid).currentUid).toBe(q.items[2].uid);
    expect(advance(q, "nope")).toBe(q);
  });
});

describe("reordering what comes next", () => {
  it("replaces the order after the current entry and leaves the rest", () => {
    const q = of("abcd", "a");
    const [, b, c, d] = q.items;
    expect(ids(reorderUpcoming(q, [d.uid, b.uid]))).toEqual(["a", "d", "b", "c"]);
    expect(reorderUpcoming(q, [b.uid, c.uid, d.uid])).toBe(q);
    expect(reorderUpcoming(q, [])).toBe(q);
  });
});

describe("saved queues", () => {
  it("reads back only what is well formed", () => {
    const q = readQueue({ items: [{ uid: "1", trackId: "a" }, { uid: "1", trackId: "b" }, { trackId: "c" }, null, { uid: "2", trackId: "d" }], currentUid: "gone", loop: "yes", smart: true });
    expect(ids(q)).toEqual(["a", "d"]);
    expect(q).toMatchObject({ currentUid: null, loop: false, smart: true });
    expect(readQueue(undefined)).toEqual(emptyQueue());
    expect(readQueue({ items: [{ uid: "1", trackId: "a" }], currentUid: "1" }).currentUid).toBe("1");
  });
});
