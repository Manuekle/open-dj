import type { PlayQueue, QueueItem } from "@/lib/types";

/* The play queue as plain data and pure functions: every edit returns a new queue, so the AutoMix controller can compare
   before and after, and a project saves it as it is. The queue holds track ids, never audio, and is independent of the
   library: a track can sit in it twice, and removing an entry never touches the file. */

export const emptyQueue = (): PlayQueue => ({ items: [], currentUid: null, loop: false, smart: false });

let counter = 0;
const newUid = () => globalThis.crypto?.randomUUID?.() ?? `q${Date.now().toString(36)}${(counter++).toString(36)}`;
export const makeItem = (trackId: string, uid: string = newUid()): QueueItem => ({ uid, trackId });

const indexOf = (q: PlayQueue, uid: string | null) => uid === null ? -1 : q.items.findIndex(i => i.uid === uid);
export const currentIndex = (q: PlayQueue) => indexOf(q, q.currentUid);
export const currentItem = (q: PlayQueue): QueueItem | null => q.items[currentIndex(q)] ?? null;
export const itemOf = (q: PlayQueue, uid: string | null): QueueItem | null => q.items[indexOf(q, uid)] ?? null;

/** What plays after the current entry, in order: the entries after it, then (with loop on) the ones before it and the
    current one last. Failed entries never appear. */
export function upcoming(q: PlayQueue): QueueItem[] {
  const at = currentIndex(q);
  const after = q.items.slice(at + 1);
  const wrapped = q.loop ? q.items.slice(0, at + 1) : [];
  return [...after, ...wrapped].filter(i => i.status !== "failed");
}
export const nextItem = (q: PlayQueue): QueueItem | null => upcoming(q)[0] ?? null;

/** Adds tracks at the end, right after the current entry ("next"), or at an index. */
export function enqueue(q: PlayQueue, trackIds: string[], where: "end" | "next" | number = "end"): { queue: PlayQueue; added: QueueItem[] } {
  const added = trackIds.map(id => makeItem(id));
  if (!added.length) return { queue: q, added };
  const at = where === "end" ? q.items.length : where === "next" ? currentIndex(q) + 1 : Math.max(0, Math.min(q.items.length, where));
  return { queue: { ...q, items: [...q.items.slice(0, at), ...added, ...q.items.slice(at)] }, added };
}

/** Drops entries by a test. When the current entry goes, the pointer steps back to the entry before it (or to none), so
    the entry that followed it is still next. */
export function removeWhere(q: PlayQueue, gone: (item: QueueItem) => boolean): PlayQueue {
  if (!q.items.some(gone)) return q;
  const at = currentIndex(q);
  const items = q.items.filter(i => !gone(i));
  let currentUid = q.currentUid;
  if (at >= 0 && gone(q.items[at])) {
    currentUid = null;
    for (let k = at - 1; k >= 0; k--) if (!gone(q.items[k])) { currentUid = q.items[k].uid; break; }
  }
  return { ...q, items, currentUid };
}
export const removeItem = (q: PlayQueue, uid: string) => removeWhere(q, i => i.uid === uid);
/** Drops the entries whose track is gone from the library. */
export const pruneTracks = (q: PlayQueue, has: (trackId: string) => boolean) => removeWhere(q, i => !has(i.trackId));
/** Empties the queue except the entry now playing. */
export const clearQueue = (q: PlayQueue) => removeWhere(q, i => i.uid !== q.currentUid);

/** Moves an entry to an index (in the list as it stands after taking the entry out). */
export function moveItem(q: PlayQueue, uid: string, to: number): PlayQueue {
  const from = indexOf(q, uid);
  if (from < 0) return q;
  const items = [...q.items];
  const [item] = items.splice(from, 1);
  const at = Math.max(0, Math.min(items.length, to));
  if (at === from) return q;
  items.splice(at, 0, item);
  return { ...q, items };
}
export const moveBy = (q: PlayQueue, uid: string, delta: number) => moveItem(q, uid, indexOf(q, uid) + delta);
/** Puts an entry right after the current one, so it plays next. */
export function playNext(q: PlayQueue, uid: string): PlayQueue {
  if (uid === q.currentUid || indexOf(q, uid) < 0) return q;
  const without = { ...q, items: q.items.filter(i => i.uid !== uid) };
  return moveItem(q, uid, currentIndex(without) + 1);
}

/** Replaces the order of the entries after the current one (smart ordering); entries not named keep their place at the end. */
export function reorderUpcoming(q: PlayQueue, order: string[]): PlayQueue {
  const at = currentIndex(q);
  const tail = q.items.slice(at + 1);
  const byUid = new Map(tail.map(i => [i.uid, i]));
  const sorted = order.map(uid => byUid.get(uid)).filter((i): i is QueueItem => !!i);
  const rest = tail.filter(i => !order.includes(i.uid));
  const items = [...q.items.slice(0, at + 1), ...sorted, ...rest];
  return items.every((item, k) => item === q.items[k]) ? q : { ...q, items };
}

/** Points the queue at the entry for the track that is playing now: the next one after the pointer with that track
    (wrapping), else where it was, so a track loaded by hand does not lose the place in the queue. */
export function syncTo(q: PlayQueue, trackId: string | null): PlayQueue {
  const at = currentIndex(q), n = q.items.length;
  if (trackId === null || !n) return q;
  if (at >= 0 && q.items[at].trackId === trackId) return q;
  for (let k = 1; k <= n; k++) {
    const item = q.items[(at + k + n) % n];
    if (item.trackId === trackId && item.status !== "failed") return { ...q, currentUid: item.uid };
  }
  return q;
}
export const advance = (q: PlayQueue, uid: string): PlayQueue => indexOf(q, uid) < 0 || q.currentUid === uid ? q : { ...q, currentUid: uid };

export function markFailed(q: PlayQueue, uid: string, reason: string): PlayQueue {
  return { ...q, items: q.items.map(i => i.uid === uid ? { ...i, status: "failed", reason, attempts: (i.attempts ?? 0) + 1 } : i) };
}
export function bumpAttempt(q: PlayQueue, uid: string): PlayQueue {
  return { ...q, items: q.items.map(i => i.uid === uid ? { ...i, attempts: (i.attempts ?? 0) + 1 } : i) };
}
/** Gives every failed entry another chance. */
export function retryFailed(q: PlayQueue): PlayQueue {
  if (!q.items.some(i => i.status === "failed" || i.attempts)) return q;
  return { ...q, items: q.items.map(({ status, reason, attempts, ...rest }) => { void status; void reason; void attempts; return rest; }) };
}

/** A queue read back from a saved project: only well-formed entries, a pointer that exists, booleans that are booleans. */
export function readQueue(value: unknown): PlayQueue {
  const raw = (value ?? {}) as Partial<PlayQueue>;
  const items = Array.isArray(raw.items)
    ? raw.items.filter((i): i is QueueItem => !!i && typeof i.uid === "string" && typeof i.trackId === "string")
    : [];
  const seen = new Set<string>();
  const unique = items.filter(i => !seen.has(i.uid) && !!seen.add(i.uid));
  return { items: unique, currentUid: unique.some(i => i.uid === raw.currentUid) ? raw.currentUid ?? null : null, loop: raw.loop === true, smart: raw.smart === true };
}
