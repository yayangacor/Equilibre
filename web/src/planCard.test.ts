import { describe, expect, it } from "vitest";
import { REASON_TEXT, offlinePlan, toRencanaRequest, type Plan } from "./rencana.ts";
import { demoTasks, SAMPLE_LIST } from "./demoAccount.ts";
import type { ImportedTask } from "./googleTasks.ts";
import type { EvaluationRecord, KssRecord } from "./history.ts";
import { DEFAULT_SLUMP, energyPhase } from "./phase.ts";
import {
  ASK_MAX,
  chooseTasks,
  chosenTask,
  historyDayKeys,
  kindOf,
  phaseInputFrom,
  phaseView,
  planView,
  RUBRIC_CHOICES,
  scopedStore,
  sourceLine,
  tagStores,
  tasksToAsk,
} from "./planCard.ts";
import type { Label } from "./rules.ts";
import { emptyTagMemory, localTagStore, rememberTag, TAG_MEMORY_KEY, tagTask } from "./taskTagger.ts";

// The Dashboard card "Plan my next hour" (plan P20 W2.6) without the DOM: which tasks, the one-tap rubric, the phase
// from the live state and the history, the timeline, and the answers kept for the decision log (W2.7).

const TODAY = "2026-11-10";
const local = (y: number, month: number, d: number, h = 0, min = 0) => new Date(y, month - 1, d, h, min).getTime();
const AT_1410 = local(2026, 11, 10, 14, 10);
const EACH = 10_000;
const SAMPLE = demoTasks("rina", TODAY);

const google = (id: string, title: string, order: number, due: string | null = null): ImportedTask => ({
  id,
  listId: "MDk3NjU0MzIx",
  listTitle: "Client Falcon",
  title,
  due,
  parent: null,
  order,
});
const REAL = [google("MTA0ODU3NjU2Nzg5", "Write Q3 report for Dina", 0), google("MTA0ODU3NjU2Nzkw", "Lunch with Bima", 1)];

// One judged evaluation every 10 s for `minutes`, the last one at `end`, as the history stores them.
function evals(end: number, minutes: number, label: Label = "normal", dinilai = true): EvaluationRecord[] {
  const n = Math.round((minutes * 60_000) / EACH);
  return Array.from({ length: n }, (_, i) => {
    const t = end - (n - 1 - i) * EACH;
    const d = new Date(t);
    const hari = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { t, hari, label, dinilai } as unknown as EvaluationRecord;
  });
}
const kssAt = (t: number, kss: number) => ({ t, kss, hari: TODAY, sesi: 1, label_tampil: null, pengingat: false }) as KssRecord;

describe("which tasks the card plans with", () => {
  it("connected Google Tasks win, even with none open; the sample list only without Google; never both", () => {
    expect(chooseTasks(true, REAL, SAMPLE)).toEqual({ kind: "google", tasks: REAL });
    expect(chooseTasks(true, [], SAMPLE)).toEqual({ kind: "google", tasks: [] });
    expect(chooseTasks(false, [], SAMPLE)).toEqual({ kind: "sample", tasks: SAMPLE });
    expect(chooseTasks(false, [], null)).toEqual({ kind: "none", tasks: [] });
    for (const choice of [chooseTasks(true, REAL, SAMPLE), chooseTasks(false, [], SAMPLE)]) {
      const lists = new Set(choice.tasks.map((t) => t.listTitle));
      expect(lists.size).toBe(1);
    }
    expect(sourceLine(chooseTasks(true, REAL, SAMPLE))).toBe("Google Tasks · 2 open");
    expect(sourceLine(chooseTasks(false, [], SAMPLE))).toBe("Sample tasks · 6");
    expect(sourceLine(chooseTasks(false, [], null))).toBe("");
  });

  it("the demo account's sample tasks are labelled, due from today, and tagged as meant (one not assessed)", () => {
    expect(SAMPLE.every((t) => t.listTitle === SAMPLE_LIST && t.id.startsWith("sample-rina-"))).toBe(true);
    expect(SAMPLE.map((t) => t.order)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(SAMPLE.map((t) => t.due)).toEqual(["2026-11-10", "2026-11-12", null, "2026-11-11", null, "2026-11-13"]);
    expect(demoTasks("rina", "2026-11-30").map((t) => t.due)).toEqual(["2026-11-30", "2026-12-02", null, "2026-12-01", null, "2026-12-03"]);
    const kinds = SAMPLE.map((t) => {
      const tag = tagTask(t, TODAY, new Map(), new Map());
      return `${tag.sifat} ${tag.beban}`;
    });
    expect(kinds).toEqual([
      "monoton berat",
      "aktif berat",
      "monoton ringan",
      "aktif ringan",
      "belum dinilai belum dinilai",
      "monoton ringan",
    ]);
  });
});

describe("one-tap rubric", () => {
  it("asks only about tasks the lexicon could not tag, once: the answer is remembered for the task and its verb", () => {
    expect(tasksToAsk(SAMPLE, TODAY, emptyTagMemory())).toEqual([{ id: "sample-rina-5", title: "Petty cash for November" }]);
    const memory = rememberTag(emptyTagMemory(), SAMPLE[4], { sifat: "monoton", beban: "ringan" });
    expect(tasksToAsk(SAMPLE, TODAY, memory)).toEqual([]);
    // The verb was learned too: a new task with it is not asked about.
    const next = { ...SAMPLE[4], id: "sample-rina-9", title: "Petty cash for December", order: 9 };
    expect(tasksToAsk([...SAMPLE, next], TODAY, memory)).toEqual([]);
    expect(tasksToAsk([next], TODAY, emptyTagMemory())).toHaveLength(1); // positive control
  });

  it("asks about the first few in the user's order, and only about tasks a plan would send", () => {
    const unknown = Array.from({ length: 60 }, (_, i) => google(`id${i}`, `Zorbify thing ${i}`, 59 - i));
    expect(tasksToAsk(unknown, TODAY, emptyTagMemory()).map((a) => a.title)).toEqual(["Zorbify thing 59", "Zorbify thing 58", "Zorbify thing 57"]);
    expect(ASK_MAX).toBe(3);
    const late = [...Array.from({ length: 50 }, (_, i) => google(`k${i}`, `Write part ${i}`, i)), google("late", "Zorbify", 50)];
    expect(tasksToAsk(late, TODAY, emptyTagMemory())).toEqual([]);
  });

  it("lets the plan's task be changed even when the lexicon tagged it, kept as its answer (D-89, review B, 8 Nov)", () => {
    const req = toRencanaRequest({ fase: "siap fokus", jam_rawan: false }, 10, REAL, TODAY, emptyTagMemory());
    const plan = offlinePlan(req, null);
    const task = chosenTask(plan.tugas_id, req.peta, REAL);
    expect(task?.title).toBe("Write Q3 report for Dina");
    // Tagged by the lexicon, so the question never asks about it: only "Change" can.
    expect(tasksToAsk(REAL, TODAY, emptyTagMemory()).map((a) => a.id)).not.toContain(task!.id);
    expect(kindOf(task!, TODAY, emptyTagMemory())?.text).toBe("Active, demanding");
    const memory = rememberTag(emptyTagMemory(), task!, { sifat: "monoton", beban: "ringan" });
    expect(kindOf(task!, TODAY, memory)?.text).toBe("Routine, light");
    expect(tagTask(task!, TODAY, memory.corrections, memory.personal).source).toBe("correction");
    // No task to change: a break, an id the request does not know, a task no longer listed.
    expect(chosenTask(null, req.peta, REAL)).toBeNull();
    expect(chosenTask("t9", req.peta, REAL)).toBeNull();
    expect(chosenTask(plan.tugas_id, req.peta, [])).toBeNull();
    expect(kindOf(google("u1", "Zorbify", 0), TODAY, emptyTagMemory())).toBeNull(); // not assessed
  });

  it("offers the four kinds as one tap each", () => {
    expect(RUBRIC_CHOICES.map((c) => `${c.rubric.sifat} ${c.rubric.beban}`)).toEqual([
      "aktif berat",
      "aktif ringan",
      "monoton berat",
      "monoton ringan",
    ]);
  });

  it("keeps the sample tasks' answers under their own key, apart from the real dictionary", () => {
    const data = new Map<string, string>();
    const base = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    };
    const demo = localTagStore(scopedStore(base, "demo-rina"));
    expect(demo.save(rememberTag(emptyTagMemory(), SAMPLE[4], { sifat: "aktif", beban: "ringan" }))).toBe(true);
    expect([...data.keys()]).toEqual([`${TAG_MEMORY_KEY}@demo-rina`]);
    expect(localTagStore(base).load().personal.size).toBe(0);
    expect(demo.load().personal.get("petty")).toEqual({ sifat: "aktif", beban: "ringan" });
  });
});

describe("where the rubric answers are kept", () => {
  it("per signed-in account; Delete all history removes this account's and the demo's, never another's (review A, 8 Nov)", () => {
    const data = new Map<string, string>();
    const base = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    };
    let owner: string | null = "account-a";
    const stores = tagStores(base, () => owner, "demo-rina");
    const lunch = REAL[1]; // "Lunch with Bima": an unknown verb, learned as "lunch"
    stores.google.save(rememberTag(emptyTagMemory(), lunch, { sifat: "aktif", beban: "ringan" }));
    stores.sample.save(rememberTag(emptyTagMemory(), SAMPLE[4], { sifat: "monoton", beban: "ringan" }));
    expect([...data.keys()].sort()).toEqual([`${TAG_MEMORY_KEY}@account-a`, `${TAG_MEMORY_KEY}@demo-rina`]);

    // Another account on the same laptop sees none of it, and keeps its own.
    owner = "account-b";
    expect(stores.google.load().personal.size).toBe(0);
    expect(tasksToAsk(REAL, TODAY, stores.google.load()).map((a) => a.id)).toEqual([lunch.id]);
    stores.google.save(rememberTag(emptyTagMemory(), lunch, { sifat: "monoton", beban: "ringan" }));
    owner = "account-a";
    expect(stores.google.load().personal.get("lunch")).toEqual({ sifat: "aktif", beban: "ringan" });

    stores.clear(); // account A's "Delete all history" in the demo
    expect([...data.keys()]).toEqual([`${TAG_MEMORY_KEY}@account-b`]);
    expect(stores.google.load().corrections.size).toBe(0);

    // Without an account (no sign-in configured, a ?kode= test): the laptop's own key.
    owner = null;
    stores.google.save(rememberTag(emptyTagMemory(), lunch, { sifat: "aktif", beban: "ringan" }));
    expect(data.has(TAG_MEMORY_KEY)).toBe(true);
    // No storage at all: in memory, and clear() empties it.
    const none = tagStores(null, () => "account-a", null);
    none.google.save(rememberTag(emptyTagMemory(), lunch, { sifat: "aktif", beban: "ringan" }));
    none.clear();
    expect(none.google.load().personal.size).toBe(0);
  });
});

describe("the phase the plan is made for", () => {
  it("covers every day the 7-day slump window can reach, today first, across a month end", () => {
    expect(historyDayKeys(local(2026, 12, 3, 9))).toEqual([
      "2026-12-03",
      "2026-12-02",
      "2026-12-01",
      "2026-11-30",
      "2026-11-29",
      "2026-11-28",
      "2026-11-27",
      "2026-11-26",
    ]);
  });

  it("not assessed (no label yet, or the quality gate) still plans, and says the camera is not behind it", () => {
    for (const live of [
      { label: null, quality: null, menitSejakJeda: null },
      { label: "lelah" as const, quality: "tidak-dinilai" as const, menitSejakJeda: 40 },
    ]) {
      const phase = energyPhase(phaseInputFrom(live, [], [], AT_1410, EACH));
      expect(phase.fase).toBe("tidak tahu");
      const view = phaseView(phase, DEFAULT_SLUMP);
      expect(view).toMatchObject({ title: "Energy: Not assessed", assessed: false });
      expect(view.note).toMatch(/not based on the camera right now/);
      const plan = offlinePlan(toRencanaRequest(phase, live.menitSejakJeda, SAMPLE, TODAY, emptyTagMemory()), null);
      expect(plan.kode).toContain("KAMERA_TIDAK_MENILAI");
      expect(plan.tugas_id).not.toBeNull();
    }
  });

  it("uses the shown label, the latest sleepiness check and the slump hours", () => {
    const live = { label: "lelah ringan" as const, quality: "nilai" as const, menitSejakJeda: 45 };
    const low = energyPhase(phaseInputFrom(live, evals(AT_1410, 15), [], AT_1410, EACH));
    expect(low).toEqual({ fase: "rendah ringan", jam_rawan: true, reason: "mildly-tired" });
    expect(phaseView(low, DEFAULT_SLUMP)).toEqual({
      title: "Energy: Low energy",
      note: "The camera reads you as Mildly tired.",
      slump: "13:00–16:00 is a usual low time for most people.",
      assessed: true,
    });
    // The latest answer counts, not the highest: 8 at 13:50, then 3 at 14:05.
    const calm = { label: "normal" as const, quality: "nilai" as const, menitSejakJeda: 20 };
    const kss = [kssAt(AT_1410 - 5 * 60_000, 3), kssAt(AT_1410 - 20 * 60_000, 8)];
    expect(phaseInputFrom(calm, [], kss, AT_1410, EACH).kss?.kss).toBe(3);
    expect(energyPhase(phaseInputFrom(calm, [], [kssAt(AT_1410 - 60_000, 7)], AT_1410, EACH)).fase).toBe("rendah ringan");
    expect(phaseInputFrom(calm, [], [kssAt(AT_1410 + 60_000, 9)], AT_1410, EACH).kss).toBeNull(); // not after now
  });

  it("finds a personal slump hour in the history and says where it comes from", () => {
    // Five days: 09:00–10:00 calm, 15:00–16:00 tired.
    const days = [6, 5, 4, 3, 2].flatMap((back) => [
      ...evals(local(2026, 11, 10 - back, 9, 59), 60, "normal"),
      ...evals(local(2026, 11, 10 - back, 15, 59), 60, "lelah ringan"),
    ]);
    const live = { label: "normal" as const, quality: "nilai" as const, menitSejakJeda: 20 };
    const input = phaseInputFrom(live, days, [], local(2026, 11, 10, 15, 20), EACH);
    expect(input.slump).toEqual({ startHour: 15, endHour: 16, personal: true });
    const phase = energyPhase(input);
    expect(phase.jam_rawan).toBe(true);
    expect(phaseView(phase, input.slump).slump).toBe("15:00–16:00 is your usual low hour (from your last 7 days).");
    expect(phaseInputFrom(live, days.slice(0, 720), [], local(2026, 11, 10, 15, 20), EACH).slump).toEqual(DEFAULT_SLUMP);
  });
});

describe("the timeline", () => {
  const LOW = { fase: "rendah ringan", jam_rawan: true } as const;
  const lowReq = () => toRencanaRequest(LOW, 45, SAMPLE, TODAY, emptyTagMemory());

  it("offline at 14:10, mildly tired: walk 5 min, the active task with its title and the reason, then a walk", () => {
    const view = planView(offlinePlan(lowReq(), "Can't reach the backend."));
    expect(view.steps).toEqual([
      { kind: "jalan", label: "Walk", minutes: "5 min", text: "Walk for 5 minutes.", title: null, why: null },
      {
        kind: "tugas",
        label: "Task",
        minutes: "25 min",
        text: "Work on “Write the Q4 budget summary for the finance meeting” for 25 minutes.",
        title: null, // the sentence already names it
        why: [REASON_TEXT.JALAN_DULU, REASON_TEXT.AKTIF_SAAT_RAWAN, REASON_TEXT.HINDARI_MONOTON, REASON_TEXT.TENGGAT_DEKAT].join(" "),
      },
      { kind: "next", label: "Next", minutes: null, text: "When you finish, walk for 5 minutes.", title: null, why: null },
    ]);
    expect(view).toMatchObject({ why: null, badge: "Offline plan, rules only", badgeNote: "Can't reach the backend.", sources: null });
  });

  it("a server plan: its sentences, the title shown when the sentence lacks it, the model and the sources", () => {
    const base = offlinePlan(lowReq(), null);
    const plan: Plan = {
      ...base,
      asal: "server",
      sebab: null,
      langkah: base.langkah.map((s) => ({ ...s, teks: s.jenis === "tugas" ? "Then the report, while you're fresh from the walk." : "A short walk first." })),
      alasan: "Active work suits the afternoon dip.",
      sumber: ["jam-rawan-siang.md", "made-up.md"],
      model: "IBM watsonx · Mistral Small 3.1 (Tokyo)",
    };
    const view = planView(plan);
    expect(view.steps[1]).toMatchObject({ title: "“Write the Q4 budget summary for the finance meeting”", why: "Active work suits the afternoon dip." });
    expect(view.badge).toBe("Model: IBM watsonx · Mistral Small 3.1 (Tokyo)");
    expect(view.badgeNote).toBeNull();
    expect(view.sources).toEqual([
      { text: "Carskadon & Dement (1992), Monk (2005) and others: the afternoon dip in alertness", known: true },
      { text: "made-up.md (not in the knowledge base)", known: false },
    ]);
    expect(planView({ ...plan, cadangan: true, model: null })).toMatchObject({
      badge: "Model: not named by the server",
      badgeNote: "Written by the backup model because the main model failed.",
    });
  });

  it("very low energy: the break carries the reason, no task, then plan again", () => {
    const view = planView(offlinePlan(toRencanaRequest({ fase: "rendah berat", jam_rawan: false }, 45, SAMPLE, TODAY, emptyTagMemory()), null));
    expect(view.steps.map((s) => [s.kind, s.minutes, s.why])).toEqual([
      ["jeda", "10 min", REASON_TEXT.JEDA_DULU],
      ["next", null, null],
    ]);
    expect(view.steps[1].text).toBe("When you're back, plan your next hour again.");
    expect(JSON.stringify(view)).not.toMatch(/Reconcile|Write the|Petty/);
  });

  it("no open task: no step, the reason on its own", () => {
    const view = planView(offlinePlan(toRencanaRequest({ fase: "biasa", jam_rawan: false }, 10, [], TODAY, emptyTagMemory()), null));
    expect(view.steps).toEqual([]);
    expect(view.why).toBe(REASON_TEXT.TIDAK_ADA_TUGAS);
  });
});

// The decision log kept from each plan (W2.7) is tested in decisionLog.test.ts.
describe("what leaves the laptop", () => {
  it("the request never holds a title, a list name or a task id (negative control)", () => {
    for (const tasks of [SAMPLE, REAL]) {
      const req = toRencanaRequest({ fase: "rendah ringan", jam_rawan: true }, 45, tasks, TODAY, emptyTagMemory());
      const plan = offlinePlan(req, null);
      const out = JSON.stringify(req.body);
      const secrets = tasks.flatMap((t) => [t.title, t.listTitle, t.id, t.listId]);
      for (const s of secrets) expect(out).not.toContain(s);
      // Positive control: the plan shown on the laptop does carry the chosen title, and peta its own id.
      expect(JSON.stringify(plan)).toContain(tasks.find((t) => `t${t.order + 1}` === plan.tugas_id)!.title);
      expect(req.peta.get(plan.tugas_id!)).toBe(tasks.find((t) => `t${t.order + 1}` === plan.tugas_id)!.id);
    }
  });
});
