import { inSlump, type SlumpWindow } from "./phase.ts";

// Short-walk scheduler (plan P20 W2.5, research report §3.3): when Equilibre suggests a 5–10 minute walk. Pure and on
// this laptop only: nothing about it is sent, and the suggestions are not stored.
//
//   before the slump  in the WALK.leadMinutes before the slump window starts (12:30 for the default 13:00), when the
//                     minutes since the last break are ≥ WALK.beforeMinSinceBreak
//   during the slump  every WALK.slumpEveryMinutes of continuous screen time
//   after a task      right after the user marks the planned task done ("Plan my next hour", planPanel.ts)
//   never             more than once per WALK.minGapMinutes, while marked "in a meeting", while nudges are quiet
//
// A break of 2 minutes or more away from the screen (features.ts BREAK_MIN_MS, NOTES D-42), or one marked by hand,
// counts as the walk: the continuous screen time starts again from it (main.ts breakState gives minutesSinceBreak),
// and a suggestion still on screen is withdrawn.
//
// Readings where the plan and the report are silent (the simpler one each time):
// - "every 30–40 minutes": the short end, 30, the same as the other thresholds. Without a break, the repeats are
//   spaced by the 30-minute cap.
// - The cap counts every suggestion shown, dismissed or not, and a break does not reset it: it limits interruptions.
// - A task marked done while the cap, a meeting or quiet nudges block the walk is dropped, not kept for later.
// - The slump window is the one the plan card uses (phase.ts slumpWindow: the personal hour, or 13:00–16:00).
// - A suggestion stays on the Dashboard until it is dismissed, a break is taken, a meeting starts, or the cap passes.
// - With the camera off (minutesSinceBreak null) only the after-task walk is suggested: screen time is unknown.

// ⚠️ Research report §3.3, not yet tested with users.
export const WALK = {
  leadMinutes: 30, // "30 menit sebelum jam rawan dimulai"
  beforeMinSinceBreak: 30, // the plan: menit_sejak_jeda ≥ 30
  slumpEveryMinutes: 30, // "tiap 30–40 menit layar terus-menerus": the short end
  minGapMinutes: 30, // "maks. 1 sela per 30 menit"
} as const;

const MINUTE = 60_000;

export const WALK_TRIGGERS = ["sebelum-rawan", "rawan", "tugas-selesai"] as const;
export type WalkTrigger = (typeof WALK_TRIGGERS)[number];

export const WALK_TEXT: Readonly<Record<WalkTrigger, string>> = {
  "sebelum-rawan": "Your low-energy time starts soon. A 5–10 minute walk now can help.",
  rawan: "You've been at the screen a while in your low-energy time. Take a 5–10 minute walk.",
  "tugas-selesai": "Task done. Take a 5–10 minute walk before the next one.",
};

export type WalkState = {
  lastAt: number | null; // wall clock of the last suggestion, for the cap
  shown: { at: number; trigger: WalkTrigger } | null; // the suggestion on screen now
};

export const initialWalkState = (): WalkState => ({ lastAt: null, shown: null });

export type WalkInput = {
  now: number; // wall clock ms
  minutesSinceBreak: number | null; // continuous screen time; null while not monitoring (camera off, calibrating, paused)
  slump: SlumpWindow;
  meeting: boolean; // "In a meeting" is on
  quiet: boolean; // nudges are snoozed, or another nudge is on screen right now
  taskDone?: boolean; // the user marked the planned task done just now
};

export type WalkStep = { state: WalkState; say: WalkTrigger | null; hide: boolean };

// Local time of `hour`:00 on the day of `now`.
function atHour(now: number, hour: number): number {
  const d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

function dueTrigger(input: WalkInput): WalkTrigger | null {
  if (input.taskDone) return "tugas-selesai";
  const since = input.minutesSinceBreak;
  if (since === null) return null;
  const start = atHour(input.now, input.slump.startHour);
  if (input.now >= start - WALK.leadMinutes * MINUTE && input.now < start) {
    return since >= WALK.beforeMinSinceBreak ? "sebelum-rawan" : null;
  }
  if (inSlump(input.now, input.slump)) return since >= WALK.slumpEveryMinutes ? "rawan" : null;
  return null;
}

export function stepWalk(state: WalkState, input: WalkInput): WalkStep {
  const { now } = input;
  // When the screen-time count last started again: after a break, or now while away on one.
  const restartedAt = input.minutesSinceBreak === null ? null : now - input.minutesSinceBreak * MINUTE;
  const stale =
    state.shown !== null &&
    ((restartedAt !== null && restartedAt > state.shown.at) || input.meeting || now - state.shown.at >= WALK.minGapMinutes * MINUTE);
  const next: WalkState = stale ? { ...state, shown: null } : state;

  const capped = state.lastAt !== null && now - state.lastAt < WALK.minGapMinutes * MINUTE;
  const trigger = input.meeting || input.quiet || capped ? null : dueTrigger(input);
  if (trigger === null) return { state: next, say: null, hide: stale };
  return { state: { lastAt: now, shown: { at: now, trigger } }, say: trigger, hide: false };
}

// "Dismiss": off the screen; it still counts for the cap.
export const dismissWalk = (state: WalkState): WalkState => ({ ...state, shown: null });
