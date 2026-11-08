import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionRecord } from "./decisionLog.ts";
import type { ImportedTask } from "./googleTasks.ts";
import type { EvaluationRecord } from "./history.ts";
import { PlanPanel, type PlanDeps } from "./planPanel.ts";
import { memoryTagStore } from "./taskTagger.ts";

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
});

afterEach(() => {
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

function panel() {
  const records: DecisionRecord[] = [];
  const tags = { google: memoryTagStore(), sample: memoryTagStore() };
  const deps: PlanDeps = {
    tasks: () => ({ connected: true, tasks: TASKS }),
    sample: null,
    tags,
    live: () => ({ label: "normal", quality: "nilai", menitSejakJeda: 10 }),
    history: async () => ({ evaluasi: calmHistory(), kss: [] }),
    evalIntervalMs: 10_000,
    server: () => false,
    offlineReason: "No backend in this test.",
    onTaskDone: () => {},
    log: {
      planned: async (record) => records.push(record),
      answered: async () => {},
      taskDone: async () => {},
    },
    session: 1,
  };
  return { panel: new PlanPanel(deps), records, tags };
}

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
    expect(texts(byId("plan-ask"))).toContain("Saved on this laptop. Plan again to use it.");
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
