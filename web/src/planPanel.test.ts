import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionRecord } from "./decisionLog.ts";
import type { ImportedTask } from "./googleTasks.ts";
import type { EvaluationRecord } from "./history.ts";
import { AUTO_NOTE, PlanPanel, type PlanDeps } from "./planPanel.ts";
import { memoryTagStore, rememberTag } from "./taskTagger.ts";

// The Dashboard card "Plan my next hour" (planPanel.ts) over a minimal fake DOM: the "Kind: … Change" control on the
// plan's task (D-89, review B, 8 Nov) from the click to the next plan. Logic only; how it looks is the browser check.

class FakeElement {
  textContent = "";
  hidden = false;
  disabled = false;
  className = "";
  type = "";
  dataset: Record<string, string> = {};
  children: (FakeElement | string)[] = [];
  private readonly attributes = new Map<string, string>();
  private readonly clicks: (() => void)[] = [];
  addEventListener(type: string, listener: () => void) {
    if (type === "click") this.clicks.push(listener);
  }
  click() {
    for (const listener of this.clicks) listener();
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  replaceChildren(...nodes: (FakeElement | string)[]) {
    this.children = nodes;
  }
  append(...nodes: (FakeElement | string)[]) {
    this.children.push(...nodes);
  }
  focus() {}
  // The two selectors planPanel.ts uses: ".class" and "[attribute]".
  querySelector(selector: string): FakeElement | null {
    const match = (e: FakeElement) =>
      selector.startsWith(".") ? e.className.split(" ").includes(selector.slice(1)) : e.getAttribute(selector.slice(1, -1)) !== null;
    return descendants(this).find(match) ?? null;
  }
}

const descendants = (node: FakeElement): FakeElement[] =>
  node.children.flatMap((c) => (typeof c === "string" ? [] : [c, ...descendants(c)]));
const buttons = (node: FakeElement, text: string) => descendants(node).filter((e) => e.textContent === text && e.className.includes("btn"));
const button = (node: FakeElement, text: string) => {
  const found = buttons(node, text);
  expect(found, `one "${text}" button`).toHaveLength(1);
  return found[0];
};
const texts = (node: FakeElement) => descendants(node).map((e) => e.textContent);

let elements: Map<string, FakeElement>;
const byId = (id: string) => elements.get(id)!;

beforeEach(() => {
  elements = new Map(["plan-source", "plan-note", "plan-connect", "plan-ask", "plan-make", "plan-out"].map((id) => [id, new FakeElement()]));
  vi.stubGlobal("document", { getElementById: (id: string) => elements.get(id) ?? null, createElement: () => new FakeElement() });
  // 10:00 local, outside the default slump hours 13:00–16:00 (phase.ts), where the task step names its minutes and
  // these tests failed every afternoon. Only Date is faked, so settle()'s timers still run.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 9, 10, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const task = (id: string, title: string, order: number): ImportedTask => ({ id, listId: "L1", listTitle: "Work", title, due: null, parent: null, order });
const REPORT = task("GT-aa11", "Write Q3 report for Dina", 0); // the lexicon: active, demanding
const TASKS = [REPORT, task("GT-bb22", "Lunch with Bima", 1)];

// 15 calm, judged minutes ending now: "Ready to focus", which picks the demanding task.
function calmHistory(): EvaluationRecord[] {
  const now = Date.now();
  return Array.from({ length: 90 }, (_, i) => ({ t: now - (89 - i) * 10_000, label: "normal", dinilai: true }) as unknown as EvaluationRecord);
}

function panel(over: Partial<PlanDeps> = {}) {
  const records: DecisionRecord[] = [];
  const tags = { google: memoryTagStore(), sample: memoryTagStore() };
  const onTaskDone = vi.fn();
  const taskDone = vi.fn(async () => {});
  const completeTask = vi.fn<PlanDeps["completeTask"]>(async () => ({ ticked: true, message: "Ticked off in Google Tasks." }));
  const deps: PlanDeps = {
    tasks: () => ({ connected: true, tasks: TASKS }),
    sample: null,
    tags,
    live: () => ({ label: "normal", quality: "nilai", menitSejakJeda: 10 }),
    history: async () => ({ evaluasi: calmHistory(), kss: [] }),
    evalIntervalMs: 10_000,
    server: () => false,
    offlineReason: "No backend in this test.",
    onTaskDone,
    completeTask,
    log: {
      planned: async (record) => records.push(record),
      answered: async () => {},
      taskDone,
    },
    session: 1,
    ...over,
  };
  return { panel: new PlanPanel(deps), records, tags, onTaskDone, taskDone, completeTask: deps.completeTask };
}

describe("kinds are set on the Tasks page (user 11 Nov); the card only links there", () => {
  it("counts the open tasks without a kind and links to #tasks, with no questions on the card", () => {
    const courses = ["Algorithm and Programming", "Deep Learning"];
    const sessions = Array.from({ length: 12 }, (_, i) => task(`c${i}`, `[${courses[i % 2]}] - [Sesi ${i + 1}]`, i));
    const { panel: card, tags } = panel({ tasks: () => ({ connected: true, tasks: sessions }) });
    card.tasksChanged();
    const ask = byId("plan-ask");
    expect(ask.hidden).toBe(false);
    expect(texts(ask)).toContain("12 tasks have no kind. Set kinds");
    expect(descendants(ask).find((e) => e.textContent.startsWith("12 tasks"))?.getAttribute("href")).toBe("#tasks");
    expect(descendants(ask).filter((e) => e.className.includes("rubric-choice"))).toHaveLength(0);
    // Control: once every course has a kind (on the Tasks page), the line goes away.
    let memory = tags.google.load();
    for (const t of sessions) memory = rememberTag(memory, t, { sifat: "aktif", beban: "berat" });
    tags.google.save(memory);
    card.render();
    expect(ask.hidden).toBe(true);
  });
});

describe("a plan by itself when the state turns Mildly tired or Tired (user 11 Nov)", () => {
  it("entering Mildly tired makes one plan on this laptop, marked as automatic, without the server", async () => {
    const server = vi.fn(() => true);
    const { panel: card, records } = panel({ server, live: () => ({ label: "lelah ringan", quality: "nilai", menitSejakJeda: 10 }) });
    card.labelChanged("normal");
    expect(records).toHaveLength(0);
    card.labelChanged("lelah ringan");
    await settle();
    expect(records).toHaveLength(1);
    expect(server).not.toHaveBeenCalled();
    const out = byId("plan-out");
    expect(texts(out)).toContain("Suggested at 10:00 · you look tired");
    expect(texts(out)).toContain(AUTO_NOTE);
  });

  it("staying tired, Tired after Mildly tired, or a second dip within 30 minutes makes no new plan (negative control)", async () => {
    const { panel: card, records } = panel();
    card.labelChanged("lelah ringan");
    await settle();
    card.labelChanged("lelah ringan");
    card.labelChanged("lelah");
    await settle();
    expect(records).toHaveLength(1);
    card.labelChanged("normal");
    vi.setSystemTime(new Date(2026, 10, 9, 10, 20, 0));
    card.labelChanged("lelah");
    await settle();
    expect(records).toHaveLength(1);
    // After 30 minutes it may suggest again.
    card.labelChanged("normal");
    vi.setSystemTime(new Date(2026, 10, 9, 10, 31, 0));
    card.labelChanged("lelah");
    await settle();
    expect(records).toHaveLength(2);
  });

  it("the automatic plan calls onAuto once with what the card shows; a pressed plan or a dip within 30 min does not", async () => {
    const onAuto = vi.fn<NonNullable<PlanDeps["onAuto"]>>();
    const { panel: card } = panel({ onAuto });
    // Control: a plan the user pressed for is no alert.
    byId("plan-make").click();
    await settle();
    expect(onAuto).not.toHaveBeenCalled();
    vi.setSystemTime(new Date(2026, 10, 9, 10, 40, 0));
    card.labelChanged("normal");
    card.labelChanged("lelah ringan");
    await settle();
    expect(onAuto).toHaveBeenCalledTimes(1);
    expect(onAuto.mock.calls[0][0].steps.length).toBeGreaterThan(0);
    expect(texts(byId("plan-out"))).toContain("Suggested at 10:40 · you look tired");
    // Negative control: a second dip 10 minutes later makes no plan, so no alert.
    card.labelChanged("normal");
    vi.setSystemTime(new Date(2026, 10, 9, 10, 50, 0));
    card.labelChanged("lelah");
    await settle();
    expect(onAuto).toHaveBeenCalledTimes(1);
  });

  it("an alert that throws leaves the automatic plan on the card", async () => {
    const { panel: card, records } = panel({
      onAuto: () => {
        throw new Error("no audio");
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    card.labelChanged("lelah");
    await settle();
    expect(records).toHaveLength(1);
    expect(texts(byId("plan-out"))).toContain(AUTO_NOTE);
  });

  it("no tasks to plan with: nothing is made", async () => {
    const { panel: card, records } = panel({ tasks: () => ({ connected: false, tasks: [] }) });
    card.labelChanged("lelah");
    await settle();
    expect(records).toHaveLength(0);
  });
});

describe("Kind: … Change on the plan's task", () => {
  it("shows the task's kind, opens the four kinds, saves the pick, and the next plan sends the new kind", async () => {
    const { records, tags } = panel();
    byId("plan-make").click();
    await settle();
    const out = byId("plan-out");
    expect(texts(out)).toContain("Work on “Write Q3 report for Dina”.");
    expect(texts(out)).toContain("Kind: Active, demanding");
    expect(records[0].tugas_id).toBe("t1");
    expect(records[0].tugas.find((t) => t.id === "t1")).toMatchObject({ sifat: "aktif", beban: "berat" });
    expect(buttons(out, "Routine, light")).toHaveLength(0); // closed until Change

    button(out, "Change").click();
    expect(button(out, "Active, demanding").getAttribute("aria-pressed")).toBe("true");
    expect(button(out, "Routine, light").getAttribute("aria-pressed")).toBe("false");
    expect(button(out, "Cancel").getAttribute("aria-expanded")).toBe("true");

    button(out, "Routine, light").click();
    expect(texts(byId("plan-ask"))).toContain("Saved. Plan again to use it.");
    expect(texts(out)).toContain("Kind: Routine, light");
    expect(buttons(out, "Routine, light")).toHaveLength(0); // closed again after the pick
    expect(tags.google.load().corrections.size).toBe(1);

    expect(byId("plan-make").textContent).toBe("Plan again");
    byId("plan-make").click();
    await settle();
    expect(records).toHaveLength(2);
    expect(records[1].tugas.find((t) => t.id === "t1")).toMatchObject({ sifat: "monoton", beban: "ringan" });
  });

  it("Cancel closes the four kinds and keeps the kind as it was (negative control)", async () => {
    const { records, tags } = panel();
    byId("plan-make").click();
    await settle();
    const out = byId("plan-out");
    button(out, "Change").click();
    expect(buttons(out, "Routine, light")).toHaveLength(1);
    button(out, "Cancel").click();
    expect(buttons(out, "Routine, light")).toHaveLength(0);
    expect(button(out, "Change").getAttribute("aria-expanded")).toBe("false");
    expect(tags.google.load().corrections.size).toBe(0);

    byId("plan-make").click();
    await settle();
    expect(records[1].tugas.find((t) => t.id === "t1")).toMatchObject({ sifat: "aktif", beban: "berat" });
  });
});

describe("I finished it: ticking the task off in Google Tasks (W2.8)", () => {
  it("one click ticks the plan's Google task off once, inside the click, and still does the local steps", async () => {
    const { completeTask, onTaskDone, taskDone } = panel();
    byId("plan-make").click();
    await settle();
    const out = byId("plan-out");
    const done = button(out, "I finished it");
    done.click();
    // Synchronously from the click: the first tick opens Google's window, which needs the click (NOTES G-74).
    expect(completeTask).toHaveBeenCalledTimes(1);
    expect(completeTask).toHaveBeenCalledWith(REPORT);
    expect(texts(out)).toContain("Ticking it off in Google Tasks…");
    expect(onTaskDone).toHaveBeenCalledTimes(1);
    expect(taskDone).toHaveBeenCalledTimes(1);
    expect(done.disabled).toBe(true);
    done.click(); // a second click on the same plan does nothing new
    await settle();
    expect(completeTask).toHaveBeenCalledTimes(1);
    expect(onTaskDone).toHaveBeenCalledTimes(1);
    expect(texts(byId("plan-out"))).toEqual(expect.arrayContaining(["Marked as done.", "Ticked off in Google Tasks."]));
  });

  it("a tick Google refused shows why and never claims it was ticked (negative control)", async () => {
    const message = "Not ticked off: Equilibre may not change your tasks. Tick it off in Google Tasks.";
    const { onTaskDone } = panel({ completeTask: async () => ({ ticked: false, message }) });
    byId("plan-make").click();
    await settle();
    button(byId("plan-out"), "I finished it").click();
    await settle();
    const shown = texts(byId("plan-out"));
    expect(shown).toContain(message);
    expect(shown).toContain("Marked as done.");
    expect(shown.some((t) => t.startsWith("Ticked off"))).toBe(false);
    expect(onTaskDone).toHaveBeenCalledTimes(1);
  });

  it("a tick that throws still leaves the task marked done locally", async () => {
    const { onTaskDone, taskDone } = panel({
      completeTask: () => {
        throw new Error("boom");
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    byId("plan-make").click();
    await settle();
    button(byId("plan-out"), "I finished it").click();
    await settle();
    expect(onTaskDone).toHaveBeenCalledTimes(1);
    expect(taskDone).toHaveBeenCalledTimes(1);
    expect(texts(byId("plan-out"))).toContain("Not ticked off in Google Tasks. Tick it off there.");
    vi.mocked(console.error).mockRestore();
  });

  it("the demo's sample tasks are never sent to Google", async () => {
    const sample = [task("sample-rina-1", "Write Q3 report for Dina", 0), task("sample-rina-2", "Lunch with Bima", 1)];
    const { completeTask, onTaskDone } = panel({ tasks: () => ({ connected: false, tasks: [] }), sample: () => sample });
    byId("plan-make").click();
    await settle();
    expect(byId("plan-source").textContent).toBe("Sample tasks · 2");
    button(byId("plan-out"), "I finished it").click();
    await settle();
    expect(completeTask).not.toHaveBeenCalled();
    expect(onTaskDone).toHaveBeenCalledTimes(1);
    const shown = texts(byId("plan-out"));
    expect(shown).toContain("Marked as done.");
    expect(shown.some((t) => t.includes("Google Tasks"))).toBe(false);
  });
});
