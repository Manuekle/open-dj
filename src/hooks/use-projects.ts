"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DJ } from "@/hooks/use-dj";
import { loadProjects, removeProject, saveProject } from "@/lib/storage";
import { makeDeck, type Project, type Session, type StoredMix, type StoredTrack, type Track } from "@/lib/types";
import { toast } from "@/components/sodium/ui/toast";

/* Projects: each set the DJ works on keeps its own tracks and the whole session (decks, mixer, plans, hot cues), saved
   as it changes. IndexedDB takes every change within a second; /api/backup mirrors projects and their tracks to disk
   every few seconds and once more as the tab closes, so a cleared browser or a crash loses at most that much. */

const LAST_KEY = "open-dj-project";
const SAVE_MS = 1000;
const BACKUP_MS = 4000;
export type SaveState = "idle" | "saving" | "saved" | "failed";

const emptySession = (): Session => ({ decks: { A: makeDeck(), B: makeDeck() }, cross: 0, master: 0.9, activeDeck: "A", autoMix: false, plans: {}, cues: {}, selectedTrackId: null });
const makeProject = (name: string, trackIds: string[] = [], id: string = crypto.randomUUID()): Project => ({ id, name, createdAt: Date.now(), updatedAt: Date.now(), trackIds, session: null });
/** The project a library from before projects becomes. A fixed id, so two tabs opening at once make one, not two. */
const FIRST_ID = "00000000-0000-4000-8000-000000000001";
const unique = (ids: string[]) => [...new Set(ids)];

type TrackMeta = Omit<StoredTrack, "blob" | "cover" | "stems"> & { blobType: string; coverType?: string };
function metaOf({ url, coverUrl, stemsUrl, blob, cover, stems, ...meta }: Track): TrackMeta {
  void url; void coverUrl; void stemsUrl; void stems;
  return { ...meta, blobType: blob.type, coverType: cover?.type };
}
async function upload(id: string, part: string, body: BodyInit) {
  const res = await fetch(`/api/backup?track=${id}&part=${part}`, { method: "PUT", body });
  if (!res.ok) throw new Error(`Backup of ${part} failed`);
}
async function uploadMix(id: string, part: string, body: BodyInit) {
  const res = await fetch(`/api/backup?mix=${id}&part=${part}`, { method: "PUT", body });
  if (!res.ok) throw new Error(`Backup of the recording ${part} failed`);
}
async function downloadMix(id: string): Promise<StoredMix | null> {
  try {
    const meta = await fetch(`/api/backup?mix=${id}&part=meta`).then(r => { if (!r.ok) throw new Error("meta"); return r.json(); }) as Omit<StoredMix, "blob"> & { blobType: string };
    const audio = await fetch(`/api/backup?mix=${id}&part=audio`).then(r => { if (!r.ok) throw new Error("audio"); return r.arrayBuffer(); });
    const { blobType, ...mix } = meta;
    return { ...mix, blob: new Blob([audio], { type: blobType }) };
  } catch { return null; }
}
async function download(id: string, parts: string[]): Promise<StoredTrack | null> {
  try {
    const get = (part: string) => fetch(`/api/backup?track=${id}&part=${part}`).then(r => { if (!r.ok) throw new Error(part); return r; });
    const meta = await (await get("meta")).json() as TrackMeta;
    const { blobType, coverType, ...stored } = meta;
    const blob = new Blob([await (await get("audio")).arrayBuffer()], { type: blobType });
    const stems = parts.includes("stems") ? new Blob([await (await get("stems")).arrayBuffer()], { type: "audio/flac" }) : undefined;
    const cover = parts.includes("cover") ? new Blob([await (await get("cover")).arrayBuffer()], { type: coverType }) : undefined;
    return { ...stored, blob, stems, cover };
  } catch { return null; }
}

export function useProjects(dj: DJ) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [backup, setBackup] = useState<boolean | null>(null);
  const [backedUpAt, setBackedUpAt] = useState<number | null>(null);
  /** Track ids the projects already account for; any other track in the library was added to the open project. */
  const [known, setKnown] = useState<Set<string> | null>(null);

  const djRef = useRef(dj), projectsRef = useRef(projects), currentRef = useRef(currentId), knownRef = useRef(known), backupRef = useRef(backup);
  useEffect(() => { djRef.current = dj; projectsRef.current = projects; currentRef.current = currentId; knownRef.current = known; backupRef.current = backup; });
  const opened = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const lastSaved = useRef("");
  const lastBackup = useRef(0);
  const backupTimer = useRef<number | null>(null);
  /** What the disk backup holds of each track, so each part is sent once. */
  const onDisk = useRef<Record<string, string[]>>({});
  const syncing = useRef(false);
  /** The meta JSON last sent for each track this session. */
  const metaSent = useRef<Record<string, string>>({});
  /** Recordings the disk backup holds (both parts), and whether one is being sent. */
  const mixesOnDisk = useRef<Set<string>>(new Set());
  const sendingMixes = useRef(false);

  const fresh = known ? dj.tracks.filter(t => !known.has(t.id)).map(t => t.id) : [];
  const current = projects.find(p => p.id === currentId) ?? null;
  const trackIds = current ? new Set([...fresh, ...current.trackIds]) : null;
  const tracks = trackIds ? dj.tracks.filter(t => trackIds.has(t.id)) : dj.tracks;

  /** The open project as it stands now, with the tracks added since it opened and without deleted ones. */
  const build = useCallback((): Project | null => {
    const d = djRef.current, list = projectsRef.current, id = currentRef.current, seen = knownRef.current;
    const p = list.find(x => x.id === id);
    if (!p || !seen) return null;
    const added = d.tracks.filter(t => !seen.has(t.id)).map(t => t.id);
    const ids = unique([...added, ...p.trackIds]).filter(tid => d.tracks.some(t => t.id === tid));
    return { ...p, trackIds: ids, session: d.snapshot() };
  }, []);

  /** Sends each track's missing parts to the disk backup, one track at a time. */
  const syncTracks = useCallback(async (ids: string[]) => {
    if (syncing.current) return;
    syncing.current = true;
    try {
      for (const id of ids) {
        const track = djRef.current.tracks.find(t => t.id === id);
        if (!track) continue;
        const have = onDisk.current[id] ?? [];
        const need = ["audio", ...(track.stems ? ["stems"] : []), ...(track.cover ? ["cover"] : [])].filter(part => !have.includes(part));
        // The meta changes with each analysis or edit, so it goes whenever it differs from the copy last sent.
        const meta = JSON.stringify(metaOf(track));
        if (metaSent.current[id] !== meta) need.unshift("meta");
        for (const part of need) {
          await upload(id, part, part === "meta" ? meta : part === "audio" ? track.blob : part === "stems" ? track.stems! : track.cover!);
          onDisk.current[id] = unique([...(onDisk.current[id] ?? []), part]);
          if (part === "meta") metaSent.current[id] = meta;
        }
      }
    } catch { /* tried again on the next save */ } finally { syncing.current = false; }
  }, []);

  const pushBackup = useCallback(async (project: Project) => {
    lastBackup.current = Date.now();
    try {
      const res = await fetch(`/api/backup?project=${project.id}`, { method: "PUT", body: JSON.stringify(project) });
      if (res.ok) setBackedUpAt(Date.now());
    } catch { return; }
    void syncTracks(project.trackIds);
  }, [syncTracks]);

  /** Saves the open project if anything changed: to IndexedDB now, to the disk backup at most every few seconds. */
  const persist = useCallback(async () => {
    const next = build();
    if (!next) return;
    // The tracks count too: new stems, a cover or edited tags have to reach the backup though the session is unchanged.
    const parts = djRef.current.tracks.filter(t => next.trackIds.includes(t.id))
      .map(t => [t.id, !!t.stems, !!t.cover, t.title, t.artist, t.album, t.analysis, t.rhythm?.version, t.structure?.version, !!t.stemEnergy, t.lyrics?.words.length]);
    // Position advances continuously while a deck plays. Keep the exact position in the project when a real save
    // happens, but ignore it for change detection until playback pauses. Otherwise the playhead schedules a project
    // write every second for the entire track.
    const sessionForChange = next.session ? {
      ...next.session,
      decks: Object.fromEntries(Object.entries(next.session.decks).map(([id, deck]) => [id, deck.playing ? { ...deck, position: 0 } : deck])),
    } : null;
    const signature = JSON.stringify({ n: next.name, t: next.trackIds, s: sessionForChange, p: parts });
    if (signature === lastSaved.current) return;
    lastSaved.current = signature;
    const stamped = { ...next, updatedAt: Date.now() };
    projectsRef.current = projectsRef.current.map(p => p.id === stamped.id ? stamped : p);
    setProjects(projectsRef.current);
    setSaveState("saving");
    try { await saveProject(stamped); setSavedAt(Date.now()); setSaveState("saved"); } catch { setSaveState("failed"); }
    if (!backupRef.current) return;
    const wait = BACKUP_MS - (Date.now() - lastBackup.current);
    if (wait <= 0) void pushBackup(stamped);
    else if (backupTimer.current === null) backupTimer.current = window.setTimeout(() => {
      backupTimer.current = null;
      const latest = projectsRef.current.find(p => p.id === currentRef.current);
      if (latest) void pushBackup(latest);
    }, wait);
  }, [build, pushBackup]);

  // Open: projects from this browser and the disk backup, the newer copy of each; tracks only the backup still has
  // come back into the library; a library from before projects becomes the first one.
  useEffect(() => {
    if (!dj.ready || opened.current) return;
    opened.current = true;
    let alive = true;
    void (async () => {
      const d = djRef.current;
      const local = await loadProjects().catch(() => [] as Project[]);
      let remote: Project[] = [], available = false;
      try {
        const body = await fetch("/api/backup").then(r => r.json()) as { available: boolean; projects: Project[]; tracks: Record<string, string[]>; mixes: Record<string, string[]> };
        setBackup(body.available);
        available = body.available;
        if (body.available) {
          remote = body.projects; onDisk.current = body.tracks;
          const complete = Object.entries(body.mixes ?? {}).filter(([, parts]) => parts.includes("meta") && parts.includes("audio")).map(([id]) => id);
          mixesOnDisk.current = new Set(complete);
          // Recordings this browser lost come back too.
          const missingMixes = complete.filter(id => !d.mixes.some(m => m.id === id));
          const back = (await Promise.all(missingMixes.map(downloadMix))).filter((m): m is StoredMix => !!m);
          if (back.length) await d.adoptMixes(back);
        }
      } catch { setBackup(false); }
      const merged = new Map(local.map(p => [p.id, p]));
      for (const p of remote) {
        const mine = merged.get(p.id);
        if (!mine || p.updatedAt > mine.updatedAt) { merged.set(p.id, p); await saveProject(p).catch(() => {}); }
      }
      if (!alive) return;
      let list = [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
      const have = new Set(d.tracks.map(t => t.id));
      const missing = unique(list.flatMap(p => p.trackIds)).filter(id => !have.has(id) && onDisk.current[id]?.includes("audio"));
      if (missing.length) {
        const restored = (await Promise.all(missing.map(id => download(id, onDisk.current[id])))).filter((t): t is StoredTrack => !!t);
        if (restored.length) { await d.adoptTracks(restored); toast(`Restored ${restored.length} ${restored.length === 1 ? "track" : "tracks"} from the disk backup.`); }
      }
      if (!list.length) {
        const first = makeProject("My first set", d.tracks.map(t => t.id), FIRST_ID);
        list = [first];
        await saveProject(first).catch(() => {});
      }
      if (!alive) return;
      // The backup gets every project and track it is missing or holds an older copy of, so a lost or wiped data
      // folder fills up again from any browser that still has them, not only with the project that is open.
      if (available) {
        const onServer = new Map(remote.map(p => [p.id, p.updatedAt]));
        for (const p of list) {
          if ((onServer.get(p.id) ?? -1) < p.updatedAt) void fetch(`/api/backup?project=${p.id}`, { method: "PUT", body: JSON.stringify(p) }).catch(() => {});
        }
        void syncTracks(unique(list.flatMap(p => p.trackIds)));
      }
      let last: string | null = null;
      try { last = localStorage.getItem(LAST_KEY); } catch { /* private mode */ }
      const open = list.find(p => p.id === last) ?? list[0];
      const seen = new Set([...d.tracks.map(t => t.id), ...missing]);
      projectsRef.current = list; currentRef.current = open.id; knownRef.current = seen;
      setProjects(list); setCurrentId(open.id); setKnown(seen);
      d.restore(open.session ?? emptySession());
      lastSaved.current = "";
    })();
    // Unmounted before it finished (Strict Mode, a hot reload): drop this run and let the next mount open again.
    return () => { alive = false; opened.current = false; };
  }, [dj.ready, syncTracks]);

  // Every render may carry an edit; persist compares a stable signature and ignores live playhead movement while a
  // deck is playing. Pausing records the current position as part of the next real save.
  useEffect(() => {
    if (!known || !currentId || saveTimer.current !== null) return;
    saveTimer.current = window.setTimeout(() => { saveTimer.current = null; void persist(); }, SAVE_MS);
  });

  // A closing tab gets one last save: IndexedDB if it finishes, and the backup through a keepalive request.
  useEffect(() => {
    const flush = () => {
      const next = build();
      if (!next) return;
      const stamped = { ...next, updatedAt: Date.now() };
      void saveProject(stamped).catch(() => {});
      if (backupRef.current) void fetch(`/api/backup?project=${stamped.id}`, { method: "PUT", body: JSON.stringify(stamped), keepalive: true }).catch(() => {});
    };
    const hidden = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hidden);
    return () => { window.removeEventListener("pagehide", flush); document.removeEventListener("visibilitychange", hidden); };
  }, [build]);

  useEffect(() => () => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    if (backupTimer.current !== null) window.clearTimeout(backupTimer.current);
  }, []);

  /** Saves the open project, then opens another and puts its session back. */
  async function open(id: string, list = projectsRef.current) {
    const leaving = build();
    if (leaving) {
      const stamped = { ...leaving, updatedAt: Date.now() };
      list = list.map(p => p.id === stamped.id ? stamped : p);
      await saveProject(stamped).catch(() => {});
      if (backupRef.current) void pushBackup(stamped);
    }
    const target = list.find(p => p.id === id);
    if (!target) return;
    const seen = new Set(djRef.current.tracks.map(t => t.id));
    projectsRef.current = list; currentRef.current = id; knownRef.current = seen;
    setProjects(list); setCurrentId(id); setKnown(seen);
    try { localStorage.setItem(LAST_KEY, id); } catch { /* private mode */ }
    djRef.current.restore(target.session ?? emptySession());
    lastSaved.current = "";
  }
  async function create(name: string) {
    const project = makeProject(name.trim() || "Untitled set");
    await saveProject(project).catch(() => {});
    await open(project.id, [project, ...projectsRef.current]);
  }
  async function rename(id: string, name: string) {
    const list = projectsRef.current.map(p => p.id === id ? { ...p, name: name.trim() || p.name, updatedAt: Date.now() } : p);
    projectsRef.current = list;
    setProjects(list);
    const p = list.find(x => x.id === id);
    if (p) { await saveProject(p).catch(() => {}); if (backupRef.current) void pushBackup(p); }
  }
  /** Removes a track from the open project; a track no other project uses leaves the library and the backup too. */
  async function removeTrack(trackId: string) {
    const id = currentRef.current;
    const list = projectsRef.current.map(p => p.id === id ? { ...p, trackIds: p.trackIds.filter(t => t !== trackId) } : p);
    projectsRef.current = list;
    setProjects(list);
    const elsewhere = list.some(p => p.id !== id && p.trackIds.includes(trackId));
    if (!elsewhere) {
      await djRef.current.deleteTrack(trackId);
      delete onDisk.current[trackId];
      if (backupRef.current) void fetch(`/api/backup?track=${trackId}`, { method: "DELETE" }).catch(() => {});
    } else {
      // Still in another project: it only leaves this one, so it must not count as newly added.
      const seen = new Set(knownRef.current); seen.add(trackId); knownRef.current = seen; setKnown(seen);
    }
    void persist();
  }
  /** Deletes a project and the tracks only it used, then opens the most recent one left. */
  async function remove(id: string) {
    const rest = projectsRef.current.filter(p => p.id !== id);
    if (!rest.length) { toast.fail("Keep at least one project."); return; }
    const gone = projectsRef.current.find(p => p.id === id);
    if (currentRef.current === id) { currentRef.current = null; await open(rest[0].id, rest); }
    projectsRef.current = rest;
    setProjects(rest);
    await removeProject(id).catch(() => {});
    if (backupRef.current) void fetch(`/api/backup?project=${id}`, { method: "DELETE" }).catch(() => {});
    for (const trackId of gone?.trackIds ?? []) {
      if (rest.some(p => p.trackIds.includes(trackId))) continue;
      await djRef.current.deleteTrack(trackId);
      if (backupRef.current) void fetch(`/api/backup?track=${trackId}`, { method: "DELETE" }).catch(() => {});
    }
  }

  // New recordings go to the disk backup as they are saved.
  useEffect(() => {
    if (!backup || sendingMixes.current) return;
    const pending = dj.mixes.filter(m => !mixesOnDisk.current.has(m.id));
    if (!pending.length) return;
    sendingMixes.current = true;
    void (async () => {
      try {
        for (const mix of pending) {
          const { blob, ...meta } = mix;
          await uploadMix(mix.id, "meta", JSON.stringify({ ...meta, blobType: blob.type }));
          await uploadMix(mix.id, "audio", blob);
          mixesOnDisk.current.add(mix.id);
        }
      } catch { /* tried again on the next change */ } finally { sendingMixes.current = false; }
    })();
  }, [backup, dj.mixes]);

  async function removeMix(id: string) {
    await djRef.current.deleteMix(id);
    mixesOnDisk.current.delete(id);
    if (backupRef.current) void fetch(`/api/backup?mix=${id}`, { method: "DELETE" }).catch(() => {});
  }
  /** Deletes every track from every project, this browser and the disk backup, so none comes back on the next open. */
  async function clearLibrary() {
    const ids = djRef.current.tracks.map(t => t.id);
    const list = projectsRef.current.map(p => ({ ...p, trackIds: [], updatedAt: Date.now() }));
    projectsRef.current = list;
    setProjects(list);
    const seen = new Set<string>(); knownRef.current = seen; setKnown(seen);
    for (const p of list) {
      await saveProject(p).catch(() => {});
      if (backupRef.current) await fetch(`/api/backup?project=${p.id}`, { method: "PUT", body: JSON.stringify(p) }).catch(() => {});
    }
    if (backupRef.current) for (const id of ids) await fetch(`/api/backup?track=${id}`, { method: "DELETE" }).catch(() => {});
    onDisk.current = {};
    await djRef.current.clearLibrary();
  }

  return { projects, current, tracks, saveState, savedAt, backup, backedUpAt, open: (id: string) => void open(id), create, rename, remove, removeTrack, removeMix, clearLibrary };
}

export type Projects = ReturnType<typeof useProjects>;
