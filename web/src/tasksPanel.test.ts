import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Settings card "Google Tasks" (tasksPanel.ts) over a minimal fake DOM, with Google's token and the Tasks API
// replaced: no network, no popup. What the panel decides when Connect or Refresh fails, and when "I finished it" on
// the plan card ticks a task off (W2.8).

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

import { completeTask, readTasks, requestToken, TasksError, type ImportedTask, type TasksToken } from "./googleTasks.ts";
import { NOT_TICKED, TasksPanel, TICKED } from "./tasksPanel.ts";

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
    expect(onChange).toHaveBeenCalledWith([TASK], true);
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

describe("Refresh", () => {
  it("renewing an expiring token goes through the Google window and says so; a plain Refresh does not (review, 8 Nov)", async () => {
    const onChange = vi.fn();
    const panel = new TasksPanel(onChange);
    const OTHER: ImportedTask = { ...TASK, id: "GT-zz99", title: "Another account's task" };
    vi.mocked(requestToken).mockResolvedValueOnce({ value: "token-a", expiresAt: Date.now() + 30_000 }); // < 1 min left
    vi.mocked(readTasks).mockResolvedValueOnce([TASK]);
    byId("tasks-connect").click();
    await settle();
    expect(onChange).toHaveBeenLastCalledWith([TASK], true);

    // The token is about to expire: Refresh opens the Google window again, where another account can be picked.
    vi.mocked(requestToken).mockResolvedValueOnce({ value: "token-b", expiresAt: Date.now() + 3_600_000 });
    vi.mocked(readTasks).mockResolvedValueOnce([OTHER]);
    byId("tasks-refresh").click();
    await settle();
    expect(requestToken).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith([OTHER], true);

    // Control: with the new token still valid, Refresh only reads, and the listener is told it is no new grant.
    vi.mocked(readTasks).mockResolvedValueOnce([OTHER]);
    byId("tasks-refresh").click();
    await settle();
    expect(requestToken).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith([OTHER], false);
    expect(panel.connected).toBe(true);
  });
});

describe("Tick a finished task off in Google Tasks (W2.8)", () => {
  const LUNCH: ImportedTask = { ...TASK, id: "GT-bb22", title: "Lunch with Bima", order: 1 };
  const hour = () => Date.now() + 3_600_000;

  // Connected with a read-only token unless told otherwise, two open tasks.
  async function connected(onChange = vi.fn(), token: TasksToken = { value: "token-r", expiresAt: hour() }) {
    const panel = new TasksPanel(onChange);
    vi.mocked(requestToken).mockResolvedValueOnce(token);
    vi.mocked(readTasks).mockResolvedValueOnce([TASK, LUNCH]);
    byId("tasks-connect").click();
    await settle();
    expect(panel.current).toEqual([TASK, LUNCH]);
    return panel;
  }

  it("asks for the write permission inside the click, PATCHes once with that token, keeps it, and drops the task", async () => {
    const onChange = vi.fn();
    const panel = await connected(onChange);
    vi.mocked(requestToken).mockResolvedValueOnce({ value: "token-w", expiresAt: hour(), write: true });
    vi.mocked(completeTask).mockResolvedValueOnce(undefined);
    const pending = panel.complete(TASK);
    // Before any await: the Google window opens inside the click (NOTES G-74), asking for the write scope.
    expect(requestToken).toHaveBeenCalledTimes(2);
    expect(vi.mocked(requestToken).mock.calls[1][2]).toBe(true);
    expect(await pending).toEqual({ ticked: true, message: TICKED });
    expect(completeTask).toHaveBeenCalledTimes(1);
    expect(completeTask).toHaveBeenCalledWith("token-w", TASK);
    expect(panel.current).toEqual([LUNCH]);
    expect(byId("tasks-count").textContent).toBe("1 open");
    expect(byId("tasks-status").textContent).toBe("Connected. 1 open tasks from 1 list.");
    expect(onChange).toHaveBeenCalledTimes(1); // the Connect only: the shown plan stays, the next refresh tells the log

    // The token that worked is kept: the next tick needs no Google window, and reads use it too.
    vi.mocked(completeTask).mockResolvedValueOnce(undefined);
    expect(await panel.complete(LUNCH)).toEqual({ ticked: true, message: TICKED });
    expect(requestToken).toHaveBeenCalledTimes(2);
    expect(completeTask).toHaveBeenLastCalledWith("token-w", LUNCH);
    vi.mocked(readTasks).mockResolvedValueOnce([]);
    byId("tasks-refresh").click();
    await settle();
    expect(readTasks).toHaveBeenLastCalledWith("token-w");
  });

  it("permission not given, the window closed or blocked: no PATCH, the task stays, and each tick asks again (negative control)", async () => {
    const panel = await connected();
    vi.mocked(requestToken).mockResolvedValueOnce({ value: "token-r2", expiresAt: hour(), write: false }); // write unticked
    expect(await panel.complete(TASK)).toEqual({ ticked: false, message: NOT_TICKED.declined });
    vi.mocked(requestToken).mockRejectedValueOnce(new TasksError("denied", "The Google window was closed."));
    expect(await panel.complete(TASK)).toEqual({ ticked: false, message: NOT_TICKED.denied });
    vi.mocked(requestToken).mockRejectedValueOnce(new TasksError("popup", "The browser blocked the Google window."));
    expect(await panel.complete(TASK)).toEqual({ ticked: false, message: NOT_TICKED.popup });
    expect(requestToken).toHaveBeenCalledTimes(4);
    expect(completeTask).not.toHaveBeenCalled();
    expect(panel.current).toEqual([TASK, LUNCH]);
    expect(NOT_TICKED.declined).toBe("Not ticked off in Google Tasks: permission not given. Tick it off there.");
  });

  it("403 or 404 to a token from the Google window: not ticked, the task stays, that token is not kept (another account?)", async () => {
    const panel = await connected();
    vi.mocked(requestToken).mockResolvedValueOnce({ value: "token-b", expiresAt: hour(), write: true });
    vi.mocked(completeTask).mockRejectedValueOnce(new TasksError("missing", "Google Tasks has no such task in this account."));
    expect(await panel.complete(TASK)).toEqual({ ticked: false, message: NOT_TICKED.missing });
    expect(panel.current).toEqual([TASK, LUNCH]);
    vi.mocked(readTasks).mockResolvedValueOnce([TASK, LUNCH]);
    byId("tasks-refresh").click();
    await settle();
    expect(readTasks).toHaveBeenLastCalledWith("token-r"); // still the connected account's token

    vi.mocked(requestToken).mockResolvedValueOnce({ value: "token-b", expiresAt: hour(), write: true });
    vi.mocked(completeTask).mockRejectedValueOnce(new TasksError("forbidden", "Google Tasks did not allow the change."));
    expect(await panel.complete(TASK)).toEqual({ ticked: false, message: NOT_TICKED.forbidden });
    expect(requestToken).toHaveBeenCalledTimes(3); // asked again, since the first token was not kept
    expect(completeTask).toHaveBeenCalledTimes(2);
    expect(panel.current).toEqual([TASK, LUNCH]);
    expect(NOT_TICKED.missing).toContain("another account");
  });

  it("401 on the kept token: says access expired, and Refresh then goes through the Google window", async () => {
    const panel = await connected(vi.fn(), { value: "token-w", expiresAt: hour(), write: true }); // granted in an earlier session
    vi.mocked(completeTask).mockRejectedValueOnce(new TasksError("expired", "Google access expired."));
    expect(await panel.complete(TASK)).toEqual({ ticked: false, message: NOT_TICKED.expired });
    expect(requestToken).toHaveBeenCalledTimes(1); // the token had write: no window for the tick
    expect(completeTask).toHaveBeenCalledWith("token-w", TASK);
    expect(NOT_TICKED.expired).toContain("Refresh in Settings → Google Tasks");
    vi.mocked(readTasks).mockResolvedValueOnce([TASK, LUNCH]);
    byId("tasks-refresh").click();
    await settle();
    expect(requestToken).toHaveBeenCalledTimes(2);
  });

  it("a task not in the Google list (the demo's sample tasks), no connection, or a tick still waiting: nothing is sent", async () => {
    const SAMPLE: ImportedTask = { ...TASK, id: "sample-rina-1", listId: "sample-rina" };
    const panel = await connected(vi.fn(), { value: "token-w", expiresAt: hour(), write: true });
    expect(await panel.complete(SAMPLE)).toEqual({ ticked: false, message: NOT_TICKED.gone });

    let release = () => {};
    vi.mocked(completeTask).mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    const first = panel.complete(TASK);
    expect(await panel.complete(LUNCH)).toEqual({ ticked: false, message: NOT_TICKED.busy });
    release();
    expect(await first).toEqual({ ticked: true, message: TICKED });
    expect(completeTask).toHaveBeenCalledTimes(1);
    expect(requestToken).toHaveBeenCalledTimes(1); // the Connect only

    // Last: a second panel on the same fake buttons would also answer their clicks.
    expect(await new TasksPanel().complete(TASK)).toEqual({ ticked: false, message: NOT_TICKED.disconnected });
    expect(completeTask).toHaveBeenCalledTimes(1);
  });
});
