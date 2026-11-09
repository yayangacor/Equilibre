import { dayKey, type EvaluationRecord, type Stamp } from "./history.ts";
import type { Phase } from "./phase.ts";
import { TUGAS_FIELDS, type Plan, type RencanaBody } from "./rencana.ts";
import type { Label } from "./rules.ts";
import type { ReasonCode } from "./taskMatcher.ts";
import type { AbstractTask } from "./taskTagger.ts";

// Local decision log of "Plan my next hour" (plan P20 W2.7, research report §3.5): one record per plan shown, with what
// the Task Matcher decided from and what came of it, as training data for a later ranker (XGBoost, NOTES D-83). Kept
// in the history database (historyDb.ts store "keputusan"): per account, the ?riwayat= test database, 30 days, in
// "Download history (JSON)", emptied by "Delete all history". Nothing of it is sent: not to the server, and not in a
// ?kode= user test submission (userTest.ts never reads this store; sending it needs the user's decision, NOTES D-01).
//
// The features are the request body field by field, as sent to /api/rencana (or as the offline plan used it): the
// phase, the slump flag, minutes since the last break, and the abstract tasks t1..tn. Never a title, a list name or a
// Google task id (NOTES D-90).
//
// Outcomes the app can observe without a new permission:
//   cocok, t_cocok       "Fits" / "Doesn't fit" on the card; a second tap changes it
//   t_selesai            "I finished it" on the card (W2.5)
//   label_30, dinilai_30 the shown label of the first evaluation 30–35 minutes after the plan, from the local history;
//                        null when none was stored (camera off, tab closed, paused); t_cek_30 says it was looked up
//   tidak_terbuka_60     the chosen task was no longer open at a Google Tasks refresh within 60 minutes. The Google id
//                        it needs lives in memory only, so it stays null after the tab closes, without a refresh in
//                        those 60 minutes, after a disconnect or a new grant from the Google window (the next
//                        account may be another), for the demo's sample tasks, and for plans without a task.
// Readings where the plan is silent (the simpler one each time):
// - "diterima" and "mulai ≤ 30 mnt" (accepted, started within 30 min) are not observable without new input; "Fits"
//   and "I finished it" are the closest the card has, so no separate field. The write permission on Google Tasks
//   (W2.8) is used only to tick a task off from "I finished it", never to read anything more.
// - "no longer open" counts completed and deleted alike (reads list only open tasks). A task ticked off from the card
//   leaves the in-memory list at once but is seen closed only at the next refresh, as one ticked off in Google Tasks.
//   Once seen closed it stays true; a refresh that still lists it gives false.
// - The label 30 minutes later is the shown label, carried over or judged; dinilai_30 tells which.

export type DecisionRecord = Stamp & {
  t: number; // when the plan was shown
  fase: Phase;
  jam_rawan: boolean;
  menit_sejak_jeda: number | null;
  tugas: AbstractTask[];
  tugas_id: string | null; // "t3": the Task Matcher's choice; null for a break or no task
  kode: ReasonCode[];
  asal: Plan["asal"];
  model: string | null;
  cocok: boolean | null;
  t_cocok: number | null;
  t_selesai: number | null;
  label_30: Label | null;
  dinilai_30: boolean | null;
  t_cek_30: number | null; // null: not looked up yet
  tidak_terbuka_60: boolean | null;
};

// Every key a record may have, for the shape check (decisionLog.test.ts).
export const DECISION_KEYS = [
  "id",
  "hari",
  "sesi",
  "t",
  "fase",
  "jam_rawan",
  "menit_sejak_jeda",
  "tugas",
  "tugas_id",
  "kode",
  "asal",
  "model",
  "cocok",
  "t_cocok",
  "t_selesai",
  "label_30",
  "dinilai_30",
  "t_cek_30",
  "tidak_terbuka_60",
] as const satisfies readonly (keyof DecisionRecord)[];

const MINUTE = 60_000;

// ⚠️ The 30 and 60 minutes are the plan's (W2.7); the 5-minute window is a first choice: evaluations come every 10 s,
// so a gap means monitoring was off then.
export const OUTCOME = { labelAfterMinutes: 30, labelWindowMinutes: 5, openWithinMinutes: 60 } as const;

// Every field picked by name, the tasks too: nothing else of the plan (its sentences hold titles) can ride along.
export function toDecisionRecord(body: RencanaBody, plan: Pick<Plan, "tugas_id" | "kode" | "asal" | "model">, context: { t: number; sesi: number }): DecisionRecord {
  return {
    hari: dayKey(context.t),
    sesi: context.sesi,
    t: context.t,
    fase: body.fase,
    jam_rawan: body.jam_rawan,
    menit_sejak_jeda: body.menit_sejak_jeda,
    tugas: body.tugas.map((task) => Object.fromEntries(TUGAS_FIELDS.map((k) => [k, task[k]])) as AbstractTask),
    tugas_id: plan.tugas_id,
    kode: [...plan.kode],
    asal: plan.asal,
    model: plan.model,
    cocok: null,
    t_cocok: null,
    t_selesai: null,
    label_30: null,
    dinilai_30: null,
    t_cek_30: null,
    tidak_terbuka_60: null,
  };
}

export type LabelOutcome = Pick<DecisionRecord, "label_30" | "dinilai_30" | "t_cek_30">;
type Evaluated = Pick<EvaluationRecord, "t" | "label" | "dinilai">;

// The days the 30–35 minute window falls on (two around midnight).
export function labelDays(t: number): string[] {
  const from = t + OUTCOME.labelAfterMinutes * MINUTE;
  return [...new Set([dayKey(from), dayKey(from + OUTCOME.labelWindowMinutes * MINUTE)])];
}

// null: too early to tell. Records are stored in time order, so the first one in the window is final as soon as it
// exists; an empty window is final once it has passed.
export function labelOutcome(t: number, evaluasi: readonly Evaluated[], now: number): LabelOutcome | null {
  const from = t + OUTCOME.labelAfterMinutes * MINUTE;
  const to = from + OUTCOME.labelWindowMinutes * MINUTE;
  const first = evaluasi.filter((r) => r.t >= from && r.t <= to).reduce<Evaluated | null>((a, b) => (a === null || b.t < a.t ? b : a), null);
  if (first) return { label_30: first.label, dinilai_30: first.dinilai, t_cek_30: now };
  if (now < to) return null;
  return { label_30: null, dinilai_30: null, t_cek_30: now };
}

// tidak_terbuka_60 after a Google Tasks refresh at refreshT. Outside the 60 minutes the value stays as it was.
export function openOutcome(prev: boolean | null, googleId: string, open: ReadonlySet<string>, planT: number, refreshT: number): boolean | null {
  if (refreshT < planT || refreshT - planT > OUTCOME.openWithinMinutes * MINUTE) return prev;
  if (prev === true) return true;
  return !open.has(googleId);
}

// ── The log over a store (the history database in the app, a fake in the tests) ──

export type DecisionStore = {
  add(record: DecisionRecord): Promise<number | null>; // null: not stored
  update(id: number, patch: Partial<DecisionRecord>): Promise<void>;
  all(): Promise<DecisionRecord[]>;
  evaluations(day: string): Promise<Evaluated[]>;
};

export class DecisionLog {
  private readonly store: DecisionStore;
  // Record id → the chosen task's Google id, the plan's time and the last value seen. In memory only, never stored.
  private readonly watched = new Map<number, { googleId: string; t: number; value: boolean | null }>();
  private filling = false;

  constructor(store: DecisionStore) {
    this.store = store;
  }

  // googleId: only for a task from Google Tasks; a sample task (?demo=rina) has none to look for.
  async planned(record: DecisionRecord, googleId: string | null): Promise<number | null> {
    const id = await this.store.add(record);
    if (id !== null && googleId !== null && record.tugas_id !== null) this.watched.set(id, { googleId, t: record.t, value: null });
    return id;
  }

  answered(id: number, cocok: boolean, t: number): Promise<void> {
    return this.store.update(id, { cocok, t_cocok: t });
  }

  taskDone(id: number, t: number): Promise<void> {
    return this.store.update(id, { t_selesai: t });
  }

  // Every change of the Google Tasks connection (tasksPanel.ts): open, the task ids of a read while connected; null,
  // a disconnect. A disconnect forgets what is watched, since the next connection may be another account, whose list
  // never holds this one's task: its plans keep tidak_terbuka_60 as it was (null when no read came), never "closed"
  // (review A, 8 Nov). newGrant: the read came with a token from the Google window (Refresh renewing an expiring
  // token opens it too), where another signed-in account can be picked; the token does not say which, so the same.
  async googleTasksChanged(open: ReadonlySet<string> | null, now: number, newGrant = false): Promise<void> {
    if (open === null || newGrant) {
      this.forget();
      return;
    }
    await this.tasksRefreshed(open, now);
  }

  // After every Google Tasks read while connected (not on a disconnect: no list then, not an empty one).
  async tasksRefreshed(open: ReadonlySet<string>, now: number): Promise<void> {
    for (const [id, w] of [...this.watched]) {
      const value = openOutcome(w.value, w.googleId, open, w.t, now);
      if (value !== w.value) {
        w.value = value;
        await this.store.update(id, { tidak_terbuka_60: value });
      }
      if (now - w.t > OUTCOME.openWithinMinutes * MINUTE) this.watched.delete(id);
    }
  }

  // Looks up the label 30 minutes later for every record still waiting; records from earlier sessions too, since the
  // evaluations are in the history. Resolves with how many were filled.
  async fillLabels(now: number): Promise<number> {
    if (this.filling) return 0;
    this.filling = true;
    try {
      const waiting = (await this.store.all()).filter(
        (r) => r.id !== undefined && r.t_cek_30 === null && now >= r.t + OUTCOME.labelAfterMinutes * MINUTE,
      );
      let filled = 0;
      for (const r of waiting) {
        const evaluasi = (await Promise.all(labelDays(r.t).map((day) => this.store.evaluations(day)))).flat();
        const patch = labelOutcome(r.t, evaluasi, now);
        if (patch === null) continue;
        await this.store.update(r.id!, patch);
        filled++;
      }
      return filled;
    } finally {
      this.filling = false;
    }
  }

  // "Delete all history" or a Google Tasks disconnect: nothing left to watch.
  forget() {
    this.watched.clear();
  }
}
