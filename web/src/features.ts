import type { EyeClosure } from "./blink.ts";
import { bodyPresent, type BodySample } from "./body.ts";
import { median, perclosThreshold, type Baseline } from "./calibration.ts";
import type { FrameSignal } from "./signals.ts";
import type { YawnEvent } from "./yawn.ts";

// Field names are shared with the server whitelist (server/src/features.ts) and the
// Langflow prompt, hence Indonesian snake_case. null = not enough data to say.
export type WindowFeatures = {
  perclos: number | null; // share of readable-eye frames with the eye ≥80% closed
  kedip_per_menit: number | null;
  durasi_kedip_ms: number | null; // mean over blinks in the window
  mata_tertutup_lama: number; // eye closures of MAX_BLINK_MS or longer that ended in the window
  menguap: number;
  pct_kepala_menunduk: number | null; // share of face frames with the head down
  pct_wajah_hilang: number | null; // share of ALL frames without a face
  pct_mata_terbuka: number | null; // share of ALL frames with the face up and the eyes open
  pct_tubuh_ada: number | null; // share of body samples with a person in view; null = no body detection
  gerak_tubuh: number | null; // median body motion between samples; null = fewer than 2 samples
  n_frame: number;
  durasi_jendela_detik: number; // data actually covered (shorter than the window right after start)
};

export type WindowData = {
  frames: readonly FrameSignal[];
  closures: readonly EyeClosure[];
  yawns: readonly YawnEvent[];
  bodies: readonly BodySample[];
};

// ⚠️ Initial values, tuned on 23 Sep.
export const HEAD_DOWN_DEG = -15; // relative to the calibrated pitch
export const MIN_FACE_SECONDS_FOR_RATE = 5; // below this a blink rate is mostly noise
export const MIN_EYE_SECONDS_FOR_PERCLOS = 5; // below this PERCLOS rests on a handful of frames

export function headDown(f: FrameSignal, baseline: Baseline): boolean {
  return f.face && Number.isFinite(f.pitchDeg) && f.pitchDeg - baseline.pitchDeg <= HEAD_DOWN_DEG;
}

// The eye can only be judged while the head is roughly where it was during
// calibration. With the head down (looking at a phone or at paper) the upper lid
// follows the gaze and the webcam sees the eye from above, so EAR drops as if
// the eye were closed.
export function eyesReadable(f: FrameSignal, baseline: Baseline): boolean {
  return f.face && Number.isFinite(f.ear) && !headDown(f, baseline);
}

// Everything with t (or endT) in (now − windowMs, now] belongs to the window.
export function computeWindowFeatures(data: WindowData, baseline: Baseline, now: number, windowMs: number): WindowFeatures {
  const from = now - windowMs;
  const inWindow = (t: number) => t > from && t <= now;
  const all = data.frames.filter((f) => inWindow(f.t));
  const menguap = data.yawns.filter((y) => inWindow(y.endT)).length;
  const closures = data.closures.filter((c) => inWindow(c.endT));
  const bodies = data.bodies.filter((b) => inWindow(b.t));
  const motions = bodies.map((b) => b.motion).filter(Number.isFinite);
  const body = {
    mata_tertutup_lama: closures.filter((c) => c.kind === "long").length,
    pct_tubuh_ada: bodies.length > 0 ? bodies.filter((b) => bodyPresent(b, baseline.bodyArea)).length / bodies.length : null,
    gerak_tubuh: motions.length > 0 ? median(motions) : null,
  };

  if (all.length === 0) {
    return {
      perclos: null,
      kedip_per_menit: null,
      durasi_kedip_ms: null,
      menguap,
      pct_kepala_menunduk: null,
      pct_wajah_hilang: null,
      pct_mata_terbuka: null,
      ...body,
      n_frame: 0,
      durasi_jendela_detik: 0,
    };
  }

  const spanMs = now - all[0].t;
  const secondsOf = (n: number) => (spanMs / 1000) * (n / all.length);
  const faces = all.filter((f) => f.face && Number.isFinite(f.ear));
  const readable = faces.filter((f) => eyesReadable(f, baseline));
  const eyeSeconds = secondsOf(readable.length);
  const blinks = closures.filter((c) => c.kind === "blink");
  const pitches = faces.filter((f) => Number.isFinite(f.pitchDeg));
  const closedThreshold = perclosThreshold(baseline);
  const closed = readable.filter((f) => f.ear < closedThreshold).length;

  return {
    perclos: eyeSeconds >= MIN_EYE_SECONDS_FOR_PERCLOS ? closed / readable.length : null,
    kedip_per_menit: eyeSeconds >= MIN_FACE_SECONDS_FOR_RATE ? blinks.length / (eyeSeconds / 60) : null,
    durasi_kedip_ms: blinks.length > 0 ? blinks.reduce((sum, b) => sum + b.durationMs, 0) / blinks.length : null,
    menguap,
    pct_kepala_menunduk: pitches.length > 0 ? pitches.filter((f) => headDown(f, baseline)).length / pitches.length : null,
    pct_wajah_hilang: (all.length - faces.length) / all.length,
    pct_mata_terbuka: (readable.length - closed) / all.length,
    ...body,
    n_frame: all.length,
    durasi_jendela_detik: spanMs / 1000,
  };
}

// ── Minutes since the last break ────────────────────────────────────────────────
// A break = face absent for at least BREAK_MIN_MS in a row. Until the first one,
// the count starts at the beginning of the session.

export const BREAK_MIN_MS = 2 * 60_000;

export type BreakState = { sinceT: number; awaySince: number | null };

export const initialBreakState = (t: number): BreakState => ({ sinceT: t, awaySince: null });

export function stepBreak(state: BreakState, t: number, face: boolean): BreakState {
  if (!face) return state.awaySince === null ? { ...state, awaySince: t } : state;
  if (state.awaySince === null) return state;
  return t - state.awaySince >= BREAK_MIN_MS ? { sinceT: t, awaySince: null } : { ...state, awaySince: null };
}

export function minutesSinceBreak(state: BreakState, now: number): number {
  if (state.awaySince !== null && now - state.awaySince >= BREAK_MIN_MS) return 0; // on a break right now
  return (now - state.sinceT) / 60_000;
}
