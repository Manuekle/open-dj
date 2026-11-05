import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

/* The app was renamed from Open DJ to Shift, and its IndexedDB database and localStorage keys with it. These tests
   check that a browser holding the old names keeps its projects, tracks, mixes and settings. */

const LEGACY_DB = "open-dj-local-v1";
const DB = "shift-local-v1";
const STORES = ["tracks", "mixes", "projects"] as const;
type Rows = Partial<Record<(typeof STORES)[number], { id: string; [k: string]: unknown }[]>>;

function seed(name: string, rows: Rows): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 2);
    req.onupgradeneeded = () => { for (const s of STORES) req.result.createObjectStore(s, { keyPath: "id" }); };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction([...STORES], "readwrite");
      for (const s of STORES) for (const row of rows[s] ?? []) tx.objectStore(s).put(row);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  });
}
const names = async () => (await indexedDB.databases()).map(d => d.name);
const settle = () => new Promise(r => setTimeout(r, 20));

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  removeItem(k: string) { this.map.delete(k); }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
}

beforeEach(() => {
  vi.resetModules();
  const g = globalThis as unknown as Record<string, unknown>;
  g.indexedDB = new IDBFactory();
  g.window = globalThis;
  g.localStorage = new MemoryStorage();
});

describe("IndexedDB rename", () => {
  it("moves tracks, mixes and projects from the old database, then deletes it", async () => {
    await seed(LEGACY_DB, { projects: [{ id: "p1", name: "Friday set" }], tracks: [{ id: "t1", title: "Copper Hours" }], mixes: [{ id: "m1" }] });
    const storage = await import("./storage");
    expect(await storage.loadProjects()).toEqual([{ id: "p1", name: "Friday set" }]);
    expect(await storage.loadTracks()).toEqual([{ id: "t1", title: "Copper Hours" }]);
    expect(await storage.loadMixes()).toEqual([{ id: "m1" }]);
    await settle();
    expect(await names()).toEqual([DB]);
  });

  it("keeps a row the new database already has", async () => {
    await seed(LEGACY_DB, { projects: [{ id: "p1", name: "Old name" }, { id: "p2", name: "Only in old" }] });
    await seed(DB, { projects: [{ id: "p1", name: "New name" }] });
    const storage = await import("./storage");
    const projects = await storage.loadProjects();
    expect(projects.map(p => [p.id, p.name])).toEqual([["p1", "New name"], ["p2", "Only in old"]]);
  });

  it("does not create the old database when there is none", async () => {
    const storage = await import("./storage");
    expect(await storage.loadProjects()).toEqual([]);
    await settle();
    expect(await names()).toEqual([DB]);
  });

  it("writes go to the new database", async () => {
    const storage = await import("./storage");
    await storage.saveProject({ id: "p9", name: "Saved after rename" } as never);
    expect((await storage.loadProjects()).map(p => p.id)).toEqual(["p9"]);
  });
});

describe("localStorage rename", () => {
  it("moves every open-dj key to the same key under shift and removes the old one", async () => {
    localStorage.setItem("open-dj-project", "p1");
    localStorage.setItem("open-dj.transition-presets", "[]");
    localStorage.setItem("open-dj:song-range:v1:t1", "{\"low\":48}");
    localStorage.setItem("unrelated", "x");
    await import("./legacy-keys");
    expect(localStorage.getItem("shift-project")).toBe("p1");
    expect(localStorage.getItem("shift.transition-presets")).toBe("[]");
    expect(localStorage.getItem("shift:song-range:v1:t1")).toBe("{\"low\":48}");
    expect(localStorage.getItem("open-dj-project")).toBeNull();
    expect(localStorage.getItem("unrelated")).toBe("x");
  });

  it("keeps a value already under the new key", async () => {
    localStorage.setItem("open-dj-project", "old");
    localStorage.setItem("shift-project", "new");
    await import("./legacy-keys");
    expect(localStorage.getItem("shift-project")).toBe("new");
    expect(localStorage.getItem("open-dj-project")).toBeNull();
  });
});
