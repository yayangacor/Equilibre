import { gisReady, type ImportedTask, loadGis, readTasks, requestToken, revokeToken, TasksError, type TasksToken } from "./googleTasks.ts";

// Settings card "Google Tasks" (plan P20 W2.1): connect, refresh, disconnect. The token and the tasks live in this
// object only; nothing is written to storage, so closing the tab forgets both. Titles go to the DOM via textContent.

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const PREVIEW = 8;
const RENEW_BEFORE_MS = 60_000; // ask Google again when the token has less than a minute left

const MESSAGES: Record<TasksError["kind"], string> = {
  popup: "Your browser blocked the Google window. Press Connect again.",
  denied: "Google Tasks was not connected.",
  expired: "Google access expired. Press Connect again.",
  api: "Google Tasks did not answer. Try again in a moment.",
  network: "Google could not be reached. Check your connection.",
};

const dueFormat = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

export class TasksPanel {
  private token: TasksToken | null = null;
  private tasks: ImportedTask[] = [];
  private busy = false;
  private readonly connectButton = byId<HTMLButtonElement>("tasks-connect");
  private readonly refreshButton = byId<HTMLButtonElement>("tasks-refresh");
  private readonly disconnectButton = byId<HTMLButtonElement>("tasks-disconnect");
  private readonly status = byId("tasks-status");
  private readonly list = byId<HTMLUListElement>("tasks-list");
  private readonly count = byId("tasks-count");

  private readonly onChange: (tasks: readonly ImportedTask[]) => void;

  constructor(onChange: (tasks: readonly ImportedTask[]) => void = () => {}) {
    this.onChange = onChange;
    this.connectButton.addEventListener("click", () => void this.connect());
    this.refreshButton.addEventListener("click", () => void this.refresh());
    this.disconnectButton.addEventListener("click", () => void this.disconnect());
    this.render();
  }

  get current(): readonly ImportedTask[] {
    return this.tasks;
  }

  private async connect() {
    if (this.busy) return;
    this.setBusy(true, "Opening Google…");
    try {
      // The popup needs the click's user activation: reuse the loaded library when there is one.
      const lib = gisReady() ?? (await loadGis());
      this.token = await requestToken(lib);
      await this.load();
    } catch (error) {
      this.fail(error);
    } finally {
      this.setBusy(false);
    }
  }

  private async refresh() {
    if (!this.token || this.token.expiresAt - Date.now() < RENEW_BEFORE_MS) return this.connect();
    if (this.busy) return;
    this.setBusy(true, "Reading your tasks…");
    try {
      await this.load();
    } catch (error) {
      this.fail(error);
    } finally {
      this.setBusy(false);
    }
  }

  private async load() {
    if (!this.token) return;
    this.status.textContent = "Reading your tasks…";
    this.tasks = await readTasks(this.token.value);
    this.onChange(this.tasks);
    const lists = new Set(this.tasks.map((t) => t.listId)).size;
    this.status.textContent =
      this.tasks.length === 0 ? "Connected. No open tasks found." : `Connected. ${this.tasks.length} open tasks from ${lists} ${lists === 1 ? "list" : "lists"}.`;
    this.render();
  }

  private async disconnect() {
    const token = this.token;
    this.token = null;
    this.tasks = [];
    this.onChange(this.tasks);
    this.render();
    this.status.textContent = "Disconnected. Equilibre no longer has access to your tasks.";
    if (token) await revokeToken(token.value);
  }

  private fail(error: unknown) {
    const kind = error instanceof TasksError ? error.kind : "api";
    if (kind === "expired") this.token = null;
    this.status.textContent = MESSAGES[kind];
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
