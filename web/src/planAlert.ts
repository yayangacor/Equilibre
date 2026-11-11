import type { KeyValueStore } from "./calibration.ts";
import type { PlanView } from "./planCard.ts";

// The alert when the Dashboard makes a plan by itself because the user looks tired (planPanel.ts labelChanged; user
// 11 Nov: "a notification when the plan is automated, with this sound"). A short sound, and while the user is in
// another window, a desktop notification. Never in a meeting (D-106: a meeting holds the nudges). Nothing leaves the
// laptop: the notification is the operating system's, the sound a file of this site. Pure: main.ts plays and shows.

export const PLAN_ALERT_KEY = "equilibre.plan-alert";
export const PLAN_SOUND_URL = "/sounds/plan-ready.mp3";
export const PLAN_SOUND_VOLUME = 0.7;
export const PLAN_NOTIFICATION_TAG = "equilibre-plan"; // a newer plan's notification replaces the older one

// On unless the user turned it off.
export function loadPlanAlert(store: KeyValueStore): boolean {
  try {
    return store.getItem(PLAN_ALERT_KEY) !== "0";
  } catch {
    return true;
  }
}

export function savePlanAlert(store: KeyValueStore, on: boolean): boolean {
  try {
    store.setItem(PLAN_ALERT_KEY, on ? "1" : "0");
    return true;
  } catch {
    return false;
  }
}

export type NotifyPermission = NotificationPermission | "unsupported";

// away: the Equilibre tab is hidden or another window has the focus (the PiP window, another app).
export type AlertInput = { on: boolean; meeting: boolean; away: boolean; permission: NotifyPermission };

// The sound always comes with the alert; the notification only while the user is away from the tab, since the plan
// card shows the same thing, and only with the browser's permission.
export function alertChannels(input: AlertInput): { sound: boolean; notify: boolean } {
  if (!input.on || input.meeting) return { sound: false, notify: false };
  return { sound: true, notify: input.away && input.permission === "granted" };
}

// "Task · 25 min “Reply to Dina”": the plan's first step, as the card shows it.
function firstStep(view: PlanView): string | null {
  const step = view.steps[0];
  if (!step) return null;
  const head = step.minutes ? `${step.label} · ${step.minutes}` : step.label;
  return step.title ? `${head} ${step.title}` : head;
}

export function planAlertText(view: PlanView): { title: string; body: string } {
  const first = firstStep(view);
  return { title: "You look tired", body: first ? `Your next hour is planned. First: ${first}` : "Your next hour is planned." };
}

// The Settings line under the switch.
export function planAlertNote(on: boolean, permission: NotifyPermission): string {
  if (!on) return "Off. The plan still shows on the Dashboard.";
  if (permission === "granted") return "A sound, and a desktop notification when you're in another window. Silent in meetings.";
  if (permission === "denied") return "A sound only: this browser blocks notifications for this site. Silent in meetings.";
  if (permission === "unsupported") return "A sound only. Silent in meetings.";
  return "A sound. Press Try it to also allow desktop notifications. Silent in meetings.";
}
