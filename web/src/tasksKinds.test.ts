import { afterEach, describe, expect, it, vi } from "vitest";

// The kind of each task on the Tasks page, kept over days (user 11 Nov: "I set the kinds one by one, and the next day I
// have to set them again"). The real chain over a fake DOM: TasksPanel → the kind picker → tagStores (localStorage,
// per account) → a new page load on the next calendar day, with Google's token and the Tasks API replaced.

vi.mock("./googleTasks.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./googleTasks.ts")>();
  return {
    ...real,
    gisReady: vi.fn(() => ({})),
    loadGis: vi.fn(),
    requestToken: vi.fn(),
    readTasks: vi.fn(),
    completeTask: vi.fn(),
    revokeToken: vi.fn(async () => {}),
  };
});

import type { KeyValueStore } from "./calibration.ts";
import { readTasks, requestToken, type ImportedTask } from "./googleTasks.ts";
import { tagStores } from "./planCard.ts";
import { KIND_NOTE, TasksPanel } from "./tasksPanel.ts";

class FakeElement {
  textContent = "";
  hidden = false;
  disabled = false;
  className = "";
  value = "";
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, (() => void)[]>();
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  dispatch(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  click() {
    this.dispatch("click");
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  replaceChildren(...nodes: FakeElement[]) {
    this.children = nodes;
  }
  append(...nodes: FakeElement[]) {
    this.children.push(...nodes);
  }
  querySelector(selector: string): FakeElement | null {
    return descendants(this).find((e) => e.className.split(" ").includes(selector.slice(1))) ?? null;
  }
}

const descendants = (node: FakeElement): FakeElement[] => node.children.flatMap((c) => [c, ...descendants(c)]);

// localStorage of one browser (one address): kept over page loads and days.
function fakeStorage(): KeyValueStore & { keys(): string[] } {
  const items = new Map<string, string>();
  return {
    getItem: (k) => items.get(k) ?? null,
    setItem: (k, v) => void items.set(k, v),
    removeItem: (k) => void items.delete(k),
    keys: () => [...items.keys()],
  };
}

let elements: Map<string, FakeElement>;
const byId = (id: string) => elements.get(id)!;

// One page load of app.html: a new DOM, a new panel, the same browser storage.
function pageLoad(storage: KeyValueStore, account: string, today: string) {
  const ids = ["tasks-connect", "tasks-refresh", "tasks-disconnect", "tasks-status", "tasks-list", "tasks-count", "tasks-kind-note"];
  elements = new Map(ids.map((id) => [id, new FakeElement()]));
  vi.stubGlobal("document", { getElementById: (id: string) => elements.get(id) ?? null, createElement: () => new FakeElement() });
  const kinds = tagStores(storage, () => account, null);
  const panel = new TasksPanel();
  panel.useKinds({ store: () => kinds.google, today: () => today, onChange: () => {} });
  return panel;
}

async function connect(tasks: ImportedTask[]) {
  vi.mocked(requestToken).mockResolvedValueOnce({ value: "token", expiresAt: Date.now() + 3_600_000 });
  vi.mocked(readTasks).mockResolvedValueOnce(tasks);
  byId("tasks-connect").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// Each row on the list: its title and the kind its picker shows ("" = Set kind).
function rows(): { title: string; kind: string }[] {
  return byId("tasks-list").children.map((row) => {
    const select = descendants(row).find((e) => e.className === "kind-select")!;
    const option = select.children.find((o) => o.value === select.value)!;
    return { title: descendants(row).find((e) => e.className === "task-title")!.textContent, kind: select.value === "" ? "" : option.textContent };
  });
}

function pick(title: string, kind: string) {
  const row = byId("tasks-list").children.find((r) => descendants(r).some((e) => e.className === "task-title" && e.textContent === title))!;
  const select = descendants(row).find((e) => e.className === "kind-select")!;
  select.value = select.children.find((o) => o.textContent === kind)!.value;
  select.dispatch("change");
}

const task = (id: string, title: string, order: number): ImportedTask => ({ id, listId: "L1", listTitle: "Work", title, due: null, parent: null, order });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("kinds set on the Tasks page are kept the next day; only new tasks ask (user 11 Nov)", () => {
  it("a new page load the next day shows yesterday's kinds; a repeating task and a new session of a course inherit theirs", async () => {
    const storage = fakeStorage();
    pageLoad(storage, "user-1", "2026-11-11");
    await connect([task("a", "[Algorithm and Programming] - [Sesi 1]", 0), task("b", "[Algorithm and Programming] - [Sesi 2]", 1), task("c", "Tes Jojo", 2)]);
    expect(rows()).toEqual([
      { title: "[Algorithm and Programming]", kind: "" },
      { title: "Tes Jojo", kind: "" },
    ]);
    expect(byId("tasks-kind-note").textContent).toBe(KIND_NOTE.missing(3));
    pick("[Algorithm and Programming]", "Routine, light");
    pick("Tes Jojo", "Active, light");
    expect(byId("tasks-kind-note").textContent).toBe(KIND_NOTE.done);

    // The next day, a new page load: the same tasks, a repeating "Tes Jojo" under a new Google id, a new session of
    // the course, and one task never seen before.
    pageLoad(storage, "user-1", "2026-11-12");
    await connect([
      task("a", "[Algorithm and Programming] - [Sesi 1]", 0),
      task("b", "[Algorithm and Programming] - [Sesi 2]", 1),
      task("d", "[Algorithm and Programming] - [Sesi 3]", 2),
      task("c2", "Tes Jojo", 3),
      task("e", "Zorbify thing", 4),
    ]);
    expect(rows()).toEqual([
      { title: "[Algorithm and Programming]", kind: "Routine, light" },
      { title: "Tes Jojo", kind: "Active, light" },
      { title: "Zorbify thing", kind: "" },
    ]);
    expect(byId("tasks-kind-note").textContent).toBe(KIND_NOTE.missing(1));
  });

  it("negative controls: another account on the same laptop, or another browser address, starts with no kinds", async () => {
    const storage = fakeStorage();
    pageLoad(storage, "user-1", "2026-11-11");
    await connect([task("c", "Tes Jojo", 0)]);
    pick("Tes Jojo", "Active, light");
    expect(storage.keys().some((k) => k.endsWith("@user-1"))).toBe(true);

    pageLoad(storage, "user-2", "2026-11-12");
    await connect([task("c", "Tes Jojo", 0)]);
    expect(rows()).toEqual([{ title: "Tes Jojo", kind: "" }]);

    // localhost:5173 and the Vercel demo are two origins: two localStorages, nothing shared.
    pageLoad(fakeStorage(), "user-1", "2026-11-12");
    await connect([task("c", "Tes Jojo", 0)]);
    expect(rows()).toEqual([{ title: "Tes Jojo", kind: "" }]);
  });
});
