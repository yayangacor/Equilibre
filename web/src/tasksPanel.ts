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

// Settings card "Google Tasks" (plan P20 W2.1): connect, refresh, disconnect, and ticking a finished task off for the
// plan card (W2.8). The token and the tasks live in this object only; nothing is written to storage, so closing the
// tab forgets both. Titles go to the DOM via textContent.

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const PREVIEW = 8;
const RENEW_BEFORE_MS = 60_000; // ask Google again when the token has less than a minute left

// Connect and Refresh (reads never answer forbidden or missing; anything else reads as api).
const MESSAGES: Partial<Record<TasksErrorKind, string>> & { api: string } = {
  popup: "Your browser blocked the Google window. Press Connect again.",
  denied: "Google Tasks was not connected.",
  expired: "Google access expired. Press Connect again.",
  api: "Google Tasks did not answer. Try again in a moment.",
  network: "Google could not be reached. Check your connection.",
};

// "I finished it" on a Google task (W2.8): one line on the plan card, ticked or why not.
export type TickResult = { ticked: boolean; message: string };

export const TICKED = "Ticked off in Google Tasks.";
export const NOT_TICKED: Record<TasksErrorKind | "declined" | "busy" | "gone" | "disconnected", string> = {
  declined: "Not ticked off in Google Tasks: permission not given. Tick it off there.",
  denied: "Not ticked off in Google Tasks: permission not given. Tick it off there.",
  popup: "Not ticked off: your browser blocked the Google window. Tick it off in Google Tasks.",
  expired: "Not ticked off: Google access expired. Press Refresh in Settings → Google Tasks.",
  forbidden: "Not ticked off: Equilibre may not change your tasks. Tick it off in Google Tasks.",
  missing: "Not ticked off: Google Tasks has no such task in this account. It may be deleted, or another account was picked.",
  api: "Not ticked off: Google Tasks did not answer. Tick it off there.",
  network: "Not ticked off: Google could not be reached. Tick it off in Google Tasks.",
  busy: "Not ticked off: Google is still busy with the last task. Tick this one off in Google Tasks.",
  gone: "Not ticked off: this task is no longer in your Google Tasks list.",
  disconnected: "Not ticked off: Google Tasks is not connected.",
};

const sameTask = (a: ImportedTask, b: ImportedTask) => a.id === b.id && a.listId === b.listId;

const dueFormat = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

export class TasksPanel {
  private token: TasksToken | null = null;
  private tasks: ImportedTask[] = [];
  private busy = false;
  private ticking = false; // a tick-off is waiting for Google
  private readonly connectButton = byId<HTMLButtonElement>("tasks-connect");
  private readonly refreshButton = byId<HTMLButtonElement>("tasks-refresh");
  private readonly disconnectButton = byId<HTMLButtonElement>("tasks-disconnect");
  private readonly status = byId("tasks-status");
  private readonly list = byId<HTMLUListElement>("tasks-list");
  private readonly count = byId("tasks-count");

  // newGrant: the tasks came with a token from the Google window (Connect, or Refresh renewing an expiring token).
  // That window can switch to another signed-in Google account, and the token does not say which (review, 8 Nov).
  private readonly onChange: (tasks: readonly ImportedTask[], newGrant: boolean) => void;

  constructor(onChange: (tasks: readonly ImportedTask[], newGrant: boolean) => void = () => {}) {
    this.onChange = onChange;
    this.connectButton.addEventListener("click", () => void this.connect());
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

  private async refresh() {
    const token = this.token;
    if (!token || token.expiresAt - Date.now() < RENEW_BEFORE_MS) return this.connect();
    if (this.busy) return;
    this.setBusy(true, "Reading your tasks…");
    try {
      await this.load(token, false);
    } catch (error) {
      this.fail(error);
    } finally {
      this.setBusy(false);
    }
  }

  // Reads the tasks with this token, then keeps both.
  private async load(token: TasksToken, newGrant: boolean) {
    this.status.textContent = "Reading your tasks…";
    const tasks = await readTasks(token.value);
    this.token = token;
    this.tasks = tasks;
    this.onChange(this.tasks, newGrant);
    this.status.textContent = this.connectedLine();
    this.render();
  }

  private connectedLine(): string {
    const lists = new Set(this.tasks.map((t) => t.listId)).size;
    return this.tasks.length === 0 ? "Connected. No open tasks found." : `Connected. ${this.tasks.length} open tasks from ${lists} ${lists === 1 ? "list" : "lists"}.`;
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
      if (use !== token && this.token === token) this.token = use;
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
    this.onChange(this.tasks, false);
    this.render();
    this.status.textContent = "Disconnected. Equilibre no longer has access to your tasks.";
    if (token) await revokeToken(token.value);
  }

  private fail(error: unknown) {
    const kind = error instanceof TasksError ? error.kind : "api";
    if (kind === "expired") this.token = null;
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
    this.connectButton.hidden = connected;
    this.refreshButton.hidden = !connected;
    this.disconnectButton.hidden = !connected;
    this.count.textContent = connected ? `${this.tasks.length} open` : "";
    this.list.replaceChildren(
      ...this.tasks.slice(0, PREVIEW).map((task) => {
        const item = document.createElement("li");
        const title = document.createElement("span");
        title.textContent = task.parent ? `↳ ${task.title}` : task.title;
        item.append(title);
        if (task.due) {
          const due = document.createElement("span");
          due.className = "due";
          due.textContent = `due ${dueFormat.format(new Date(`${task.due}T00:00:00Z`))}`;
          item.append(due);
        }
        return item;
      }),
    );
    if (this.tasks.length > PREVIEW) {
      const more = document.createElement("li");
      more.className = "more";
      more.textContent = `+ ${this.tasks.length - PREVIEW} more`;
      this.list.append(more);
    }
    this.list.hidden = this.tasks.length === 0;
  }
}
