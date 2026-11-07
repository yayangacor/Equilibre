// Google Tasks import in the browser (plan P20 W2.1, research §3.6). A Google Identity Services token client asks for
// read-only access in a Google popup; the token lives in memory only (about 1 hour) and never reaches our server.
// Open tasks are read straight from tasks.googleapis.com into this tab. Titles stay on this laptop (NOTES D-90); task
// notes are not kept at all, because nothing downstream needs them.

// OAuth client "Web application" in Google Cloud project equilibre-513211, separate from the Supabase sign-in client so
// the sign-in never asks for Tasks (plan P20 W2.0). A client ID is a public identifier (it is in every page that uses
// it); the client secret is not used by the browser token flow and is not in this repo.
export const GOOGLE_CLIENT_ID = "845884031063-dup1aq7v01c7c0nbk56eq5d17bao0545.apps.googleusercontent.com";
export const TASKS_SCOPE = "https://www.googleapis.com/auth/tasks.readonly";
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

export type TasksErrorKind = "popup" | "denied" | "expired" | "api" | "network";

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

export type Fetcher = (url: string, init: { headers: Record<string, string> }) => Promise<Pick<Response, "ok" | "status" | "json">>;

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

// --- Google Identity Services (browser only) ---

type TokenResponse = { access_token?: string; expires_in?: number | string; error?: string };
type TokenError = { type?: string; message?: string };
type TokenClient = { requestAccessToken: (overrides?: { prompt?: string }) => void };
export type Gis = {
  accounts: {
    oauth2: {
      initTokenClient: (config: {
        client_id: string;
        scope: string;
        callback: (response: TokenResponse) => void;
        error_callback?: (error: TokenError) => void;
      }) => TokenClient;
      revoke: (token: string, done?: () => void) => void;
    };
  };
};

export type TasksToken = { value: string; expiresAt: number };

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

// Opens Google's consent popup. Must run inside the click that asked for it, or the browser blocks the popup.
export function requestToken(lib: Gis, now: () => number = Date.now): Promise<TasksToken> {
  return new Promise((resolve, reject) => {
    const client = lib.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: TASKS_SCOPE,
      callback: (response) => {
        if (!response.access_token) {
          reject(new TasksError("denied", response.error === "access_denied" ? "Access was not allowed." : "Google gave no access."));
          return;
        }
        const seconds = Number(response.expires_in) > 0 ? Number(response.expires_in) : 3600;
        resolve({ value: response.access_token, expiresAt: now() + seconds * 1000 });
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
