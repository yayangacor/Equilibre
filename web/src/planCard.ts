import { toSource, type Source } from "./answer.ts";
import type { KeyValueStore } from "./calibration.ts";
import type { ImportedTask } from "./googleTasks.ts";
import { dayKey, type EvaluationRecord, type KssRecord } from "./history.ts";
import { SLUMP, slumpWindow, type Phase, type PhaseInput, type PhaseReason, type PhaseResult, type SlumpWindow } from "./phase.ts";
import type { QualityLevel } from "./quality.ts";
import { RENCANA_LIMITS, type Plan } from "./rencana.ts";
import type { Label } from "./rules.ts";
import { PLAN, type StepKind } from "./taskMatcher.ts";
import { tagTask, type Rubric, type TagMemory } from "./taskTagger.ts";

// What the Dashboard card "Plan my next hour" shows (plan P20 W2.6), from the state of this laptop. Pure: no DOM, no
// storage, no network; planPanel.ts renders it, rencana.ts builds the request and asks the server.
// Readings where the plan and the research report are silent (the simpler one each time):
// - Task source: connected Google Tasks always win, even with no open task; the demo account's sample tasks are used
//   only while Google is not connected, so the two are never mixed. Without either, the card asks to connect.
// - The phase is worked out when the user presses the button (it needs the history), not continuously, and shown
//   with the plan it was made for.
// - The timeline ends with a "Next" step that is not part of the Task Matcher's plan: after a task, a short walk
//   (research §3.3: a walk after a task is done; "I finished it" there asks walkScheduler.ts, W2.5); after a break,
//   plan again.
// - The one-tap rubric asks only about tasks the lexicon could not tag (D-89 "ditanya sekali"), the first few in the
//   user's order, with the four kinds as four buttons (one tap); "Not now" hides the question for this tab.

// ── Which tasks ─────────────────────────────────────────────────────────────────

export type TaskChoice =
  | { kind: "google"; tasks: readonly ImportedTask[] }
  | { kind: "sample"; tasks: readonly ImportedTask[] }
  | { kind: "none"; tasks: readonly ImportedTask[] };

export function chooseTasks(connected: boolean, real: readonly ImportedTask[], sample: readonly ImportedTask[] | null): TaskChoice {
  if (connected) return { kind: "google", tasks: real };
  if (sample) return { kind: "sample", tasks: sample };
  return { kind: "none", tasks: [] };
}

export function sourceLine(choice: TaskChoice): string {
  if (choice.kind === "google") return `Google Tasks · ${choice.tasks.length} open`;
  if (choice.kind === "sample") return `Sample tasks · ${choice.tasks.length}`;
  return "";
}

// ── One-tap rubric (D-89) ───────────────────────────────────────────────────────

export const RUBRIC_CHOICES: readonly { rubric: Rubric; text: string }[] = [
  { rubric: { sifat: "aktif", beban: "berat" }, text: "Active, demanding" },
  { rubric: { sifat: "aktif", beban: "ringan" }, text: "Active, light" },
  { rubric: { sifat: "monoton", beban: "berat" }, text: "Routine, demanding" },
  { rubric: { sifat: "monoton", beban: "ringan" }, text: "Routine, light" },
];
export const ASK_MAX = 3;

export type AskItem = { id: string; title: string };

// Tasks the plan would send as "belum dinilai": only the first RENCANA_LIMITS.tugasMax, as toRencanaRequest sends.
export function tasksToAsk(tasks: readonly ImportedTask[], today: string, memory: TagMemory, max = ASK_MAX): AskItem[] {
  return [...tasks]
    .sort((a, b) => a.order - b.order)
    .slice(0, RENCANA_LIMITS.tugasMax)
    .filter((task) => tagTask(task, today, memory.corrections, memory.personal).source === "unknown")
    .slice(0, max)
    .map((task) => ({ id: task.id, title: task.title }));
}

// The sample tasks' answers live under their own key, so a demo never teaches the real dictionary.
export function scopedStore(base: KeyValueStore, suffix: string): KeyValueStore {
  const key = (k: string) => `${k}@${suffix}`;
  return {
    getItem: (k) => base.getItem(key(k)),
    setItem: (k, v) => base.setItem(key(k), v),
    removeItem: (k) => base.removeItem(key(k)),
  };
}

// ── The phase, from the live state and the local history ────────────────────────

// Today and the SLUMP.historyDays calendar days before it: every day the 7-day slump window can reach.
export function historyDayKeys(now: number, days: number = SLUMP.historyDays): string[] {
  const out: string[] = [];
  const d = new Date(now);
  for (let back = 0; back <= days; back++) {
    out.push(dayKey(d.getTime()));
    d.setDate(d.getDate() - 1);
  }
  return out;
}

export type LiveState = { label: Label | null; quality: QualityLevel | null; menitSejakJeda: number | null };

export function phaseInputFrom(
  live: LiveState,
  evaluasi: readonly EvaluationRecord[],
  kss: readonly KssRecord[],
  now: number,
  evalIntervalMs: number,
): PhaseInput {
  const latest = kss.filter((k) => k.t <= now).reduce<KssRecord | null>((a, b) => (a === null || b.t > a.t ? b : a), null);
  return {
    now,
    label: live.label,
    quality: live.quality,
    recent: evaluasi,
    menitSejakJeda: live.menitSejakJeda,
    kss: latest,
    slump: slumpWindow(evaluasi, now, evalIntervalMs),
    evalIntervalMs,
  };
}

export const PHASE_NAME: Readonly<Record<Phase, string>> = {
  "siap fokus": "Ready to focus",
  biasa: "Steady",
  "rendah ringan": "Low energy",
  "rendah berat": "Very low energy",
  "tidak tahu": "Not assessed",
};

const NOT_ON_CAMERA = "so this plan is not based on the camera right now.";
const PHASE_REASON: Readonly<Record<PhaseReason, string>> = {
  "no-label": `No state from the camera yet, ${NOT_ON_CAMERA}`,
  "not-assessed": `The camera can't assess you right now, ${NOT_ON_CAMERA}`,
  away: `You seem away from the screen, ${NOT_ON_CAMERA}`,
  "mostly-not-assessed": `The camera could assess less than half of the last 15 min, ${NOT_ON_CAMERA}`,
  asleep: "The camera reads you as Asleep.",
  tired: "The camera reads you as Tired.",
  "mildly-tired": "The camera reads you as Mildly tired.",
  kss: "Your last sleepiness check was 7 or higher.",
  ready: "No signs of tiredness in the last 15 min, and a recent break.",
  "not-enough-evidence": "No signs of tiredness right now.",
};

const hour = (h: number) => `${String(h).padStart(2, "0")}:00`;

export type PhaseView = { title: string; note: string; slump: string | null; assessed: boolean };

export function phaseView(phase: PhaseResult, slump: SlumpWindow): PhaseView {
  const hours = `${hour(slump.startHour)}–${hour(slump.endHour)}`;
  return {
    title: `Energy: ${PHASE_NAME[phase.fase]}`,
    note: PHASE_REASON[phase.reason],
    slump: phase.jam_rawan
      ? slump.personal
        ? `${hours} is your usual low hour (from your last 7 days).`
        : `${hours} is a usual low time for most people.`
      : null,
    assessed: phase.fase !== "tidak tahu",
  };
}

// ── The plan as a timeline ──────────────────────────────────────────────────────

export type StepView = {
  kind: StepKind | "next";
  label: string;
  minutes: string | null;
  text: string;
  title: string | null; // the task's title, only when the sentence does not already name it
  why: string | null; // the plan's reason, on the task step (or the break)
};

export type PlanView = {
  steps: StepView[];
  why: string | null; // the reason when no step carries it
  badge: string;
  badgeNote: string | null;
  sources: Source[] | null; // null: offline, no knowledge base
};

const STEP_LABEL: Readonly<Record<StepKind | "next", string>> = { jalan: "Walk", jeda: "Break", tugas: "Task", next: "Next" };

export function planView(plan: Plan): PlanView {
  const carrier = plan.langkah.findIndex((s) => s.jenis === "tugas" || s.jenis === "jeda");
  const steps: StepView[] = plan.langkah.map((s, i) => ({
    kind: s.jenis,
    label: STEP_LABEL[s.jenis],
    minutes: s.menit === null ? null : `${s.menit} min`,
    text: s.teks,
    title: s.jenis === "tugas" && s.judul && !s.teks.includes(s.judul) ? `“${s.judul}”` : null,
    why: i === carrier && plan.alasan.trim() !== "" ? plan.alasan : null,
  }));
  const last = plan.langkah.at(-1)?.jenis;
  const next =
    last === "tugas"
      ? `When you finish, walk for ${PLAN.walkMinutes} minutes.`
      : last === "jeda"
        ? "When you're back, plan your next hour again."
        : null;
  if (next) steps.push({ kind: "next", label: STEP_LABEL.next, minutes: null, text: next, title: null, why: null });

  const server = plan.asal === "server";
  return {
    steps,
    why: carrier === -1 && plan.alasan.trim() !== "" ? plan.alasan : null,
    badge: server ? `Model: ${plan.model ?? "not named by the server"}` : "Offline plan, rules only",
    badgeNote: server ? (plan.cadangan ? "Written by the backup model because the main model failed." : null) : plan.sebab,
    sources: server ? plan.sumber.map(toSource) : null,
  };
}

// "Fits / Doesn't fit" and "I finished it" are kept in the decision log (decisionLog.ts, W2.7), not here.
