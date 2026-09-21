import type { EyeClosure } from "./blink.ts";
import { perclosThreshold, type Baseline } from "./calibration.ts";
import type { FrameSignal } from "./signals.ts";
import type { YawnEvent } from "./yawn.ts";

// Field names are shared with the server whitelist (server/src/features.ts) and the
// Langflow prompt, hence Indonesian snake_case. null = not enough data to say.
export type WindowFeatures = {
  perclos: number | null; // share of face frames with the eye ≥80% closed
  kedip_per_menit: number | null;
  durasi_kedip_ms: number | null; // mean over blinks in the window
  menguap: number;
  pct_kepala_menunduk: number | null; // share of face frames with the head down
  pct_wajah_hilang: number | null; // share of ALL frames without a face
  n_frame: number;
  durasi_jendela_detik: number; // data actually covered (shorter than the window right after start)
};

// ⚠️ Initial values, tuned on 23 Sep.
export const HEAD_DOWN_DEG = -15; // relative to the calibrated pitch
export const MIN_FACE_SECONDS_FOR_RATE = 5; // below this a blink rate is mostly noise

// Everything with t (or endT) in (now − windowMs, now] belongs to the window.
export function computeWindowFeatures(
  frames: readonly FrameSignal[],
  closures: readonly EyeClosure[],
  yawns: readonly YawnEvent[],
  baseline: Baseline,
  now: number,
  windowMs: number,
): WindowFeatures {
  const from = now - windowMs;
  const inWindow = (t: number) => t > from && t <= now;
  const all = frames.filter((f) => inWindow(f.t));
  const menguap = yawns.filter((y) => inWindow(y.endT)).length;

  if (all.length === 0) {
    return {
      perclos: null,
      kedip_per_menit: null,
      durasi_kedip_ms: null,
      menguap,
      pct_kepala_menunduk: null,
      pct_wajah_hilang: null,
      n_frame: 0,
      durasi_jendela_detik: 0,
    };
  }

  const spanMs = now - all[0].t;
  const faces = all.filter((f) => f.face && Number.isFinite(f.ear));
  const faceSeconds = (spanMs / 1000) * (faces.length / all.length);
  const blinks = closures.filter((c) => c.kind === "blink" && inWindow(c.endT));
  const pitches = faces.map((f) => f.pitchDeg).filter(Number.isFinite);
  const closedThreshold = perclosThreshold(baseline);

  return {
    perclos: faces.length > 0 ? faces.filter((f) => f.ear < closedThreshold).length / faces.length : null,
    kedip_per_menit: faceSeconds >= MIN_FACE_SECONDS_FOR_RATE ? blinks.length / (faceSeconds / 60) : null,
    durasi_kedip_ms: blinks.length > 0 ? blinks.reduce((sum, b) => sum + b.durationMs, 0) / blinks.length : null,
    menguap,
    pct_kepala_menunduk:
      pitches.length > 0 ? pitches.filter((p) => p - baseline.pitchDeg <= HEAD_DOWN_DEG).length / pitches.length : null,
    pct_wajah_hilang: (all.length - faces.length) / all.length,
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
