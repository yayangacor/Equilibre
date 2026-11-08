import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Settings card "Google Tasks" (tasksPanel.ts) over a minimal fake DOM, with Google's token and the Tasks API
// replaced: no network, no popup. What the panel decides when Connect or Refresh fails.

vi.mock("./googleTasks.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./googleTasks.ts")>();
  return { ...real, gisReady: vi.fn(() => ({})), loadGis: vi.fn(), requestToken: vi.fn(), readTasks: vi.fn(), revokeToken: vi.fn(async () => {}) };
});

import { readTasks, requestToken, TasksError, type ImportedTask } from "./googleTasks.ts";
import { TasksPanel } from "./tasksPanel.ts";

class FakeElement {
  textContent = "";
  hidden = false;
  disabled = false;
  className = "";
  children: FakeElement[] = [];
  private readonly clicks: (() => void)[] = [];
  addEventListener(type: string, listener: () => void) {
    if (type === "click") this.clicks.push(listener);
  }
  click() {
    for (const listener of this.clicks) listener();
  }
  replaceChildren(...nodes: FakeElement[]) {
    this.children = nodes;
  }
  append(...nodes: FakeElement[]) {
    this.children.push(...nodes);
  }
}

let elements: Map<string, FakeElement>;
const byId = (id: string) => elements.get(id)!;

beforeEach(() => {
  elements = new Map(["tasks-connect", "tasks-refresh", "tasks-disconnect", "tasks-status", "tasks-list", "tasks-count"].map((id) => [id, new FakeElement()]));
  vi.stubGlobal("document", { getElementById: (id: string) => elements.get(id) ?? null, createElement: () => new FakeElement() });
  vi.mocked(requestToken).mockResolvedValue({ value: "token-a", expiresAt: Date.now() + 3_600_000 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const TASK: ImportedTask = { id: "GT-aa11", listId: "L1", listTitle: "Work", title: "Write Q3 report", due: null, parent: null, order: 0 };

describe("Connect", () => {
  it("a failed first read leaves the panel disconnected with the error, not connected with no tasks (review B, 8 Nov)", async () => {
    const onChange = vi.fn();
    const panel = new TasksPanel(onChange);
    vi.mocked(readTasks).mockRejectedValueOnce(new TasksError("network", "Google Tasks could not be reached."));
    byId("tasks-connect").click();
    await settle();
    expect(panel.connected).toBe(false);
    expect(byId("tasks-status").textContent).toBe("Google could not be reached. Check your connection.");
    expect(byId("tasks-connect").hidden).toBe(false);
    expect(byId("tasks-count").textContent).toBe("");
    expect(onChange).not.toHaveBeenCalled();

    // Positive control: the same Connect with a working read connects.
    vi.mocked(readTasks).mockResolvedValueOnce([TASK]);
    byId("tasks-connect").click();
    await settle();
    expect(panel.connected).toBe(true);
    expect(panel.current).toEqual([TASK]);
    expect(onChange).toHaveBeenCalledWith([TASK]);
    expect(byId("tasks-status").textContent).toBe("Connected. 1 open tasks from 1 list.");
  });

  it("an API error on a later Refresh keeps the connection and the tasks already read", async () => {
    const panel = new TasksPanel();
    vi.mocked(readTasks).mockResolvedValueOnce([TASK]);
    byId("tasks-connect").click();
    await settle();
    vi.mocked(readTasks).mockRejectedValueOnce(new TasksError("api", "Google Tasks answered HTTP 503."));
    byId("tasks-refresh").click();
    await settle();
    expect(panel.connected).toBe(true);
    expect(panel.current).toEqual([TASK]);
    expect(byId("tasks-status").textContent).toBe("Google Tasks did not answer. Try again in a moment.");
  });
});
