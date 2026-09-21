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

// One frame of the blink state machine. `readable` is false when the eye cannot be
// judged: no face, or the head is down so far that the lids look closed while the
// person looks at a phone (features.ts eyesReadable). Such a frame (or a gap in the
// stream) ends the closure in progress: a short one is dropped, because we cannot
// tell when the eye reopened, but one that already lasted MAX_BLINK_MS is reported
// as long. That is what dozing off looks like: the eyes close, then the head drops.
export function stepBlink(
  state: BlinkState,
  t: number,
  ear: number,
  threshold: number,
  readable: boolean,
): { state: BlinkState; event: EyeClosure | null } {
  const continuing = t - state.lastT <= MAX_FRAME_GAP_MS ? state.closedSince : null;

  if (!readable || !Number.isFinite(ear)) {
    const durationMs = continuing === null ? 0 : t - continuing;
    return {
      state: { closedSince: null, lastT: t },
      event: continuing !== null && durationMs >= MAX_BLINK_MS ? { kind: "long", startT: continuing, endT: t, durationMs } : null,
    };
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

export function detectEyeClosures(
  frames: readonly FrameSignal[],
  threshold: number,
  readable: (f: FrameSignal) => boolean = (f) => f.face,
): EyeClosure[] {
  let state = initialBlinkState();
  const events: EyeClosure[] = [];
  for (const f of frames) {
    const step = stepBlink(state, f.t, f.ear, threshold, readable(f));
    state = step.state;
    if (step.event) events.push(step.event);
  }
  return events;
}
