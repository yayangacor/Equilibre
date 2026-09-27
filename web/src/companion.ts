import type { Label } from "./rules.ts";

// The companion in the Picture-in-Picture window (plan P13, NOTES D-24): which face the character
// shows for the shown label, and when it speaks up. Pure, like the pipeline modules, so the
// rules below are tested without a browser.

export type Mood = "normal" | "lelah-ringan" | "lelah" | "tertidur" | "pergi" | "menunggu";

export function moodFor(label: Label | null): Mood {
  switch (label) {
    case "normal":
      return "normal";
    case "lelah ringan":
      return "lelah-ringan";
    case "lelah":
      return "lelah";
    case "tertidur":
      return "tertidur";
    case "tidak di depan layar":
      return "pergi";
    default:
      return "menunggu"; // no label yet: loading, calibrating, not calibrated
  }
}

export const GREETING = {
  snoozeMs: 30 * 60_000, // "Tunda sapaan 30 menit" (plan P13 scope 4)
  showMs: 20_000, // how long a greeting stays before it hides by itself
} as const;

export const GREETING_TEXT = {
  lelah: "Kamu tampak lelah. Coba jeda sebentar, ya.",
  tertidur: "Sepertinya kamu tertidur. Bangun dan bergerak sebentar, yuk.",
  istirahat: "Kamu sudah cukup lama lelah. Sebaiknya berhenti dulu dan istirahat yang cukup.",
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
