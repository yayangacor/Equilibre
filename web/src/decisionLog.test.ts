import { describe, expect, it } from "vitest";
import { demoTasks } from "./demoAccount.ts";
import {
  DECISION_KEYS,
  DecisionLog,
  labelDays,
  labelOutcome,
  openOutcome,
  OUTCOME,
  toDecisionRecord,
  type DecisionRecord,
  type DecisionStore,
} from "./decisionLog.ts";
import type { ImportedTask } from "./googleTasks.ts";
import { dayKey, toExport, type DayData, type EvaluationRecord } from "./history.ts";
import { offlinePlan, toRencanaRequest } from "./rencana.ts";
import type { Label } from "./rules.ts";
import { emptyTagMemory } from "./taskTagger.ts";
import { SUBMISSION_KEYS } from "./userTest.ts";

// The local decision log of "Plan my next hour" (plan P20 W2.7): the record's shape (no title, list name or task id),
// the outcomes (label 30 minutes later, the task no longer open at a refresh within 60 minutes, the answers), and that
// it is in the export and, after consent, in the user test submission (NOTES D-105).

const TODAY = "2026-11-10";
const at = (h: number, min = 0, s = 0) => new Date(2026, 10, 10, h, min, s).getTime();
const MIN = 60_000;

const google = (id: string, title: string, order: number, due: string | null = null): ImportedTask => ({
  id,
  listId: "LIST-Zx81-secret",
  listTitle: "Client Falcon (private)",
  title,
  due,
  parent: null,
  order,
});
const REAL = [
  google("GT-aa11", "Write the Falcon pitch for Budi", 0, TODAY),
  google("GT-bb22", "Reconcile invoices for PT Sinar", 1),
  google("GT-cc33", "Call Dewi about the audit", 2, "2026-11-12"),
];

function planFor(tasks: readonly ImportedTask[], t = at(14, 10)) {
  const req = toRencanaRequest({ fase: "rendah ringan", jam_rawan: true }, 45, tasks, TODAY, emptyTagMemory());
  const plan = offlinePlan(req, "offline");
  return { req, plan, record: toDecisionRecord(req.body, plan, { t, sesi: 42 }) };
}

// An in-memory DecisionStore: the history database's keputusan and evaluasi stores.
class MemoryStore implements DecisionStore {
  readonly rows = new Map<number, DecisionRecord>();
  readonly evals: Pick<EvaluationRecord, "t" | "hari" | "label" | "dinilai">[] = [];
  private next = 1;
  failAdd = false;
  async add(record: DecisionRecord) {
    if (this.failAdd) return null;
    const id = this.next++;
    this.rows.set(id, { ...record, id });
    return id;
  }
  async update(id: number, patch: Partial<DecisionRecord>) {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, ...patch, id });
  }
  async all() {
    return [...this.rows.values()];
  }
  async evaluations(day: string) {
    return this.evals.filter((e) => e.hari === day);
  }
  evaluation(t: number, label: Label, dinilai = true) {
    this.evals.push({ t, hari: dayKey(t), label, dinilai });
  }
}

describe("decision record", () => {
  it("holds the features as sent, the choice and empty outcomes, keyed only by DECISION_KEYS", () => {
    const { req, plan, record } = planFor(REAL);
    expect(record).toMatchObject({
      hari: TODAY,
      sesi: 42,
      t: at(14, 10),
      fase: "rendah ringan",
      jam_rawan: true,
      menit_sejak_jeda: 45,
      tugas: req.body.tugas,
      tugas_id: plan.tugas_id,
      kode: plan.kode,
      asal: "offline",
      model: null,
      cocok: null,
      t_selesai: null,
      label_30: null,
      t_cek_30: null,
      tidak_terbuka_60: null,
    });
    expect(plan.tugas_id).not.toBeNull();
    for (const key of Object.keys(record)) expect(DECISION_KEYS).toContain(key);
    for (const task of record.tugas) expect(Object.keys(task).sort()).toEqual(["beban", "hari_ke_tenggat", "id", "posisi", "sifat"]);
  });

  it("never holds a title, a list name or a task id, even when the body carries extra fields (negative control)", () => {
    for (const tasks of [REAL, demoTasks("rina", TODAY)]) {
      const { req, plan } = planFor(tasks);
      // Something upstream slipping a title into the body must not reach the record either; the plan itself carries
      // the chosen title (judul) and sentences naming it (langkah), and only its choice may be taken.
      const leaky = { ...req.body, judul: "LEAK", tugas: req.body.tugas.map((t, i) => ({ ...t, judul: tasks[i].title, google: tasks[i].id })) };
      const record = toDecisionRecord(leaky, plan, { t: 1, sesi: 1 });
      const out = JSON.stringify(record);
      for (const s of tasks.flatMap((t) => [t.title, t.listTitle, t.id, t.listId])) expect(out).not.toContain(s);
      expect(out).not.toContain("LEAK");
      // Positive control: the plan on the laptop does name the chosen task.
      expect(JSON.stringify(plan)).toContain(tasks.find((t) => `t${t.order + 1}` === plan.tugas_id)!.title);
    }
  });
});

describe("outcome: the label 30 minutes later", () => {
  const t = at(14, 10);

  it("is the first evaluation 30–35 minutes after the plan, judged or carried over", () => {
    const evals = [
      { t: t + 29 * MIN, label: "lelah" as Label, dinilai: true },
      { t: t + 31 * MIN, label: "lelah ringan" as Label, dinilai: false },
      { t: t + 30 * MIN + 10_000, label: "normal" as Label, dinilai: true },
    ];
    expect(labelOutcome(t, evals, t + 32 * MIN)).toEqual({ label_30: "normal", dinilai_30: true, t_cek_30: t + 32 * MIN });
    expect(labelOutcome(t, [evals[1]], t + 40 * MIN)).toEqual({ label_30: "lelah ringan", dinilai_30: false, t_cek_30: t + 40 * MIN });
  });

  it("waits while the window is open and empty, then is null for good (camera off, tab closed)", () => {
    const before = [{ t: t + 29 * MIN, label: "lelah" as Label, dinilai: true }];
    expect(labelOutcome(t, before, t + 33 * MIN)).toBeNull();
    const after = t + (OUTCOME.labelAfterMinutes + OUTCOME.labelWindowMinutes) * MIN;
    expect(labelOutcome(t, before, after)).toEqual({ label_30: null, dinilai_30: null, t_cek_30: after });
  });

  it("reads the next day too for a plan just before midnight", () => {
    expect(labelDays(at(23, 40))).toEqual(["2026-11-11"]);
    expect(labelDays(at(23, 27))).toEqual(["2026-11-10", "2026-11-11"]);
    expect(labelDays(t)).toEqual([TODAY]);
  });
});

describe("outcome: the chosen task no longer open at a refresh within 60 minutes", () => {
  const t = at(14, 10);
  const open = (...ids: string[]) => new Set(ids);

  it("true when the refresh no longer lists it, false while it does, unchanged outside the 60 minutes", () => {
    expect(openOutcome(null, "GT-aa11", open("GT-aa11", "GT-bb22"), t, t + 20 * MIN)).toBe(false);
    expect(openOutcome(false, "GT-aa11", open("GT-bb22"), t, t + 50 * MIN)).toBe(true);
    expect(openOutcome(true, "GT-aa11", open("GT-aa11"), t, t + 55 * MIN)).toBe(true); // once closed, stays closed
    expect(openOutcome(null, "GT-aa11", open(), t, t + 61 * MIN)).toBeNull();
    expect(openOutcome(false, "GT-aa11", open(), t, t + 61 * MIN)).toBe(false);
    expect(openOutcome(null, "GT-aa11", open(), t, t - MIN)).toBeNull();
  });
});

describe("the decision log over a store", () => {
  it("stores a plan, then the answers: a second tap changes it, and I finished it", async () => {
    const store = new MemoryStore();
    const log = new DecisionLog(store);
    const { record } = planFor(REAL);
    const id = (await log.planned(record, "GT-aa11"))!;
    await log.answered(id, false, at(14, 11));
    await log.answered(id, true, at(14, 12));
    await log.taskDone(id, at(14, 40));
    expect(store.rows.get(id)).toMatchObject({ cocok: true, t_cocok: at(14, 12), t_selesai: at(14, 40) });
    store.failAdd = true;
    expect(await log.planned(record, "GT-aa11")).toBeNull();
  });

  it("fills tidak_terbuka_60 from Google Tasks reads in memory; sample tasks and other plans stay null", async () => {
    const store = new MemoryStore();
    const log = new DecisionLog(store);
    const t = at(14, 10);
    const real = (await log.planned(planFor(REAL, t).record, "GT-aa11"))!;
    const sample = (await log.planned(planFor(demoTasks("rina", TODAY), t).record, null))!;
    await log.tasksRefreshed(new Set(["GT-aa11", "GT-bb22"]), t + 10 * MIN);
    expect(store.rows.get(real)!.tidak_terbuka_60).toBe(false);
    await log.tasksRefreshed(new Set(["GT-bb22"]), t + 45 * MIN);
    expect(store.rows.get(real)!.tidak_terbuka_60).toBe(true);
    expect(store.rows.get(sample)!.tidak_terbuka_60).toBeNull();

    // After 60 minutes nothing changes, and a forgotten log (Delete all history) watches nothing.
    const late = (await log.planned(planFor(REAL, t + 5 * MIN).record, "GT-bb22"))!;
    await log.tasksRefreshed(new Set(), t + 5 * MIN + 61 * MIN);
    expect(store.rows.get(late)!.tidak_terbuka_60).toBeNull();
    const later = (await log.planned(planFor(REAL, t + 70 * MIN).record, "GT-cc33"))!;
    log.forget();
    await log.tasksRefreshed(new Set(), t + 80 * MIN);
    expect(store.rows.get(later)!.tidak_terbuka_60).toBeNull();
  });

  it("forgets the watched task on a disconnect: another account's list never marks it closed (review A, 8 Nov)", async () => {
    const store = new MemoryStore();
    const log = new DecisionLog(store);
    const t = at(14, 10);
    const planA = (await log.planned(planFor(REAL, t).record, "GT-aa11"))!;
    await log.googleTasksChanged(null, t + MIN); // Disconnect account A
    await log.googleTasksChanged(new Set(["GT-zz99"]), t + 5 * MIN); // account B's list
    expect(store.rows.get(planA)!.tidak_terbuka_60).toBeNull();

    // Positive control: a read while still connected does fill it.
    const planB = (await log.planned(planFor(REAL, t + 6 * MIN).record, "GT-zz99"))!;
    await log.googleTasksChanged(new Set(), t + 10 * MIN);
    expect(store.rows.get(planB)!.tidak_terbuka_60).toBe(true);
  });

  it("forgets the watched task on a new grant from the Google window: Refresh may have switched accounts (review, 8 Nov)", async () => {
    const store = new MemoryStore();
    const log = new DecisionLog(store);
    const t = at(14, 10);
    const planA = (await log.planned(planFor(REAL, t).record, "GT-aa11"))!;
    // Refresh with an expiring token opens the Google window; account B is picked, no disconnect in between.
    await log.googleTasksChanged(new Set(["GT-zz99"]), t + 5 * MIN, true);
    await log.googleTasksChanged(new Set(["GT-zz99"]), t + 10 * MIN); // a plain Refresh afterwards
    expect(store.rows.get(planA)!.tidak_terbuka_60).toBeNull();

    // Positive control: the same list from a plain Refresh (the token still valid) marks it closed.
    const planB = (await log.planned(planFor(REAL, t + 11 * MIN).record, "GT-aa11"))!;
    await log.googleTasksChanged(new Set(["GT-zz99"]), t + 15 * MIN);
    expect(store.rows.get(planB)!.tidak_terbuka_60).toBe(true);
  });

  it("fills label_30 from the history, for plans of earlier sessions too, once each", async () => {
    const store = new MemoryStore();
    const log = new DecisionLog(store);
    const t = at(14, 10);
    const seen = (await log.planned(planFor(REAL, t).record, null))!;
    const unseen = (await log.planned(planFor(REAL, t + MIN).record, null))!;
    const fresh = (await log.planned(planFor(REAL, t + 20 * MIN).record, null))!;
    store.evaluation(t + 30 * MIN + 5_000, "lelah ringan");

    expect(await log.fillLabels(t + 29 * MIN)).toBe(0); // too early for all
    expect(await log.fillLabels(t + 33 * MIN)).toBe(1); // seen; unseen's window is still open
    expect(store.rows.get(seen)).toMatchObject({ label_30: "lelah ringan", dinilai_30: true, t_cek_30: t + 33 * MIN });
    expect(store.rows.get(unseen)!.t_cek_30).toBeNull();

    expect(await log.fillLabels(t + 40 * MIN)).toBe(1); // unseen: the window passed empty
    expect(store.rows.get(unseen)).toMatchObject({ label_30: null, dinilai_30: null, t_cek_30: t + 40 * MIN });
    expect(store.rows.get(fresh)!.t_cek_30).toBeNull();
    expect(await log.fillLabels(t + 41 * MIN)).toBe(0); // nothing is looked up twice
  });
});

describe("export and the user test", () => {
  it('"Download history (JSON)" carries the decision log next to the history', () => {
    const empty: DayData = { evaluasi: [], jeda: [], rekomendasi: [], koreksi_label: [], kss: [] };
    const { record } = planFor(REAL);
    const file = toExport(empty, at(15, 0), [record]);
    expect(file.keputusan).toEqual([record]);
    expect(file.evaluasi).toEqual([]);
    expect(toExport(empty, at(15, 0)).keputusan).toEqual([]);
  });

  it("a ?kode= user test submission carries it after consent (NOTES D-105; the fields and the window: userTest.test.ts)", () => {
    expect(SUBMISSION_KEYS as readonly string[]).toContain("keputusan");
  });
});
