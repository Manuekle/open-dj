import type { StoredMix, StoredTrack } from "@/lib/types";
const DB_NAME = "open-dj-local-v1";
const VERSION = 1;
function database(): Promise<IDBDatabase> {
  return new Promise((resolve,reject) => {
    if (!("indexedDB" in window)) { reject(new Error("IndexedDB no disponible")); return; }
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("tracks")) db.createObjectStore("tracks",{keyPath:"id"});
      if (!db.objectStoreNames.contains("mixes")) db.createObjectStore("mixes",{keyPath:"id"});
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function query<T>(table: "tracks"|"mixes", method: "getAll"|"put"|"delete"|"clear", value?: unknown): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve,reject) => {
      const transaction = db.transaction(table,method==="getAll"?"readonly":"readwrite");
      const req = method==="getAll" ? transaction.objectStore(table).getAll() :
        method==="clear" ? transaction.objectStore(table).clear() :
        method==="put" ? transaction.objectStore(table).put(value) :
        transaction.objectStore(table).delete(value as IDBValidKey);
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}
export const loadTracks = () => query<StoredTrack[]>("tracks","getAll");
export const saveTrack = (track: StoredTrack) => query<IDBValidKey>("tracks","put",track);
export const removeTrack = (id: string) => query<void>("tracks","delete",id);
export const clearTracks = () => query<void>("tracks","clear");
export const loadMixes = () => query<StoredMix[]>("mixes","getAll");
export const saveMix = (mix: StoredMix) => query<IDBValidKey>("mixes","put",mix);
export const removeMix = (id: string) => query<void>("mixes","delete",id);
