import { LOCALE } from "./format.ts";
import type { ImportedTask } from "./googleTasks.ts";
import { dayKey, type EvaluationRecord, type KssRecord } from "./history.ts";
import { energyPhase } from "./phase.ts";
import {
  addDecision,
  answerLatest,
  chooseTasks,
  historyDayKeys,
  phaseInputFrom,
  phaseView,
  planView,
  RUBRIC_CHOICES,
  sourceLine,
  tasksToAsk,
  type AskItem,
  type LiveState,
  type PhaseView,
  type PlanDecision,
  type PlanView,
  type TaskChoice,
} from "./planCard.ts";
import { offlinePlan, requestPlan, toRencanaRequest } from "./rencana.ts";
import { rememberTag, type Rubric, type TagMemoryStore } from "./taskTagger.ts";

// Dashboard card "Plan my next hour" (plan P20 W2.6). Thin DOM over planCard.ts: the view is built there.
// The plan is asked for only when the user presses the button (NOTES D-19: never on a timer, a page load or a label
// change); /api/rencana gets the energy phase and the abstract tasks t1..tn, never a title (rencana.ts, D-90).
// Every text from tasks or the server goes in via textContent.

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function el(tag: string, text: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

const clock = (t: number) => new Date(t).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });

export type PlanDeps = {
  tasks: () => { connected: boolean; tasks: readonly ImportedTask[] }; // Settings → Google Tasks (tasksPanel.ts)
  sample: ((today: string) => ImportedTask[]) | null; // the demo account's sample tasks (?demo=rina)
  tags: { google: TagMemoryStore; sample: TagMemoryStore }; // the rubric answers, apart for the sample tasks
  live: () => LiveState; // the shown label, the quality level and minutes since the last break, right now
  history: (days: string[]) => Promise<{ evaluasi: EvaluationRecord[]; kss: KssRecord[] }>;
  evalIntervalMs: number;
  server: () => boolean; // the backend can answer now (the online demo asks /api/health first, NOTES D-80)
  offlineReason: string; // why the plan is offline when the backend cannot answer
  onTaskDone: () => void; // "I finished it": the walk scheduler suggests a short walk (W2.5)
};

// done: "I finished it" was pressed for this plan's task. google: the tasks came from Google Tasks.
type Shown = { view: PlanView; phase: PhaseView; at: number; cocok: boolean | null; done: boolean; google: boolean };

export class PlanPanel {
  private readonly deps: PlanDeps;
  private readonly source = byId("plan-source");
  private readonly note = byId("plan-note");
  private readonly connect = byId("plan-connect");
  private readonly ask = byId("plan-ask");
  private readonly button = byId<HTMLButtonElement>("plan-make");
  private readonly out = byId("plan-out");
  private shown: Shown | null = null;
  private busy: "server" | "local" | null = null;
  private problem: string | null = null;
  private askLater = false; // "Not now": no rubric question for the rest of this tab
  private saved: string | null = null;
  private generation = 0; // bumped when the tasks change, so a plan for tasks no longer there is dropped
  private decisionList: PlanDecision[] = [];

  constructor(deps: PlanDeps) {
    this.deps = deps;
    this.button.addEventListener("click", () => void this.make());
    this.render();
  }

  // For the decision log (W2.7): what was sent for each plan and whether it fit. In memory only.
  get decisions(): readonly PlanDecision[] {
    return this.decisionList;
  }

  // Connected, refreshed or disconnected: a plan naming tasks that may be gone is not kept on screen.
  tasksChanged() {
    this.generation++;
    this.shown = null;
    this.problem = null;
    this.saved = null;
    this.render();
  }

  private choice(today: string): TaskChoice {
    const { connected, tasks } = this.deps.tasks();
    return chooseTasks(connected, tasks, this.deps.sample ? this.deps.sample(today) : null);
  }

  private tagStore(choice: TaskChoice): TagMemoryStore {
    return choice.kind === "sample" ? this.deps.tags.sample : this.deps.tags.google;
  }

  private async make() {
    if (this.busy) return;
    const now = Date.now();
    const today = dayKey(now);
    const choice = this.choice(today);
    if (choice.kind === "none") return;
    const generation = this.generation;
    const live = this.deps.live();
    const server = this.deps.server();
    this.busy = server ? "server" : "local";
    this.problem = null;
    this.render();
    try {
      const { evaluasi, kss } = await this.deps.history(historyDayKeys(now));
      const input = phaseInputFrom(live, evaluasi, kss, now, this.deps.evalIntervalMs);
      const phase = energyPhase(input);
      const req = toRencanaRequest(phase, input.menitSejakJeda, choice.tasks, today, this.tagStore(choice).load());
      const plan = server ? await requestPlan(req) : offlinePlan(req, this.deps.offlineReason);
      if (generation !== this.generation) return;
      this.decisionList = addDecision(this.decisionList, req.body, plan, Date.now());
      this.shown = {
        view: planView(plan),
        phase: phaseView(phase, input.slump),
        at: now,
        cocok: null,
        done: false,
        google: choice.kind === "google",
      };
      this.saved = null;
    } catch (err) {
      console.error("Plan not made:", err);
      this.problem = "The plan could not be made. Try again.";
    } finally {
      this.busy = null;
      this.render();
    }
  }

  render() {
    const today = dayKey(Date.now());
    const choice = this.choice(today);
    this.source.textContent = sourceLine(choice);
    this.note.textContent =
      choice.kind === "sample"
        ? "Sample tasks of the demo account, not from Google."
        : choice.kind === "google" && choice.tasks.length === 0
          ? "No open tasks in Google Tasks: the plan can only suggest a walk or a break."
          : "";
    this.connect.hidden = choice.kind !== "none";
    this.button.hidden = choice.kind === "none";
    this.button.disabled = this.busy !== null;
    this.button.textContent = this.busy ? "Planning…" : this.shown ? "Plan again" : "Plan my next hour";
    this.renderAsk(choice, today);
    this.renderOut();
  }

  // ── One-tap rubric (D-89) ──

  private renderAsk(choice: TaskChoice, today: string) {
    const store = this.tagStore(choice);
    const items = this.askLater ? [] : tasksToAsk(choice.tasks, today, store.load());
    this.ask.hidden = items.length === 0 && this.saved === null;
    this.ask.replaceChildren();
    if (items.length > 0) {
      this.ask.append(el("p", "What kind of work is this? Asked once, kept on this laptop.", "choices-label"));
      for (const item of items) this.ask.append(this.askRow(item, store));
      const later = el("button", "Not now", "btn text");
      (later as HTMLButtonElement).type = "button";
      later.addEventListener("click", () => {
        this.askLater = true;
        this.render();
      });
      this.ask.append(later);
    }
    if (this.saved) this.ask.append(el("p", this.saved, "helper"));
  }

  private askRow(item: AskItem, store: TagMemoryStore): HTMLElement {
    const row = el("div", "", "rubric-item");
    row.append(el("p", item.title, "rubric-title"));
    const choices = el("div", "", "choice-row");
    for (const choice of RUBRIC_CHOICES) {
      const button = el("button", choice.text, "btn outline rubric-choice") as HTMLButtonElement;
      button.type = "button";
      button.addEventListener("click", () => this.answer(item, choice.rubric, store));
      choices.append(button);
    }
    row.append(choices);
    return row;
  }

  private answer(item: AskItem, rubric: Rubric, store: TagMemoryStore) {
    const ok = store.save(rememberTag(store.load(), item, rubric));
    this.saved = ok
      ? `Saved on this laptop.${this.shown ? " Plan again to use it." : ""}`
      : "It could not be saved on this laptop.";
    this.render();
  }

  // ── The plan ──

  private renderOut() {
    if (this.busy) {
      this.out.replaceChildren(el("p", this.busy === "server" ? "Langflow is writing your plan…" : "Making your plan…", "muted"));
      return;
    }
    if (this.problem) {
      this.out.replaceChildren(el("p", this.problem, "callout danger"));
      return;
    }
    if (!this.shown) {
      this.out.replaceChildren();
      return;
    }
    const { view, phase, at } = this.shown;
    const card = el("div", "", "plan-result");

    const head = el("div", "", "plan-phase");
    head.append(el("p", `Planned at ${clock(at)}`, "eyebrow"), el("p", phase.title, "plan-phase-title"));
    head.append(el("p", phase.note, phase.assessed ? "helper" : "callout info"));
    if (phase.slump) head.append(el("p", phase.slump, "helper"));
    card.append(head);

    if (view.steps.length > 0) {
      const steps = el("ol", "", "plan-steps");
      const hasTask = view.steps.some((s) => s.kind === "tugas");
      for (const step of view.steps) {
        const item = el("li", "", "plan-step");
        item.dataset.kind = step.kind;
        item.append(el("p", step.minutes ? `${step.label} · ${step.minutes}` : step.label, "plan-kind"));
        if (step.title) item.append(el("p", step.title, "plan-title"));
        item.append(el("p", step.text, "plan-text"));
        if (step.why) item.append(this.why(step.why));
        if (step.kind === "next" && hasTask) item.append(this.doneAction());
        steps.append(item);
      }
      card.append(steps);
    }
    if (view.why) card.append(this.why(view.why));

    if (view.sources) {
      if (view.sources.length === 0) card.append(el("p", "No sources from the knowledge base.", "helper"));
      else {
        const list = el("ul", "", "sources");
        list.append(...view.sources.map((s) => el("li", s.text, s.known ? undefined : "error")));
        card.append(list);
      }
    }

    const meta = el("div", "", "plan-meta");
    meta.append(el("span", view.badge, "pill"));
    if (view.badgeNote) meta.append(el("p", view.badgeNote, "helper"));
    card.append(meta, this.feedback());
    this.out.replaceChildren(card);
  }

  // "I finished it" on the "Next" step: the walk after the task (research §3.3). Google Tasks is read-only here, so the
  // task is not ticked off there.
  private doneAction(): HTMLElement {
    const box = el("div", "", "plan-done");
    const button = el("button", "I finished it", "btn outline") as HTMLButtonElement;
    button.type = "button";
    const note = el("p", "", "helper");
    const update = () => {
      const done = this.shown?.done ?? false;
      button.disabled = done;
      button.setAttribute("aria-pressed", String(done));
      note.textContent = done ? `Marked as done.${this.shown?.google ? " Tick it off in Google Tasks too." : ""}` : "";
    };
    button.addEventListener("click", () => {
      if (!this.shown || this.shown.done) return;
      this.shown.done = true;
      update();
      this.deps.onTaskDone();
    });
    update();
    box.append(button, note);
    return box;
  }

  private why(text: string): HTMLElement {
    const why = el("p", "", "advice-why");
    why.append(el("strong", "Why: "), text);
    return why;
  }

  // "Fits / Doesn't fit": kept with the latest decision, nothing is sent (W2.7 will store it).
  private feedback(): HTMLElement {
    const box = el("div", "", "feedback");
    box.append(el("span", "This plan:", "choices-label"));
    const note = el("p", "", "helper");
    const buttons: [HTMLButtonElement, boolean][] = [];
    for (const [text, cocok] of [
      ["Fits", true],
      ["Doesn't fit", false],
    ] as const) {
      const button = el("button", text, "btn outline") as HTMLButtonElement;
      button.type = "button";
      buttons.push([button, cocok]);
      button.addEventListener("click", () => {
        if (!this.shown) return;
        this.shown.cocok = cocok;
        this.decisionList = answerLatest(this.decisionList, cocok, Date.now());
        update();
      });
      box.append(button);
    }
    const update = () => {
      const answer = this.shown?.cocok ?? null;
      for (const [button, cocok] of buttons) button.setAttribute("aria-pressed", String(answer === cocok));
      note.textContent = answer === null ? "" : "Thanks. Your answer stays on this laptop.";
    };
    update();
    box.append(note);
    return box;
  }
}
