import type { FrameSignal } from "./signals.ts";

// Closures shorter than this are blinks; longer ones are "mata tertutup lama":
// they still count toward PERCLOS (per frame) but not toward blink statistics.
export const MAX_BLINK_MS = 1000;
// A longer pause between frames (stalled loop, background tab) breaks any episode in progress.
export const MAX_FRAME_GAP_MS = 500;

export type EyeClosure = {
  kind: "blink" | "long";
  startT: number; // first closed frame
  endT: number; // first reopened frame, so duration = closed frames × frame interval (±1 frame)
  durationMs: number;
};

export type BlinkState = { closedSince: number | null; lastT: number };

export const initialBlinkState = (): BlinkState => ({ closedSince: null, lastT: -Infinity });

// One frame of the blink state machine. A frame without a face (or a gap in the
// stream) cancels the closure in progress: we cannot tell when the eye reopened.
export function stepBlink(
  state: BlinkState,
  t: number,
  ear: number,
  threshold: number,
  face: boolean,
): { state: BlinkState; event: EyeClosure | null } {
  const continuing = t - state.lastT <= MAX_FRAME_GAP_MS ? state.closedSince : null;

  if (!face || !Number.isFinite(ear)) {
    return { state: { closedSince: null, lastT: t }, event: null };
  }
  if (ear < threshold) {
    return { state: { closedSince: continuing ?? t, lastT: t }, event: null };
  }
  if (continuing === null) {
    return { state: { closedSince: null, lastT: t }, event: null };
  }
  const durationMs = t - continuing;
  return {
    state: { closedSince: null, lastT: t },
    event: { kind: durationMs < MAX_BLINK_MS ? "blink" : "long", startT: continuing, endT: t, durationMs },
  };
}

export function detectEyeClosures(frames: readonly FrameSignal[], threshold: number): EyeClosure[] {
  let state = initialBlinkState();
  const events: EyeClosure[] = [];
  for (const f of frames) {
    const step = stepBlink(state, f.t, f.ear, threshold, f.face);
    state = step.state;
    if (step.event) events.push(step.event);
  }
  return events;
}
