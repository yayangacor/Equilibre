import { MAX_FRAME_GAP_MS } from "./blink.ts";
import type { FrameSignal } from "./signals.ts";

// ⚠️ Initial values, tuned on 23 Sep. Duration is what separates a yawn from talking
// (RESEARCH.md bagian 1). If speech still counts as yawning: raise to 2000 ms or 0.6.
export const YAWN_JAW_OPEN = 0.5;
export const YAWN_MIN_MS = 1500;

export type YawnEvent = { startT: number; endT: number; durationMs: number };

export type YawnState = { openSince: number | null; lastT: number };

export const initialYawnState = (): YawnState => ({ openSince: null, lastT: -Infinity });

// One frame of the yawn detector: an episode is jawOpen ≥ YAWN_JAW_OPEN without a
// single frame below it, reported once when it ends. Unlike blinks, losing the
// face ends the episode instead of cancelling it, because people often cover
// their mouth while yawning; if it already lasted YAWN_MIN_MS it still counts.
export function stepYawn(
  state: YawnState,
  t: number,
  jawOpen: number,
  face: boolean,
): { state: YawnState; event: YawnEvent | null } {
  let event: YawnEvent | null = null;
  let openSince = state.openSince;
  const finish = (endT: number) => {
    if (openSince !== null && endT - openSince >= YAWN_MIN_MS) {
      event = { startT: openSince, endT, durationMs: endT - openSince };
    }
    openSince = null;
  };

  if (t - state.lastT > MAX_FRAME_GAP_MS) finish(state.lastT);

  if (face && jawOpen >= YAWN_JAW_OPEN) {
    openSince ??= t;
  } else {
    finish(t);
  }
  return { state: { openSince, lastT: t }, event };
}

export function detectYawns(frames: readonly FrameSignal[]): YawnEvent[] {
  let state = initialYawnState();
  const events: YawnEvent[] = [];
  for (const f of frames) {
    const step = stepYawn(state, f.t, f.jawOpen, f.face);
    state = step.state;
    if (step.event) events.push(step.event);
  }
  return events;
}
