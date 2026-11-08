import { describe, expect, it } from "vitest";
import { DB_VERSION, HistoryDb, STORE_NAMES, upgradeSchema, type SchemaDb, type StoreName } from "./historyDb.ts";

// The history database's schema upgrade (plan P20 W2.7: version 1 → 2 adds "keputusan") and the two whole-database
// operations behind "Delete all history" and the demo seed, on a stand-in for IndexedDB: Vitest runs in Node, which
// has none. The stand-in throws where IndexedDB throws (creating a store that exists), so an upgrade that recreated
// or replaced a store fails here as it would in the browser.

// The stores of version 1, as the code before W2.7 created them. Never renamed or dropped.
const V1_STORES = ["evaluasi", "jeda", "rekomendasi", "koreksi_label", "kss"] as const;

type FakeStore = { records: Map<number, Record<string, unknown>>; indexes: Map<string, string>; nextId: number };

class FakeDb implements SchemaDb {
  readonly stores = new Map<string, FakeStore>();

  readonly objectStoreNames = { contains: (name: string) => this.stores.has(name) };

  createObjectStore(name: string, options: { keyPath: string; autoIncrement: boolean }) {
    if (this.stores.has(name)) throw new DOMException(`Object store ${name} already exists.`, "ConstraintError");
    expect(options).toEqual({ keyPath: "id", autoIncrement: true });
    const store: FakeStore = { records: new Map(), indexes: new Map(), nextId: 1 };
    this.stores.set(name, store);
    return {
      createIndex: (index: string, keyPath: string) => {
        store.indexes.set(index, keyPath);
        return {};
      },
    };
  }

  put(name: string, record: Record<string, unknown>) {
    const store = this.stores.get(name)!;
    const id = store.nextId++;
    store.records.set(id, { ...record, id });
  }

  // Just enough of IDBDatabase.transaction for HistoryDb.clear() and replaceAll(): writes apply at once, the
  // transaction completes on the next tick.
  transaction(names: readonly string[]) {
    const tx: { oncomplete: (() => void) | null; onerror: unknown; onabort: unknown; objectStore: (n: string) => unknown } = {
      oncomplete: null,
      onerror: null,
      onabort: null,
      objectStore: (n: string) => {
        if (!names.includes(n)) throw new DOMException(`${n} is not in this transaction.`, "NotFoundError");
        const store = this.stores.get(n)!;
        return {
          clear: () => store.records.clear(),
          add: (record: Record<string, unknown>) => this.put(n, record),
        };
      },
    };
    setTimeout(() => tx.oncomplete?.(), 0);
    return tx;
  }

  count = (name: string) => this.stores.get(name)?.records.size ?? 0;
}

const asIdb = (db: FakeDb) => db as unknown as IDBDatabase;

function versionOne(): FakeDb {
  const db = new FakeDb();
  for (const name of V1_STORES) db.createObjectStore(name, { keyPath: "id", autoIncrement: true }).createIndex("hari", "hari");
  db.put("evaluasi", { hari: "2026-11-07", t: 1, label: "normal" });
  db.put("evaluasi", { hari: "2026-11-08", t: 2, label: "lelah ringan" });
  db.put("jeda", { hari: "2026-11-08", mulai: 3, selesai: 4, menit: 2 });
  db.put("kss", { hari: "2026-11-08", t: 5, kss: 6 });
  return db;
}

describe("history database schema", () => {
  it("is version 2, with every version 1 store still there and the decision log added", () => {
    expect(DB_VERSION).toBe(2);
    for (const name of V1_STORES) expect(STORE_NAMES).toContain(name);
    expect(STORE_NAMES).toContain("keputusan");
    expect(new Set(STORE_NAMES).size).toBe(STORE_NAMES.length);
  });

  it("upgrading from version 1 creates only keputusan and keeps every existing record (migration)", () => {
    const db = versionOne();
    const before = JSON.stringify([...db.stores].map(([name, s]) => [name, [...s.records]]));
    expect(upgradeSchema(db)).toEqual(["keputusan"]);
    const after = JSON.stringify([...db.stores].filter(([name]) => name !== "keputusan").map(([name, s]) => [name, [...s.records]]));
    expect(after).toBe(before);
    expect(db.count("evaluasi")).toBe(2);
    expect(db.count("jeda")).toBe(1);
    expect(db.count("kss")).toBe(1);
    expect(db.count("keputusan")).toBe(0);
    expect(db.stores.get("keputusan")!.indexes.get("hari")).toBe("hari"); // byDay and the 30-day retention work on it
  });

  it("a fresh database gets every store; a second upgrade changes nothing", () => {
    const db = new FakeDb();
    expect(upgradeSchema(db)).toEqual([...STORE_NAMES]);
    for (const name of STORE_NAMES) expect(db.stores.get(name)!.indexes.get("hari")).toBe("hari");
    expect(upgradeSchema(db)).toEqual([]);
  });

  it("the stand-in refuses to recreate a store, as IndexedDB does (control for the migration test)", () => {
    const db = versionOne();
    expect(() => db.createObjectStore("evaluasi", { keyPath: "id", autoIncrement: true })).toThrow(/already exists/);
  });
});

describe("whole-database operations include the decision log", () => {
  function filled(): FakeDb {
    const db = versionOne();
    upgradeSchema(db);
    db.put("keputusan", { hari: "2026-11-08", t: 6, fase: "biasa" });
    return db;
  }

  it('"Delete all history" empties every store, the decision log too', async () => {
    const db = filled();
    expect(db.count("keputusan")).toBe(1);
    await new HistoryDb(asIdb(db)).clear();
    for (const name of STORE_NAMES) expect(db.count(name as StoreName)).toBe(0);
  });

  it("the demo seed leaves the decision log empty when it has none to write", async () => {
    const db = filled();
    await new HistoryDb(asIdb(db)).replaceAll({ evaluasi: [{ hari: "2026-11-08" } as never] });
    expect(db.count("evaluasi")).toBe(1);
    expect(db.count("keputusan")).toBe(0);
    expect(db.count("jeda")).toBe(0);
  });
});
