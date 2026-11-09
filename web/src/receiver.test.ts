import { describe, expect, it } from "vitest";
import code from "../../uji-pengguna/Code.gs?raw";
import { toDecisionRecord, type DecisionRecord } from "./decisionLog.ts";
import type { ImportedTask } from "./googleTasks.ts";
import type { EvaluationRecord, KssRecord } from "./history.ts";
import { offlinePlan, RENCANA_LIMITS, toRencanaRequest } from "./rencana.ts";
import { emptyTagMemory } from "./taskTagger.ts";
import {
  calibrated,
  checkFeedback,
  checkIntake,
  consent,
  DECISIONS_MAX,
  finish,
  freshState,
  TEST_MINUTES,
  toSubmission,
  withSubmissionId,
  type Submission,
  type TestRecords,
} from "./userTest.ts";

// The Apps Script receiver of the user test (uji-pengguna/Code.gs) run here over a fake spreadsheet, with a
// submission built by the app's own toSubmission: the plans of "Plan my next hour" (NOTES D-105) land in their own
// sheets, a submission of an earlier app without them is still stored, hapusKode removes them, and the size cap keeps
// a full test under the receiver's limit. Nothing here touches the network or the real Sheet; the deployed receiver
// is the user's check (uji-pengguna/README.md, "Memperbarui penerima").

type Cell = unknown;

class FakeSheet {
  readonly name: string;
  rows: Cell[][] = [];
  constructor(name: string) {
    this.name = name;
  }
  getName() {
    return this.name;
  }
  getLastRow() {
    return this.rows.length;
  }
  getLastColumn() {
    return Math.max(0, ...this.rows.map((r) => r.length));
  }
  getRange(row: number, col: number, numRows = 1, numCols = 1) {
    return new FakeRange(this, row, col, numRows, numCols);
  }
  setFrozenRows() {}
  deleteRow(row: number) {
    this.rows.splice(row - 1, 1);
  }
  // Data rows as objects under the title row.
  table(): Record<string, Cell>[] {
    const [head, ...rest] = this.rows;
    return rest.map((r) => Object.fromEntries(head.map((h, i) => [String(h), r[i]])));
  }
}

class FakeRange {
  private readonly sheet: FakeSheet;
  private readonly row: number;
  private readonly col: number;
  private readonly numRows: number;
  private readonly numCols: number;
  constructor(sheet: FakeSheet, row: number, col: number, numRows: number, numCols: number) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows;
    this.numCols = numCols;
  }
  getValues(): Cell[][] {
    return Array.from({ length: this.numRows }, (_, i) =>
      Array.from({ length: this.numCols }, (_, j) => this.sheet.rows[this.row - 1 + i]?.[this.col - 1 + j] ?? ""),
    );
  }
  // As Apps Script: the data must fill the range exactly.
  setValues(values: Cell[][]) {
    if (values.length !== this.numRows || values.some((r) => r.length !== this.numCols)) {
      throw new Error("The number of columns in the data does not match the number of columns in the range.");
    }
    values.forEach((r, i) => {
      const target = (this.sheet.rows[this.row - 1 + i] ??= []);
      r.forEach((v, j) => (target[this.col - 1 + j] = v));
    });
    return this;
  }
  setValue(v: Cell) {
    return this.setValues([[v]]);
  }
  setFontWeight() {
    return this;
  }
}

class FakeSpreadsheet {
  readonly sheets = new Map<string, FakeSheet>();
  getName() {
    return "Equilibre — hasil uji (fake)";
  }
  getSheets() {
    return [...this.sheets.values()];
  }
  getSheetByName(name: string) {
    return this.sheets.get(name) ?? null;
  }
  insertSheet(name: string) {
    const sh = new FakeSheet(name);
    this.sheets.set(name, sh);
    return sh;
  }
  sheet(name: string) {
    const sh = this.sheets.get(name);
    if (!sh) throw new Error(`no sheet ${name}`);
    return sh;
  }
}

type Receiver = {
  doPost(e: { postData: { contents: string } }): { text: string };
  hapusKode(kode: string): void;
  HEADERS: Record<string, string[]>;
  MAX_CHARS: number;
};

function receiver(codes: string[] = ["EQ-7K2M"]) {
  const ss = new FakeSpreadsheet();
  const kode = ss.insertSheet("kode");
  kode.rows = [["kode", "aktif", "link", "catatan"], ...codes.map((c) => [c, true, "", ""])];
  const globals = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    ContentService: {
      createTextOutput: (text: string) => ({ text, setMimeType: () => ({ text }) }),
      MimeType: { JSON: "json" },
    },
    Utilities: { getUuid: () => "00000000-0000-4000-8000-000000000000" },
    Logger: { log: () => {} },
  };
  const load = new Function(...Object.keys(globals), `${code}\nreturn { doPost, hapusKode, HEADERS, MAX_CHARS };`);
  const api = load(...Object.values(globals)) as Receiver;
  const post = (body: unknown) =>
    JSON.parse(api.doPost({ postData: { contents: typeof body === "string" ? body : JSON.stringify(body) } }).text) as Record<string, unknown>;
  return { ss, api, post };
}

const MIN = 60_000;
const ID = "3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90";
const START = Date.UTC(2026, 10, 10, 2, 0, 0);
const done = withSubmissionId(
  finish(calibrated(consent(freshState("EQ-7K2M"), checkIntake({}, "7"), START - 7 * MIN), START), START + TEST_MINUTES * MIN),
  () => ID,
);
const feedback = checkFeedback(
  { label_sesuai: 4, alarm_palsu: "1-2 kali", kantuk_terlewat: "tidak mengantuk", mengganggu: 2, manfaat: 4, mau_pakai: 4 },
  "",
)!;
const context = { perangkat: { browser: "Chrome 140", os: "Windows", kamera: "640x480", fps_rata: 9.8 }, baseline: null, now: START + 62 * MIN };

const task = (i: number): ImportedTask => ({
  id: `GT-${String(i).padStart(4, "0")}-secret-google-id`,
  listId: "LIST-Zx81-secret",
  listTitle: "Client Falcon (private)",
  title: `Write the confidential Falcon report part ${i} for Budi at PT Sinar Jaya`,
  due: i % 3 === 0 ? "2026-11-12" : null,
  parent: null,
  order: i,
});
const TASKS = [task(0), task(1), task(2)];

function plan(t: number, tasks: readonly ImportedTask[] = TASKS): DecisionRecord {
  const req = toRencanaRequest({ fase: "rendah ringan", jam_rawan: true }, 45, tasks, "2026-11-10", emptyTagMemory());
  return { ...toDecisionRecord(req.body, offlinePlan(req, "offline"), { t, sesi: 5 }), id: 1, cocok: false, t_cocok: t + MIN };
}

const evaluation = (t: number) =>
  ({
    sesi: 5,
    t,
    label: "lelah ringan",
    label_mentah: "lelah ringan",
    dinilai: true,
    sebab_ditahan: null,
    skor: 3,
    poin: 3,
    tanda: ["perclos_tinggi", "kedip_lambat", "menguap_sering"],
    perclos: 0.123,
    kedip_per_menit: 14.5,
    durasi_kedip_ms: 160,
    mata_tertutup_lama: 1,
    menguap: 2,
    pct_kepala_menunduk: 12.5,
    pct_wajah_hilang: 3.5,
    menit_sejak_jeda: 42,
    menit_lelah_60: 12,
    hemat_daya: false,
  }) as unknown as EvaluationRecord;

function records(keputusan: DecisionRecord[]): TestRecords {
  return {
    evaluasi: [evaluation(START + MIN)],
    kss: [{ sesi: 5, t: START + 15 * MIN, kss: 6, label_tampil: "normal", pengingat: true } as KssRecord],
    koreksi_label: [],
    jeda: [],
    keputusan,
  };
}

describe("the receiver (Code.gs) and the plans in a submission", () => {
  it("stores each plan and each of its tasks, the count in kiriman, and extends an older kiriman title row", () => {
    const { ss, api, post } = receiver();
    const oldTitles = api.HEADERS.kiriman.slice(0, -1); // the Sheet as the uji-2 receiver left it
    const kiriman = ss.insertSheet("kiriman");
    kiriman.rows = [oldTitles, oldTitles.map(() => "old row")];

    const plans = [plan(START + 5 * MIN), plan(START + 40 * MIN)];
    const sub = toSubmission(done, feedback, records(plans), context);
    expect(post(sub)).toEqual({ ok: true, id: ID, duplikat: false });

    expect(kiriman.rows[0]).toEqual(api.HEADERS.kiriman);
    expect(api.HEADERS.kiriman.at(-1)).toBe("n_keputusan");
    expect(kiriman.table()[1]).toMatchObject({ id: ID, kode: "EQ-7K2M", n_evaluasi: 1, n_kss: 1, n_keputusan: 2, manfaat: 4 });

    const rows = ss.sheet("keputusan").table();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id_kiriman: ID,
      kode: "EQ-7K2M", // the test code, which hapusKode looks for
      sesi: 5,
      t: START + 5 * MIN,
      fase: "rendah ringan",
      jam_rawan: true,
      menit_sejak_jeda: 45,
      n_tugas: 3,
      tugas_id: sub.keputusan[0].tugas_id,
      kode_alasan: sub.keputusan[0].kode.join(" "),
      asal: "offline",
      model: "",
      cocok: false,
      t_cocok: START + 6 * MIN,
      t_selesai: "",
      label_30: "",
      tidak_terbuka_60: "",
    });
    expect(rows[0].waktu).toEqual(new Date(START + 5 * MIN));

    const tasks = ss.sheet("keputusan_tugas").table();
    expect(tasks).toHaveLength(6);
    expect(tasks.slice(0, 3).map((r) => r.tugas)).toEqual(["t1", "t2", "t3"]);
    expect(tasks.filter((r) => r.terpilih === true).map((r) => [r.t, r.tugas])).toEqual(
      sub.keputusan.map((k) => [k.t, k.tugas_id]),
    );
    expect(ss.sheet("keputusan").rows[0]).toEqual(api.HEADERS.keputusan);
    expect(ss.sheet("keputusan_tugas").rows[0]).toEqual(api.HEADERS.keputusan_tugas);

    // What the Sheet holds of the tasks: no title, list name or Google id anywhere.
    const sheet = JSON.stringify([...ss.sheets.values()].map((s) => s.rows));
    for (const s of TASKS.flatMap((x) => [x.title, x.listTitle, x.id, x.listId])) expect(sheet).not.toContain(s);
  });

  it("still stores a submission of an earlier app that has no plans (uji-2), with n_keputusan empty", () => {
    const { ss, post } = receiver();
    const { keputusan: _, ...older } = toSubmission(done, feedback, records([plan(START + 5 * MIN)]), context);
    expect(post({ ...older, app: "uji-2" })).toMatchObject({ ok: true });
    expect(ss.sheet("kiriman").table()[0]).toMatchObject({ app: "uji-2", n_evaluasi: 1, n_keputusan: "" });
    expect(ss.sheet("evaluasi").table()).toHaveLength(1);
    expect(ss.getSheetByName("keputusan")).toBeNull();
    // Negative control: a part the receiver does require is still refused.
    const { evaluasi: __, ...broken } = older;
    expect(receiver().post({ ...broken, id_kiriman: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d" })).toEqual({ ok: false, error: "Bagian evaluasi tidak ada." });
  });

  it("hapusKode removes the plans and their tasks with the rest of the code's rows", () => {
    const { ss, api, post } = receiver(["EQ-7K2M", "EQ-OTHR"]);
    post(toSubmission(done, feedback, records([plan(START + 5 * MIN)]), context));
    const other = withSubmissionId(
      finish(calibrated(consent(freshState("EQ-OTHR"), checkIntake({}, ""), START - 7 * MIN), START), START + TEST_MINUTES * MIN),
      () => "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    );
    post(toSubmission(other, feedback, records([plan(START + 9 * MIN)]), context));
    expect(ss.sheet("keputusan").table()).toHaveLength(2);

    api.hapusKode("EQ-7K2M");
    for (const name of ["kiriman", "evaluasi", "kss", "keputusan", "keputusan_tugas"]) {
      const kodes = ss.sheet(name).table().map((r) => r.kode);
      expect(kodes.length, name).toBeGreaterThan(0);
      expect(new Set(kodes), name).toEqual(new Set(["EQ-OTHR"]));
    }
  });

  it("keeps a full test with plans tapped every 30 s under the receiver's limit; uncapped, it would be refused", () => {
    const { ss, api, post } = receiver();
    const many = [...Array(RENCANA_LIMITS.tugasMax).keys()].map(task);
    const plans = Array.from({ length: 2 * TEST_MINUTES }, (_, i) => plan(START + i * 30_000, many));
    const evals = Array.from({ length: TEST_MINUTES * 6 + 1 }, (_, i) => evaluation(START + i * 10_000));
    const sub: Submission = toSubmission(done, feedback, { ...records(plans), evaluasi: evals }, context);
    expect(sub.keputusan).toHaveLength(DECISIONS_MAX);
    const size = JSON.stringify(sub).length;
    expect(size).toBeLessThan(api.MAX_CHARS / 3);
    expect(post(sub)).toMatchObject({ ok: true });
    expect(ss.sheet("keputusan").table()).toHaveLength(DECISIONS_MAX);
    expect(ss.sheet("keputusan_tugas").table()).toHaveLength(DECISIONS_MAX * RENCANA_LIMITS.tugasMax);

    // Without the cap (a plan every 3 s), the whole submission, history and feedback too, would be refused.
    const uncapped = { ...sub, id_kiriman: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d", keputusan: Array.from({ length: 1200 }, (_, i) => sub.keputusan[i % DECISIONS_MAX]) };
    expect(JSON.stringify(uncapped).length).toBeGreaterThan(api.MAX_CHARS);
    expect(receiver().post(uncapped)).toEqual({ ok: false, error: "Kiriman kosong atau terlalu besar." });
  });
});
