import type { FrameSignal } from "./signals.ts";

// Closures shorter than this are blinks; longer ones are "mata tertutup lama":
// they still count toward PERCLOS but not toward blink statistics.
export const MAX_BLINK_MS = 1000;
// A longer pause between frames (stalled loop, background tab) ends any episode in progress.
export const MAX_FRAME_GAP_MS = 500;
// ⚠️ Below this local rate (the closure's own frames ≥ 125 ms apart) one frame stands for so much time that
// "closed frames × interval" can call 0.8 s seen a 1 s closure, so a long closure is judged on the span seen,
// first to last closed frame (plan P20 W1.2, NOTES D-99). The plan's stricter draft (1.5 s seen, every frame
// deep) was measured first and dropped: none of the 22 long closures in the UTA-RLDD drowsy videos had every
// frame deep (22 of 22 begin or end on a half-closed lid), 10 of 22 last under 1.5 s, and no rule variant,
// old or new, produced a single long closure in the alert videos at 10, 7, 5 or 3 fps.
export const LOW_FPS = 8;
export const LOW_FPS_LONG_MS = 1000;
// ⚠️ A sample counts as deeply closed only when both eyes are closed too (plan P20 W1.6b: glare on one lens
// lowers one eye's EAR), unless the head is turned so far that the far eye is foreshortened.
export const AGREE_MAX_YAW_DEG = 15;

export type EyeClosure = {
  kind: "blink" | "long";
  startT: number; // first closed frame
  endT: number; // first reopened frame, so duration = closed frames × frame interval (±1 frame)
  durationMs: number;
  // Cut by a pause in the stream (MAX_FRAME_GAP_MS) while still closed: endT is the last closed frame and
  // durationMs only the span seen, so the eyes were closed at least that long (NOTES G-103).
  censored?: true;
};

// The closure in progress: its closed frames (`frames`), how many of them were deeply closed in both eyes
// (`deep`), and the summed intervals between its frames (`spanMs` over `steps`) for the local frame rate.
export type BlinkState = {
  closedSince: number | null;
  lastT: number;
  lastClosedT: number;
  frames: number;
  deep: number;
  spanMs: number;
  steps: number;
};

export const initialBlinkState = (): BlinkState => ({
  closedSince: null,
  lastT: -Infinity,
  lastClosedT: -Infinity,
  frames: 0,
  deep: 0,
  spanMs: 0,
  steps: 0,
});

// Per-eye EAR and head turn of the frame (signals.ts), for the agreement check; NaN = unknown.
export type EyePair = { left: number; right: number; yawDeg: number };

const bothClosed = (eyes: EyePair | undefined, threshold: number) =>
  !eyes ||
  !Number.isFinite(eyes.left) ||
  !Number.isFinite(eyes.right) ||
  (Number.isFinite(eyes.yawDeg) && Math.abs(eyes.yawDeg) > AGREE_MAX_YAW_DEG) ||
  (eyes.left < threshold && eyes.right < threshold);

// How the closure in progress ends. `endT`: the reopened (or unreadable) frame, or for a pause the last
// closed frame. Short closures are kept only when the eye was seen reopening: otherwise we cannot tell a
// blink from a closure whose end we missed. A closure is long from MAX_BLINK_MS with most of its frames deeply
// closed; below LOW_FPS (and whenever a pause cut it) the MAX_BLINK_MS must have been seen, not inferred.
function finish(s: BlinkState, endT: number, how: "reopened" | "unreadable" | "pause"): EyeClosure | null {
  if (s.closedSince === null) return null;
  const startT = s.closedSince;
  const seenMs = s.lastClosedT - startT;
  const steps = s.steps + (how === "pause" ? 0 : 1);
  const spanMs = s.spanMs + (how === "pause" ? 0 : endT - s.lastT);
  const lowFps = steps === 0 || spanMs / steps > 1000 / LOW_FPS;
  const confirmed = s.deep * 2 > s.frames;
  if (how === "pause") {
    const long = seenMs >= (lowFps ? LOW_FPS_LONG_MS : MAX_BLINK_MS) && confirmed;
    return long ? { kind: "long", startT, endT: s.lastClosedT, durationMs: seenMs, censored: true } : null;
  }
  const durationMs = endT - startT;
  const long = (lowFps ? seenMs >= LOW_FPS_LONG_MS : durationMs >= MAX_BLINK_MS) && confirmed;
  if (long) return { kind: "long", startT, endT, durationMs };
  return how === "reopened" && durationMs < MAX_BLINK_MS ? { kind: "blink", startT, endT, durationMs } : null;
}

// One frame of the blink state machine. `readable` is false when the eye cannot be judged: no face, or
// the head is down so far that the lids look closed while the person looks at a phone (features.ts
// eyesReadable). Such a frame ends the closure in progress: a short one is dropped, because we cannot
// tell when the eye reopened, but a long one is reported. That is what dozing off looks like: the eyes
// close, then the head drops. A pause in the stream (stalled loop, background tab) ends it the same way,
// at the last closed frame seen (censored). A slight head tilt passes `readable` and still lowers EAR,
// so a long closure needs its frames below `confirmThreshold` (calibration.ts closureConfirmThreshold).
// The default keeps every closure, for callers that only look at blinks.
export function stepBlink(
  state: BlinkState,
  t: number,
  ear: number,
  threshold: number,
  readable: boolean,
  confirmThreshold = Infinity,
  eyes?: EyePair,
): { state: BlinkState; event: EyeClosure | null } {
  const idle: BlinkState = { ...initialBlinkState(), lastT: t };
  const paused = t - state.lastT > MAX_FRAME_GAP_MS;
  const cut = paused ? finish(state, state.lastClosedT, "pause") : null;
  const s = paused ? idle : state;

  if (!readable || !Number.isFinite(ear)) {
    return { state: idle, event: cut ?? finish(s, t, "unreadable") };
  }
  if (ear < threshold) {
    const deep = ear < confirmThreshold && bothClosed(eyes, threshold) ? 1 : 0;
    const next: BlinkState =
      s.closedSince === null
        ? { closedSince: t, lastT: t, lastClosedT: t, frames: 1, deep, spanMs: 0, steps: 0 }
        : {
            closedSince: s.closedSince,
            lastT: t,
            lastClosedT: t,
            frames: s.frames + 1,
            deep: s.deep + deep,
            spanMs: s.spanMs + (t - s.lastT),
            steps: s.steps + 1,
          };
    return { state: next, event: cut };
  }
  return { state: idle, event: cut ?? finish(s, t, "reopened") };
}

export function detectEyeClosures(
  frames: readonly FrameSignal[],
  threshold: number,
  readable: (f: FrameSignal) => boolean = (f) => f.face,
  confirmThreshold = Infinity,
): EyeClosure[] {
  let state = initialBlinkState();
  const events: EyeClosure[] = [];
  for (const f of frames) {
    const eyes = { left: f.earLeft, right: f.earRight, yawDeg: f.yawDeg };
    const step = stepBlink(state, f.t, f.ear, threshold, readable(f), confirmThreshold, eyes);
    state = step.state;
    if (step.event) events.push(step.event);
  }
  return events;
}
