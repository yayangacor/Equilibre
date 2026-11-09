import { describe, expect, it } from "vitest";
import {
  completeTask,
  GOOGLE_CLIENT_ID,
  type Gis,
  type ImportedTask,
  parseLists,
  parseTasks,
  readTasks,
  requestToken,
  TASKS_API,
  TASKS_LIMITS,
  TASKS_SCOPE,
  TASKS_WRITE_SCOPE,
  TasksError,
} from "./googleTasks.ts";

const LIST = { id: "L1", title: "Work" };

describe("parseLists", () => {
  it("keeps lists with an id, trims titles and caps the count", () => {
    const items = [{ id: "a", title: " Work " }, { title: "no id" }, ...Array.from({ length: 30 }, (_, i) => ({ id: `x${i}`, title: "" }))];
    const lists = parseLists({ items });
    expect(lists[0]).toEqual({ id: "a", title: "Work" });
    expect(lists).toHaveLength(TASKS_LIMITS.lists);
    expect(lists.some((l) => l.title === "no id")).toBe(false);
  });

  it("reads an empty or odd answer as no lists", () => {
    expect(parseLists({})).toEqual([]);
    expect(parseLists(null)).toEqual([]);
    expect(parseLists({ items: "x" })).toEqual([]);
  });
});

describe("parseTasks", () => {
  it("keeps open tasks in Google Tasks order, each subtask right after its parent", () => {
    const items = [
      { id: "b", title: "Write report", position: "00000000000000000002" },
      { id: "c", title: "Outline", parent: "b", position: "00000000000000000001" },
      { id: "a", title: "Reply to Dina", position: "00000000000000000001", due: "2026-11-09T00:00:00.000Z" },
      { id: "c0", title: "Intro", parent: "b", position: "00000000000000000000" },
    ];
    const tasks = parseTasks({ items }, LIST);
    expect(tasks.map((t) => t.id)).toEqual(["a", "b", "c0", "c"]);
    expect(tasks[0]).toEqual({ id: "a", listId: "L1", listTitle: "Work", title: "Reply to Dina", due: "2026-11-09", parent: null });
    expect(tasks[2].parent).toBe("b");
  });

  it("drops completed, deleted, hidden and untitled tasks (negative control: an open task stays)", () => {
    const items = [
      { id: "1", title: "Done", status: "completed" },
      { id: "2", title: "Gone", deleted: true },
      { id: "3", title: "Hidden", hidden: true },
      { id: "4", title: "   " },
      { id: "5", title: "Open", status: "needsAction" },
    ];
    expect(parseTasks({ items }, LIST).map((t) => t.id)).toEqual(["5"]);
  });

  it("keeps a subtask whose parent is not open at the top level", () => {
    const items = [{ id: "kid", title: "Proofread", parent: "finished-parent" }];
    expect(parseTasks({ items }, LIST)[0]).toMatchObject({ id: "kid", parent: "finished-parent" });
  });

  it("keeps only the date of a due time, rejects odd dates and caps long titles", () => {
    const items = [
      { id: "1", title: "x".repeat(2000), due: "soon" },
      { id: "2", title: "y", due: "2026-11-10" },
    ];
    const [long, dated] = parseTasks({ items }, LIST);
    expect(long.title).toHaveLength(TASKS_LIMITS.titleMax);
    expect(long.due).toBeNull();
    expect(dated.due).toBe("2026-11-10");
  });

  it("never keeps task notes or links", () => {
    const items = [{ id: "1", title: "Call", notes: "private phone 0812", links: [{ link: "https://x" }], selfLink: "https://y" }];
    expect(JSON.stringify(parseTasks({ items }, LIST))).not.toMatch(/0812|https:/);
  });
});

type Call = { url: string; auth: string };

function fakeFetch(routes: Record<string, { status?: number; body?: unknown }>, calls: Call[] = []) {
  return async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, auth: init.headers.Authorization });
    const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))?.[1];
    if (!route) throw new Error(`unexpected ${url}`);
    const status = route.status ?? 200;
    return { ok: status < 300, status, json: async () => route.body };
  };
}

describe("readTasks", () => {
  const routes = {
    [`${TASKS_API}/users/@me/lists`]: { body: { items: [{ id: "L1", title: "Work" }, { id: "L/2", title: "Home" }] } },
    [`${TASKS_API}/lists/L1/tasks`]: { body: { items: [{ id: "w1", title: "Report", position: "1" }] } },
    [`${TASKS_API}/lists/L%2F2/tasks`]: { body: { items: [{ id: "h1", title: "Groceries", position: "1" }] } },
  };

  it("reads every list's open tasks with the token and numbers them across lists", async () => {
    const calls: Call[] = [];
    const tasks = await readTasks("tok", fakeFetch(routes, calls));
    expect(tasks.map((t) => [t.id, t.listTitle, t.order])).toEqual([["w1", "Work", 0], ["h1", "Home", 1]]);
    expect(calls.every((c) => c.auth === "Bearer tok")).toBe(true);
    expect(calls.every((c) => c.url.startsWith(TASKS_API))).toBe(true);
    const taskCalls = calls.filter((c) => c.url.includes("/tasks?"));
    expect(taskCalls).toHaveLength(2);
    expect(taskCalls.every((c) => c.url.includes("showCompleted=false") && c.url.includes("showHidden=false"))).toBe(true);
  });

  it("tells an expired token, an API error and no network apart", async () => {
    const lists = `${TASKS_API}/users/@me/lists`;
    const kind = (p: Promise<unknown>) => p.then(() => "ok", (e: TasksError) => e.kind);
    expect(await kind(readTasks("t", fakeFetch({ [lists]: { status: 401 } })))).toBe("expired");
    expect(await kind(readTasks("t", fakeFetch({ [lists]: { status: 403 } })))).toBe("api");
    expect(await kind(readTasks("t", async () => Promise.reject(new TypeError("offline"))))).toBe("network");
  });
});

// Google's answer arrives later, as from the popup; `opened` counts requestAccessToken calls, which open the popup.
// hasGrantedAllScopes reads the answer's space-separated scope list, as the real library does (gsi/client, 9 Nov).
function fakeGis(answer: (cb: { callback: (r: object) => void; error?: (e: object) => void }) => void) {
  const configs: { client_id: string; scope: string; include_granted_scopes?: boolean }[] = [];
  const state = { opened: 0 };
  const lib: Gis = {
    accounts: {
      oauth2: {
        initTokenClient: (config) => {
          configs.push(config);
          return {
            requestAccessToken: () => {
              state.opened++;
              queueMicrotask(() => answer({ callback: config.callback, error: config.error_callback }));
            },
          };
        },
        hasGrantedAllScopes: (response, ...scopes) => {
          const granted = (response.scope ?? "").split(" ");
          return scopes.length > 0 && scopes.every((s) => granted.includes(s));
        },
        revoke: (_t, done) => done?.(),
      },
    },
  };
  return { lib, configs, state };
}

describe("requestToken", () => {
  it("asks for read-only Tasks access with the Equilibre client and keeps the expiry", async () => {
    const { lib, configs } = fakeGis(({ callback }) => callback({ access_token: "abc", expires_in: "3599", scope: TASKS_SCOPE }));
    const token = await requestToken(lib, () => 1_000);
    expect(token).toEqual({ value: "abc", expiresAt: 1_000 + 3_599_000, write: false });
    expect(configs).toEqual([{ client_id: GOOGLE_CLIENT_ID, scope: TASKS_SCOPE, callback: expect.any(Function), error_callback: expect.any(Function) }]);
    expect(TASKS_SCOPE).toBe("https://www.googleapis.com/auth/tasks.readonly");
  });

  it("asks for the write scope incrementally, opening the window in the same call (W2.8)", async () => {
    const { lib, configs, state } = fakeGis(({ callback }) =>
      callback({ access_token: "w", expires_in: 3600, scope: `${TASKS_SCOPE} ${TASKS_WRITE_SCOPE}` }),
    );
    const pending = requestToken(lib, () => 0, true);
    expect(state.opened).toBe(1); // synchronously, still inside the click that called it (NOTES G-74)
    expect(configs[0]).toMatchObject({ client_id: GOOGLE_CLIENT_ID, scope: TASKS_WRITE_SCOPE, include_granted_scopes: true });
    expect(TASKS_WRITE_SCOPE).toBe("https://www.googleapis.com/auth/tasks");
    expect(await pending).toEqual({ value: "w", expiresAt: 3_600_000, write: true });
  });

  it("a token without the write scope says so: the user unticked it in Google's window (negative control)", async () => {
    const { lib } = fakeGis(({ callback }) => callback({ access_token: "r", expires_in: 3600, scope: TASKS_SCOPE }));
    expect((await requestToken(lib, () => 0, true)).write).toBe(false);
    // An earlier write grant comes back with a read-only Connect too (include_granted_scopes is Google's default).
    const earlier = fakeGis(({ callback }) => callback({ access_token: "r", expires_in: 3600, scope: `${TASKS_SCOPE} ${TASKS_WRITE_SCOPE}` }));
    expect((await requestToken(earlier.lib, () => 0)).write).toBe(true);
  });

  it("rejects when access is refused, the window is closed or the popup is blocked", async () => {
    const kind = (p: Promise<unknown>) => p.then(() => "ok", (e: TasksError) => e.kind);
    expect(await kind(requestToken(fakeGis(({ callback }) => callback({ error: "access_denied" })).lib))).toBe("denied");
    expect(await kind(requestToken(fakeGis(({ error }) => error?.({ type: "popup_closed" })).lib))).toBe("denied");
    expect(await kind(requestToken(fakeGis(({ error }) => error?.({ type: "popup_failed_to_open" })).lib))).toBe("popup");
  });
});

type Sent = { url: string; method?: string; headers: Record<string, string>; body?: string };

describe("completeTask (W2.8)", () => {
  const TASK: ImportedTask = { id: "t#1/a", listId: "L/2", listTitle: "Private list", title: "Call Dina about the merger", due: null, parent: null, order: 0 };
  const answering = (status: number, sent: Sent[] = []) => async (url: string, init: Omit<Sent, "url">) => {
    sent.push({ url, ...init });
    return { ok: status < 300, status, json: async () => ({ id: TASK.id, title: TASK.title, status: "completed" }) };
  };

  it("sends one PATCH to the encoded list and task, with only the status in the body and never a title", async () => {
    const sent: Sent[] = [];
    await completeTask("tok", TASK, answering(200, sent));
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`${TASKS_API}/lists/L%2F2/tasks/t%231%2Fa`);
    expect(sent[0].method).toBe("PATCH");
    expect(sent[0].headers).toEqual({ Authorization: "Bearer tok", "Content-Type": "application/json" });
    expect(sent[0].body).toBe('{"status":"completed"}');
    expect(JSON.stringify(sent)).not.toMatch(/Dina|merger|Private list/);
  });

  it("tells an expired token, no write permission, no such task, an API error and no network apart", async () => {
    const kind = (p: Promise<unknown>) => p.then(() => "ok", (e: TasksError) => e.kind);
    expect(await kind(completeTask("t", TASK, answering(200)))).toBe("ok");
    expect(await kind(completeTask("t", TASK, answering(401)))).toBe("expired");
    expect(await kind(completeTask("t", TASK, answering(403)))).toBe("forbidden");
    expect(await kind(completeTask("t", TASK, answering(404)))).toBe("missing");
    expect(await kind(completeTask("t", TASK, answering(503)))).toBe("api");
    expect(await kind(completeTask("t", TASK, async () => Promise.reject(new TypeError("offline"))))).toBe("network");
  });
});
