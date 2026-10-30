import type { Label } from "./rules.ts";

// The nudges in the Picture-in-Picture window (NOTES D-78: no character any more): when Equilibre speaks up
// for the shown label. Pure, like the pipeline modules, so the rules below are tested without a browser.

export const GREETING = {
  snoozeMs: 30 * 60_000, // "Snooze nudges for 30 min"
  showMs: 20_000, // how long a greeting stays before it hides by itself
} as const;

export const GREETING_TEXT = {
  lelah: "You look tired. Sit upright, take a short walk, or get some daylight.",
  tertidur: "You seem to have dozed off. Stand up and move for a few minutes.",
  istirahat: "You have looked tired for a while. Stop for a proper break before you carry on.",
} as const;

export type GreetingState = {
  label: Label | null; // the last shown label seen
  advice: boolean; // whether the long-rest advice was showing
  snoozeUntil: number; // epoch ms; 0 = not snoozed
};

export const initialGreetingState = (): GreetingState => ({ label: null, advice: false, snoozeUntil: 0 });

export function snoozeGreeting(state: GreetingState, now: number): GreetingState {
  return { ...state, snoozeUntil: now + GREETING.snoozeMs };
}

// Speaks up only when the shown label turns "lelah" or "tertidur", or when the long-rest advice
// appears (plan P13 scope 5). Waking from "tertidur" to "lelah" is not news, and nothing is said
// while snoozed; a change that happened during the snooze is not said afterwards either.
export function stepGreeting(
  state: GreetingState,
  label: Label | null,
  advice: boolean,
  now: number,
): { state: GreetingState; say: string | null } {
  const next: GreetingState = { ...state, label, advice };
  if (now < state.snoozeUntil) return { state: next, say: null };
  if (advice && !state.advice) return { state: next, say: GREETING_TEXT.istirahat };
  if (label === state.label) return { state: next, say: null };
  if (label === "tertidur") return { state: next, say: GREETING_TEXT.tertidur };
  if (label === "lelah" && state.label !== "tertidur") return { state: next, say: GREETING_TEXT.lelah };
  return { state: next, say: null };
}
