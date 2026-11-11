import type { KeyValueStore } from "./calibration.ts";
import {
  completeTask,
  gisReady,
  type ImportedTask,
  loadGis,
  readTasks,
  requestToken,
  revokeToken,
  TasksError,
  type TasksErrorKind,
  type TasksToken,
} from "./googleTasks.ts";
import { icon } from "./icons.ts";
import { RUBRIC_CHOICES } from "./planCard.ts";
import type { TagMemoryStore } from "./taskTagger.ts";
import { groupTasks, setGroupKind, type TaskGroup } from "./tasksView.ts";

// The Tasks page (plan P20 W2.1, moved out of Settings 11 Nov): connect, sync, disconnect, the kind of each task, and
// ticking a finished task off for the plan card (W2.8). The token lives in memory and in this tab's sessionStorage, so a
// reload keeps it and closing the tab forgets it; the tasks are never stored. Titles go to the DOM via textContent.
//
// All day (user 11 Nov): a token lasts about an hour and Google renews it only from a click (GIS token model). So once
// connected the app remembers that (a flag, no token) and renews inside the user's next click on Tasks, Plan or Resume,
// without the consent screen; while the token is valid it reads Google Tasks every minute and when the tab comes back.

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const RENEW_BEFORE_MS = 60_000; // ask Google again when the token has less than a minute left
export const SYNC_MS = 60_000;
const SYNC_ON_RETURN_MS = 20_000; // the tab came back: read again if the last read is older than this
const MEMBERS_SHOWN = 4;
// The line above the list: kinds are kept per task on this laptop (taskTagger.ts), so only new tasks ask (user 11 Nov).
export const KIND_NOTE = {
  idle: "Set a kind so plans fit your energy.",
  done: "Every task has a kind. Only new tasks will ask.",
  missing: (n: number) => `${n} ${n === 1 ? "task needs" : "tasks need"} a kind. The ones you set are kept.`,
};
export const TOKEN_KEY = "equilibre.google-tasks.token";
export const LINKED_KEY = "equilibre.google-tasks.linked";

// Connect and Refresh (reads never answer forbidden or missing; anything else reads as api).
const MESSAGES: Partial<Record<TasksErrorKind, string>> & { api: string } = {
  popup: "Popup blocked. Press Connect again.",
  denied: "Not connected.",
  expired: "Access expired. Press Resume.",
  api: "Google Tasks didn't answer. Try again.",
  network: "Can't reach Google. Check your connection.",
};

// "I finished it" on a Google task (W2.8): one line on the plan card, ticked or why not.
export type TickResult = { ticked: boolean; message: string };

export const TICKED = "Ticked off in Google Tasks.";
export const NOT_TICKED: Record<TasksErrorKind | "declined" | "busy" | "gone" | "disconnected", string> = {
  declined: "Not ticked off: no permission. Tick it off in Google Tasks.",
  denied: "Not ticked off: no permission. Tick it off in Google Tasks.",
  popup: "Not ticked off: popup blocked. Tick it off in Google Tasks.",
  expired: "Not ticked off: access expired. Press Resume on the Tasks page.",
  forbidden: "Not ticked off: no permission to edit tasks. Tick it off in Google Tasks.",
  missing: "Not ticked off: task not found in this Google account.",
  api: "Not ticked off: Google Tasks didn't answer. Tick it off there.",
  network: "Not ticked off: can't reach Google. Tick it off in Google Tasks.",
  busy: "Not ticked off: still saving the last one. Tick this one off in Google Tasks.",
  gone: "Not ticked off: no longer in your list.",
  disconnected: "Not ticked off: Google Tasks isn't connected.",
};

const sameTask = (a: ImportedTask, b: ImportedTask) => a.id === b.id && a.listId === b.listId;
// What a read changes for the plan: the open tasks, their titles, due days and order.
const signature = (tasks: readonly ImportedTask[]) => JSON.stringify(tasks.map((t) => [t.listId, t.id, t.title, t.due, t.order]));

const dueFormat = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const clock = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

export type KindDeps = { store: () => TagMemoryStore; today: () => string; onChange: () => void };
export type OnTasks = (tasks: readonly ImportedTask[], newGrant: boolean, changed: boolean) => void;

function parseToken(raw: string | null, now: number): TasksToken | null {
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as Partial<TasksToken>;
    if (typeof t.value !== "string" || typeof t.expiresAt !== "number" || t.expiresAt - now < RENEW_BEFORE_MS) return null;
    return { value: t.value, expiresAt: t.expiresAt, write: t.write === true };
  } catch {
    return null;
  }
}

export class TasksPanel {
  private token: TasksToken | null = null;
  private tasks: ImportedTask[] = [];
  private busy = false;
  private ticking = false; // a tick-off is waiting for Google
  private syncedAt: number | null = null;
  private linked = false; // connected before in this browser: Resume renews without the consent screen
  private session: KeyValueStore | null = null;
  private local: KeyValueStore | null = null;
  private kinds: KindDeps | null = null;
  private readonly connectButton = byId<HTMLButtonElement>("tasks-connect");
  private readonly refreshButton = byId<HTMLButtonElement>("tasks-refresh");
  private readonly disconnectButton = byId<HTMLButtonElement>("tasks-disconnect");
  private readonly status = byId("tasks-status");
  private readonly list = byId<HTMLUListElement>("tasks-list");
  private readonly count = byId("tasks-count");
  private readonly kindNote = byId("tasks-kind-note") as HTMLElement | null;

  // newGrant: the tasks came with a token from the Google window (Connect, Resume, or Refresh renewing an expiring
  // token). That window can switch to another signed-in Google account, and the token does not say which (review, 8 Nov).
  // changed: the open tasks differ from the last read (or the token is new); a minute's sync that finds the same tasks
  // still reports the read (the decision log learns that a planned task is still open), with changed false.
  private readonly onChange: OnTasks;

  constructor(onChange: OnTasks = () => {}) {
    this.onChange = onChange;
    this.connectButton.addEventListener("click", () => void (this.linked ? this.renew() : this.connect()));
    this.refreshButton.addEventListener("click", () => void this.refresh());
    this.disconnectButton.addEventListener("click", () => void this.disconnect());
    this.render();
  }

  get current(): readonly ImportedTask[] {
    return this.tasks;
  }

  // Google access granted in this tab, whether or not any task is open ("Plan my next hour", planCard.ts).
  get connected(): boolean {
    return this.token !== null;
  }

  // The kind picker on each row (tasksView.ts); without it the rows show titles and due days only.
  useKinds(kinds: KindDeps) {
    this.kinds = kinds;
    this.render();
  }

  // After a reload: the token of this tab if it still has time left, and whether this browser connected before.
  // A browser that connected before loads Google's library now, so Resume can open Google's window inside its click.
  restore(session: KeyValueStore | null, local: KeyValueStore | null) {
    this.session = session;
    this.local = local;
    this.linked = local?.getItem(LINKED_KEY) === "1";
    const token = parseToken(session?.getItem(TOKEN_KEY) ?? null, Date.now());
    if (this.linked) void Promise.resolve().then(() => loadGis()).catch(() => {});
    if (token) void this.quiet(token, true);
    else if (this.linked) this.status.textContent = "Paused. Press Resume to sync.";
    this.render();
  }

  // Reads Google Tasks every SYNC_MS while the token is valid and the tab is visible, and when the tab comes back.
  startSync(intervalMs = SYNC_MS) {
    const tick = (minAgeMs: number) => {
      const token = this.token;
      if (!token || this.busy || document.visibilityState === "hidden") return;
      if (token.expiresAt - Date.now() < RENEW_BEFORE_MS) return this.expire();
      if (this.syncedAt !== null && Date.now() - this.syncedAt < minAgeMs) return;
      void this.quiet(token, false);
    };
    setInterval(() => tick(0), intervalMs);
    document.addEventListener("visibilitychange", () => tick(SYNC_ON_RETURN_MS));
    window.addEventListener("focus", () => tick(SYNC_ON_RETURN_MS));
  }

  // Inside a click elsewhere (the Tasks tab, Plan my next hour): renews an expired access without the consent screen,
  // since the Google window may only open from a click (NOTES G-74). Does nothing while the token is good, or when this
  // browser never connected, or Google's library is not loaded yet.
  renewInClick(): Promise<void> | null {
    const token = this.token;
    if (!this.linked || this.busy || (token && token.expiresAt - Date.now() >= RENEW_BEFORE_MS) || !gisReady()) return null;
    return this.renew();
  }

  private async connect() {
    if (this.busy) return;
    this.setBusy(true, "Opening Google…");
    try {
      // The popup needs the click's user activation: reuse the loaded library when there is one.
      const lib = gisReady() ?? (await loadGis());
      // The new token is kept only once the first read worked: a failed read leaves the panel as it was, with the
      // error shown, never "connected, no open tasks" (review B, 8 Nov).
      await this.load(await requestToken(lib), true);
    } catch (error) {
      this.fail(error);
    } finally {
      this.setBusy(false);
    }
  }

  // A new token for an access granted before: Google's window opens and closes by itself (prompt "").
  private async renew() {
    if (this.busy) return;
    this.setBusy(true, "Renewing access…");
    try {
      const lib = gisReady() ?? (await loadGis());
      await this.load(await requestToken(lib, Date.now, false, true), true);
    } catch (error) {
      this.fail(error);
    } finally {
      this.setBusy(false);
    }
  }

  private async refresh() {
    const token = this.token;
    if (!token || token.expiresAt - Date.now() < RENEW_BEFORE_MS) return this.linked ? this.renew() : this.connect();
    if (this.busy) return;
    this.setBusy(true, "Syncing…");
    try {
      await this.load(token, false);
    } catch (error) {
      this.fail(error);
    } finally {
      this.setBusy(false);
    }
  }

  // A read with no button pressed (sync, reload): errors only change the status line, and the token stays unless it
  // expired.
  private async quiet(token: TasksToken, restored: boolean) {
    this.busy = true;
    try {
      await this.load(token, restored);
    } catch (error) {
      this.fail(error);
    } finally {
      this.busy = false;
    }
  }

  // Reads the tasks with this token, then keeps both, and tells the listener whether anything changed.
  private async load(token: TasksToken, newGrant: boolean) {
    const tasks = await readTasks(token.value);
    const changed = signature(tasks) !== signature(this.tasks) || this.token === null;
    this.token = token;
    this.tasks = tasks;
    this.syncedAt = Date.now();
    this.keep(token);
    this.onChange(this.tasks, newGrant, changed || newGrant);
    this.status.textContent = this.connectedLine();
    this.render();
  }

  private keep(token: TasksToken | null) {
    try {
      if (token) {
        this.session?.setItem(TOKEN_KEY, JSON.stringify(token));
        this.local?.setItem(LINKED_KEY, "1");
        this.linked = true;
      } else {
        this.session?.removeItem(TOKEN_KEY);
        this.local?.removeItem(LINKED_KEY);
        this.linked = false;
      }
    } catch {
      // storage blocked: the connection still works in this tab, it is just not kept over a reload
    }
  }

  private connectedLine(): string {
    const lists = new Set(this.tasks.map((t) => t.listId)).size;
    const synced = this.syncedAt === null ? "" : ` · synced ${clock(this.syncedAt)}`;
    return this.tasks.length === 0 ? `No open tasks${synced}` : `${lists} ${lists === 1 ? "list" : "lists"}${synced}`;
  }

  // The hour is up: the last tasks stay for planning, and the next click on Tasks, Plan or Resume renews.
  private expire() {
    this.session?.removeItem(TOKEN_KEY);
    this.status.textContent = "Paused. Press Resume to sync.";
    this.render();
  }

  private get paused(): boolean {
    return this.token !== null && this.token.expiresAt - Date.now() < RENEW_BEFORE_MS;
  }

  // "I finished it" on the plan card for this Google task (W2.8, D-103): sets its status to completed in Google Tasks,
  // straight from this tab (completeTask: ids in the URL, only the status in the body). Never called but from that
  // click. Connect asks for read-only access; the write permission is asked for here the first time, so the Google
  // window must open inside the click (NOTES G-74): with the library loaded at Connect, requestToken runs before the
  // first await. Never throws: the result is a line for the card.
  // A token from that window may be another signed-in Google account (as with Refresh, 5858614): it is kept, for
  // reads too, only once the PATCH answered 2xx, which a task of this account's list does only for this account. Until
  // then the panel's token, and what the decision log watches, stay as they were. After a tick the task leaves the
  // open list here without telling the listener: the shown plan stays, and the next refresh sees the task closed.
  async complete(task: ImportedTask): Promise<TickResult> {
    const token = this.token;
    if (!token) return { ticked: false, message: NOT_TICKED.disconnected };
    if (!this.tasks.some((t) => sameTask(t, task))) return { ticked: false, message: NOT_TICKED.gone };
    if (this.ticking) return { ticked: false, message: NOT_TICKED.busy };
    this.ticking = true;
    let use = token;
    try {
      if (!token.write || token.expiresAt - Date.now() < RENEW_BEFORE_MS) {
        const granted = await requestToken(gisReady() ?? (await loadGis()), Date.now, true);
        if (!granted.write) return { ticked: false, message: NOT_TICKED.declined };
        if (this.token === null) return { ticked: false, message: NOT_TICKED.disconnected }; // Disconnect meanwhile
        use = granted;
      }
      await completeTask(use.value, task);
      if (use !== token && this.token === token) {
        this.token = use;
        this.keep(use);
      }
      this.tasks = this.tasks.filter((t) => !sameTask(t, task));
      this.status.textContent = this.connectedLine();
      this.render();
      return { ticked: true, message: TICKED };
    } catch (error) {
      const kind = error instanceof TasksError ? error.kind : "api";
      // The panel's own token failed: Refresh then goes through the Google window (expired), and the next tick asks
      // for the write permission again (forbidden: it was removed in the Google account).
      if (use === token && this.token === token) {
        if (kind === "expired") this.token = { ...token, expiresAt: 0 };
        if (kind === "forbidden") this.token = { ...token, write: false };
      }
      return { ticked: false, message: NOT_TICKED[kind] };
    } finally {
      this.ticking = false;
    }
  }

  private async disconnect() {
    const token = this.token;
    this.token = null;
    this.tasks = [];
    this.syncedAt = null;
    this.keep(null);
    this.onChange(this.tasks, false, true);
    this.render();
    this.status.textContent = "Disconnected.";
    if (token) await revokeToken(token.value);
  }

  private fail(error: unknown) {
    const kind = error instanceof TasksError ? error.kind : "api";
    if (kind === "expired") {
      this.token = null;
      this.session?.removeItem(TOKEN_KEY);
    }
    this.status.textContent = MESSAGES[kind] ?? MESSAGES.api;
    this.render();
  }

  private setBusy(busy: boolean, note?: string) {
    this.busy = busy;
    if (note) this.status.textContent = note;
    for (const button of [this.connectButton, this.refreshButton, this.disconnectButton]) button.disabled = busy;
  }

  private render() {
    const connected = this.token !== null;
    this.connectButton.hidden = connected && !this.paused;
    this.connectButton.textContent = this.linked ? "Resume" : "Connect Google Tasks";
    this.refreshButton.hidden = !connected || this.paused;
    this.disconnectButton.hidden = !connected && !this.linked;
    this.count.textContent = connected ? `${this.tasks.length} open` : "";
    const kinds = this.kinds;
    let note = KIND_NOTE.idle;
    if (!kinds) {
      this.list.replaceChildren(...this.tasks.map((task) => this.row(task)));
    } else {
      const store = kinds.store();
      const groups = groupTasks(this.tasks, kinds.today(), store.load());
      this.list.replaceChildren(...groups.map((group) => this.groupRow(group, store, kinds)));
      const missing = groups.reduce((n, g) => n + (g.kind === null && !g.mixed ? g.tasks.length : 0), 0);
      if (this.tasks.length > 0) note = missing > 0 ? KIND_NOTE.missing(missing) : KIND_NOTE.done;
    }
    if (this.kindNote) this.kindNote.textContent = note;
    this.list.hidden = this.tasks.length === 0;
  }

  private row(task: ImportedTask): HTMLElement {
    const item = document.createElement("li");
    item.className = "task-row";
    const main = document.createElement("div");
    main.className = "task-main";
    const title = document.createElement("p");
    title.className = "task-title";
    title.textContent = task.parent ? `↳ ${task.title}` : task.title;
    main.append(title);
    if (task.due) main.append(this.due(task.due));
    item.append(main);
    return item;
  }

  private due(day: string): HTMLElement {
    const due = document.createElement("p");
    due.className = "task-meta";
    if (typeof due.prepend === "function") due.prepend(icon("event"));
    due.append(dueFormat.format(new Date(`${day}T00:00:00Z`)));
    return due;
  }

  // One row per group (or per task of its own) with its kind; a group lists its tasks under it.
  private groupRow(group: TaskGroup, store: TagMemoryStore, kinds: KindDeps): HTMLElement {
    const lead = group.tasks[0];
    const item = group.label === null ? this.row(lead) : this.row({ ...lead, title: group.label, due: null, parent: null });
    item.dataset.unset = String(group.kind === null && !group.mixed);
    if (group.label !== null) {
      const meta = document.createElement("p");
      meta.className = "task-meta";
      meta.textContent = `${group.tasks.length} ${group.tasks.length === 1 ? "task" : "tasks"}`;
      item.querySelector(".task-main")?.append(meta);
    }
    item.append(this.kindSelect(group, store, kinds));
    if (group.label !== null) item.append(this.members(group.tasks));
    return item;
  }

  private kindSelect(group: TaskGroup, store: TagMemoryStore, kinds: KindDeps): HTMLElement {
    const select = document.createElement("select");
    select.className = "kind-select";
    select.setAttribute("aria-label", `Kind of work: ${group.label ?? group.tasks[0].title}`);
    const first = document.createElement("option");
    first.value = "";
    first.textContent = group.mixed ? "Mixed" : "Set kind";
    select.append(first);
    RUBRIC_CHOICES.forEach((choice, i) => {
      const option = document.createElement("option");
      option.value = String(i);
      option.textContent = choice.text;
      select.append(option);
    });
    select.value = group.kind ? String(RUBRIC_CHOICES.indexOf(group.kind)) : "";
    select.addEventListener("change", () => {
      const choice = RUBRIC_CHOICES[Number(select.value)];
      if (!choice) return;
      const ok = store.save(setGroupKind(store.load(), group, choice.rubric));
      this.status.textContent = ok ? `Saved: ${choice.text}.` : "Couldn't save on this laptop.";
      kinds.onChange();
      this.render();
    });
    return select;
  }

  private members(tasks: readonly ImportedTask[]): HTMLElement {
    const details = document.createElement("details");
    details.className = "task-members";
    const summary = document.createElement("summary");
    summary.textContent = "Show tasks";
    const list = document.createElement("ul");
    for (const task of tasks.slice(0, MEMBERS_SHOWN * 5)) {
      const li = document.createElement("li");
      li.textContent = task.due ? `${task.title} · ${dueFormat.format(new Date(`${task.due}T00:00:00Z`))}` : task.title;
      list.append(li);
    }
    details.append(summary, list);
    return details;
  }
}
