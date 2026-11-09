// Google Tasks in the browser (plan P20 W2.1, research §3.6). A Google Identity Services token client asks for
// read-only access in a Google popup; the token lives in memory only (about 1 hour) and never reaches our server.
// Open tasks are read straight from tasks.googleapis.com into this tab. Titles stay on this laptop (NOTES D-90); task
// notes are not kept at all, because nothing downstream needs them.
// Write access (W2.8, D-103) is asked for separately, only when the user presses "I finished it" on a Google task, and
// is used for one thing: setting that task's status to completed (completeTask), straight from this tab to Google.

// OAuth client "Web application" in Google Cloud project equilibre-513211, separate from the Supabase sign-in client so
// the sign-in never asks for Tasks (plan P20 W2.0). A client ID is a public identifier (it is in every page that uses
// it); the client secret is not used by the browser token flow and is not in this repo.
export const GOOGLE_CLIENT_ID = "845884031063-dup1aq7v01c7c0nbk56eq5d17bao0545.apps.googleusercontent.com";
export const TASKS_SCOPE = "https://www.googleapis.com/auth/tasks.readonly";
// Read and write; asked for incrementally (include_granted_scopes), so a user who never ticks a task off stays read-only.
export const TASKS_WRITE_SCOPE = "https://www.googleapis.com/auth/tasks";
export const GIS_SRC = "https://accounts.google.com/gsi/client";
export const TASKS_API = "https://tasks.googleapis.com/tasks/v1";

// Bounded reads: one page of lists, one page of open tasks per list (the API caps a page at 100).
export const TASKS_LIMITS = { lists: 20, tasksPerList: 100, titleMax: 300 } as const;

export type TaskList = { id: string; title: string };

export type ImportedTask = {
  id: string;
  listId: string;
  listTitle: string;
  title: string;
  due: string | null; // "YYYY-MM-DD": the API keeps the date and drops the time
  parent: string | null; // id of the parent task for a subtask
  order: number; // 0 = first task of the first list, as the lists and tasks are ordered in Google Tasks
};

// forbidden and missing come only from completeTask: HTTP 403 (no write permission) and 404 (no such task in the
// account of the token).
export type TasksErrorKind = "popup" | "denied" | "expired" | "forbidden" | "missing" | "api" | "network";

export class TasksError extends Error {
  readonly kind: TasksErrorKind;
  constructor(kind: TasksErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

export function parseLists(json: unknown): TaskList[] {
  const items = (json as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({ id: text(item?.id), title: text(item?.title).trim() }))
    .filter((list) => list.id !== "")
    .slice(0, TASKS_LIMITS.lists);
}

type RawTask = { id?: unknown; title?: unknown; status?: unknown; due?: unknown; parent?: unknown; position?: unknown; deleted?: unknown; hidden?: unknown };

// Open tasks of one list in Google Tasks order: top-level tasks by position, each followed by its subtasks. Completed,
// deleted, hidden and untitled tasks are dropped; a subtask whose parent is not open is kept at the top level.
export function parseTasks(json: unknown, list: TaskList): Omit<ImportedTask, "order">[] {
  const items = (json as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const open = (items as RawTask[])
    .filter((t) => text(t?.id) !== "" && text(t.title).trim() !== "")
    .filter((t) => t.status !== "completed" && t.deleted !== true && t.hidden !== true)
    .map((t) => {
      const due = text(t.due).slice(0, 10);
      const task: Omit<ImportedTask, "order"> = {
        id: text(t.id),
        listId: list.id,
        listTitle: list.title,
        title: text(t.title).trim().slice(0, TASKS_LIMITS.titleMax),
        due: /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : null,
        parent: text(t.parent) || null,
      };
      return { task, position: text(t.position) };
    });
  const ids = new Set(open.map(({ task }) => task.id));
  const byPosition = (a: { position: string }, b: { position: string }) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0);
  const top = open.filter(({ task }) => task.parent === null || !ids.has(task.parent)).sort(byPosition);
  const out: Omit<ImportedTask, "order">[] = [];
  for (const { task } of top) {
    out.push(task);
    for (const child of open.filter((o) => o.task.parent === task.id).sort(byPosition)) out.push(child.task);
  }
  return out;
}

export type Fetcher = (
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: string },
) => Promise<Pick<Response, "ok" | "status" | "json">>;

async function getJson(url: string, token: string, fetcher: Fetcher): Promise<unknown> {
  let response;
  try {
    response = await fetcher(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    throw new TasksError("network", "Google Tasks could not be reached.");
  }
  if (response.status === 401) throw new TasksError("expired", "Google access expired.");
  if (!response.ok) throw new TasksError("api", `Google Tasks answered HTTP ${response.status}.`);
  return response.json();
}

// All open tasks of the first lists, numbered in Google Tasks order.
export async function readTasks(token: string, fetcher: Fetcher = (url, init) => fetch(url, init)): Promise<ImportedTask[]> {
  const lists = parseLists(await getJson(`${TASKS_API}/users/@me/lists?maxResults=${TASKS_LIMITS.lists}`, token, fetcher));
  const perList = await Promise.all(
    lists.map(async (list) => {
      const query = `showCompleted=false&showHidden=false&maxResults=${TASKS_LIMITS.tasksPerList}`;
      return parseTasks(await getJson(`${TASKS_API}/lists/${encodeURIComponent(list.id)}/tasks?${query}`, token, fetcher), list);
    }),
  );
  return perList.flat().map((task, order) => ({ ...task, order }));
}

// Ticks one task off in Google Tasks (W2.8): PATCH with the list and task ids in the URL and nothing in the body but
// the new status, so no title or note ever leaves with it. Needs a token with TASKS_WRITE_SCOPE. The answer (the whole
// task) is not read.
export async function completeTask(
  token: string,
  task: Pick<ImportedTask, "id" | "listId">,
  fetcher: Fetcher = (url, init) => fetch(url, init),
): Promise<void> {
  const url = `${TASKS_API}/lists/${encodeURIComponent(task.listId)}/tasks/${encodeURIComponent(task.id)}`;
  let response;
  try {
    response = await fetcher(url, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    });
  } catch {
    throw new TasksError("network", "Google Tasks could not be reached.");
  }
  if (response.status === 401) throw new TasksError("expired", "Google access expired.");
  if (response.status === 403) throw new TasksError("forbidden", "Google Tasks did not allow the change.");
  if (response.status === 404) throw new TasksError("missing", "Google Tasks has no such task in this account.");
  if (!response.ok) throw new TasksError("api", `Google Tasks answered HTTP ${response.status}.`);
}

// --- Google Identity Services (browser only) ---

// scope: the space-separated scopes the user approved; with include_granted_scopes it also lists earlier grants.
type TokenResponse = { access_token?: string; expires_in?: number | string; scope?: string; error?: string };
type TokenError = { type?: string; message?: string };
type TokenClient = { requestAccessToken: (overrides?: { prompt?: string }) => void };
export type Gis = {
  accounts: {
    oauth2: {
      initTokenClient: (config: {
        client_id: string;
        scope: string;
        include_granted_scopes?: boolean;
        callback: (response: TokenResponse) => void;
        error_callback?: (error: TokenError) => void;
      }) => TokenClient;
      // With Google's granular consent the user can untick a scope and still get a token: this tells.
      hasGrantedAllScopes: (response: TokenResponse, ...scopes: string[]) => boolean;
      revoke: (token: string, done?: () => void) => void;
    };
  };
};

// write: the token also carries TASKS_WRITE_SCOPE (granted now, or in an earlier session to this client).
export type TasksToken = { value: string; expiresAt: number; write?: boolean };

let gis: Gis | null = null;
let gisLoading: Promise<Gis> | null = null;

export const gisReady = (): Gis | null => gis;

// The library is loaded only when the user asks to connect, so a session that never connects never contacts Google.
export function loadGis(timeoutMs = 15_000): Promise<Gis> {
  if (gis) return Promise.resolve(gis);
  gisLoading ??= new Promise<Gis>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GIS_SRC;
    script.async = true;
    const fail = () => {
      gisLoading = null;
      script.remove();
      reject(new TasksError("network", "The Google sign-in window could not be loaded."));
    };
    const timer = setTimeout(fail, timeoutMs);
    script.onload = () => {
      clearTimeout(timer);
      const found = (window as unknown as { google?: Gis }).google;
      if (!found?.accounts?.oauth2) return fail();
      gis = found;
      resolve(found);
    };
    script.onerror = () => {
      clearTimeout(timer);
      fail();
    };
    document.head.append(script);
  });
  return gisLoading;
}

// Opens Google's consent popup. Must run inside the click that asked for it, or the browser blocks the popup: the
// popup opens synchronously, in this call. write: ask for TASKS_WRITE_SCOPE on top of what was granted before
// (incremental authorization, W2.8); the user may still untick it, so the token says whether it was granted.
export function requestToken(lib: Gis, now: () => number = Date.now, write = false): Promise<TasksToken> {
  return new Promise((resolve, reject) => {
    const client = lib.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      ...(write ? { scope: TASKS_WRITE_SCOPE, include_granted_scopes: true } : { scope: TASKS_SCOPE }),
      callback: (response) => {
        if (!response.access_token) {
          reject(new TasksError("denied", response.error === "access_denied" ? "Access was not allowed." : "Google gave no access."));
          return;
        }
        const seconds = Number(response.expires_in) > 0 ? Number(response.expires_in) : 3600;
        resolve({
          value: response.access_token,
          expiresAt: now() + seconds * 1000,
          write: lib.accounts.oauth2.hasGrantedAllScopes(response, TASKS_WRITE_SCOPE),
        });
      },
      error_callback: (error) => {
        const kind = error.type === "popup_failed_to_open" ? "popup" : "denied";
        reject(new TasksError(kind, error.type === "popup_failed_to_open" ? "The browser blocked the Google window." : "The Google window was closed."));
      },
    });
    client.requestAccessToken();
  });
}

export function revokeToken(token: string): Promise<void> {
  return new Promise((resolve) => {
    if (!gis) return resolve();
    gis.accounts.oauth2.revoke(token, () => resolve());
  });
}
