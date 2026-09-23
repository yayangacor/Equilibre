import type { BreakRecord, EvaluationRecord, KssRecord, LabelCorrectionRecord, RecommendationRecord } from "./history.ts";

// IndexedDB behind the local history (record types and logic: history.ts). Kept thin:
// Vitest runs in Node without IndexedDB, so this file is checked in a real browser
// instead (plans/P06, step 2). Every store is keyed by an autoIncrement id and indexed
// by `hari`, and no transaction awaits anything, so none of them closes early.

export const DB_NAME = "equilibre";
const DB_VERSION = 1;
const DAY = "hari";

export type Stores = {
  evaluasi: EvaluationRecord;
  jeda: BreakRecord;
  rekomendasi: RecommendationRecord;
  koreksi_label: LabelCorrectionRecord;
  kss: KssRecord;
};
export type StoreName = keyof Stores;
export const STORE_NAMES: readonly StoreName[] = ["evaluasi", "jeda", "rekomendasi", "koreksi_label", "kss"];

function succeeded<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Transaksi IndexedDB dibatalkan."));
  });
}

export class HistoryDb {
  readonly db: IDBDatabase;

  constructor(db: IDBDatabase) {
    this.db = db;
    // A newer version opened in another tab: step aside so it can upgrade.
    db.onversionchange = () => db.close();
  }

  // Resolves with the new id once the record is committed.
  async add<S extends StoreName>(store: S, record: Stores[S]): Promise<number> {
    const tx = this.db.transaction(store, "readwrite");
    const [id] = await Promise.all([succeeded(tx.objectStore(store).add(record)), committed(tx)]);
    return id as number;
  }

  // Merges `patch` into the record with this id. null: no such record.
  update<S extends StoreName>(store: S, id: number, patch: Partial<Stores[S]>): Promise<Stores[S] | null> {
    const tx = this.db.transaction(store, "readwrite");
    const objects = tx.objectStore(store);
    let updated: Stores[S] | null = null;
    const current = objects.get(id);
    current.onsuccess = () => {
      if (current.result === undefined) return;
      updated = { ...(current.result as Stores[S]), ...patch, id };
      objects.put(updated);
    };
    return committed(tx).then(() => updated);
  }

  // One day's records in the order they were added.
  byDay<S extends StoreName>(store: S, day: string): Promise<Stores[S][]> {
    const tx = this.db.transaction(store, "readonly");
    return succeeded(tx.objectStore(store).index(DAY).getAll(IDBKeyRange.only(day))) as Promise<Stores[S][]>;
  }

  all<S extends StoreName>(store: S): Promise<Stores[S][]> {
    const tx = this.db.transaction(store, "readonly");
    return succeeded(tx.objectStore(store).getAll()) as Promise<Stores[S][]>;
  }

  // Days with at least one evaluation, oldest first.
  days(): Promise<string[]> {
    const tx = this.db.transaction("evaluasi", "readonly");
    const cursor = tx.objectStore("evaluasi").index(DAY).openKeyCursor(null, "nextunique");
    const days: string[] = [];
    cursor.onsuccess = () => {
      if (!cursor.result) return;
      days.push(String(cursor.result.key));
      cursor.result.continue();
    };
    return committed(tx).then(() => days);
  }

  // Deletes every record filed under a day before `day` (YYYY-MM-DD compares as text).
  // Resolves with how many records went.
  deleteBefore(day: string): Promise<number> {
    const tx = this.db.transaction(STORE_NAMES, "readwrite");
    let deleted = 0;
    for (const name of STORE_NAMES) {
      const cursor = tx.objectStore(name).index(DAY).openCursor(IDBKeyRange.upperBound(day, true));
      cursor.onsuccess = () => {
        if (!cursor.result) return;
        cursor.result.delete();
        deleted++;
        cursor.result.continue();
      };
    }
    return committed(tx).then(() => deleted);
  }

  clear(): Promise<void> {
    const tx = this.db.transaction(STORE_NAMES, "readwrite");
    for (const name of STORE_NAMES) tx.objectStore(name).clear();
    return committed(tx);
  }

  close() {
    this.db.close();
  }
}

// `name` is only changed by the browser check, so it never touches the real history.
export function openHistory(name: string = DB_NAME): Promise<HistoryDb> {
  return new Promise((resolve, reject) => {
    let factory: IDBFactory | undefined;
    try {
      factory = globalThis.indexedDB; // the getter itself can throw when site data is blocked
    } catch {
      factory = undefined;
    }
    if (!factory) {
      reject(new Error("IndexedDB tidak tersedia di browser ini."));
      return;
    }
    const req = factory.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const store of STORE_NAMES) {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store, { keyPath: "id", autoIncrement: true }).createIndex(DAY, DAY);
        }
      }
    };
    req.onsuccess = () => resolve(new HistoryDb(req.result));
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("Riwayat sedang dibuka tab Equilibre versi lama. Tutup tab itu, lalu muat ulang."));
  });
}
