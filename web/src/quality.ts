import { LOW_FPS } from "./blink.ts";
import type { Baseline } from "./calibration.ts";
import { eyesReadable, frameWeights, samplingFps, windowFrames } from "./features.ts";
import { LIGHT, type LightWindow } from "./light.ts";
import type { FrameSignal } from "./signals.ts";

// Can this window be judged, and how far (plan P20 W1.4, research report §2.7)? FaceLandmarker gives no
// tracking confidence, so quality comes from the frames themselves: the pose and size of the face, how
// readable the eyes are, and how often frames came. Pure, like the rest of the pipeline. Nothing here
// leaves the device: the level is a state of the UI and the local history, not a payload label (NOTES D-85).
//
//   nilai          every sign
//   terbatas-fps   below LOW_FPS: time-based signs only (features.ts leaves blink length and rate out)
//   terbatas-mata  the eyes are readable less than half of the time: yawns only, at most "lelah ringan"
//   tidak-dinilai  too few frames, the face turned away or too far, the eyes out of view, too dark or glaring (light.ts):
//                  no label, no advice, no automatic sending; the last label shows as stale
export type QualityLevel = "nilai" | "terbatas-fps" | "terbatas-mata" | "tidak-dinilai";
export type QualityReason = "fps" | "mata" | "wajah" | "cahaya" | "silau" | "kacamata";

// ⚠️ Proposals from the research report §2.7, not yet tuned on a camera (plan P20 W1.9, R-05).
export const QUALITY = {
  maxYawDeg: 30, // turned further than this, the far eye's EAR is foreshortened
  maxRollDeg: 25,
  maxPitchUpDeg: 20, // head tilted back this far above the calibrated pitch (head down is handled as unreadable eyes)
  minEyeDistPx: 35, // eye centres closer than this in the video: the face is too far or too small to read lids
  minDataShare: 0.5, // time with frames ÷ window time, below it the window is not judged (stalls, hidden tab)
  minFaceShare: 0.5, // valid face time ÷ time with frames, below it the window is not judged
  minEyeShare: 0.6, // readable eye time ÷ time with frames, below it the eye signs are left out
  // Glasses (W1.6a): closed ÷ open EAR above this at calibration means the lids could not be told apart from
  // the frame or reflections (two testers with glasses: 0.50 and 0.56; without: 0.05–0.15; NOTES G-73).
  maxClosedRatio: 0.3,
  // Left–right EAR difference ÷ open EAR: up to `lrOk` fully readable, from `lrBad` not at all (one lens glaring,
  // one eye covered). Not applied with the head turned past `lrMaxYawDeg`, where one eye is foreshortened anyway.
  lrOk: 0.25,
  lrBad: 0.5,
  lrMaxYawDeg: 15,
  confirmWindows: 2, // a new level shows after this many windows in a row
} as const;

// The eyes could not be calibrated apart (W1.6a): their signs are left out until the next calibration.
export const glassesLikely = (b: Baseline) => b.earOpen > 0 && b.earClosed / b.earOpen > QUALITY.maxClosedRatio;

const known = (x: number) => Number.isFinite(x);

// The face is where it can be read: facing the camera, upright, close enough. Unknown values (CSVs from before
// these columns existed, the UTA-RLDD extracts) count as fine.
export function validFace(f: FrameSignal, baseline: Baseline): boolean {
  if (!f.face) return false;
  if (known(f.yawDeg) && Math.abs(f.yawDeg) > QUALITY.maxYawDeg) return false;
  if (known(f.rollDeg) && Math.abs(f.rollDeg) > QUALITY.maxRollDeg) return false;
  if (known(f.pitchDeg) && f.pitchDeg - baseline.pitchDeg > QUALITY.maxPitchUpDeg) return false;
  return !(known(f.eyeDistPx) && f.eyeDistPx < QUALITY.minEyeDistPx);
}

// How much this frame's eyes can be trusted, 0–1. checkRange: the baseline's closed EAR comes from a deliberate
// eyes-closed stage, so glassesLikely() means something (MonitorOptions.eyesClosedStage).
export function eyeReliability(f: FrameSignal, baseline: Baseline, checkRange = false): number {
  if (!validFace(f, baseline) || !eyesReadable(f, baseline) || (checkRange && glassesLikely(baseline))) return 0;
  if (!known(f.earLeft) || !known(f.earRight) || baseline.earOpen <= 0) return 1;
  if (known(f.yawDeg) && Math.abs(f.yawDeg) > QUALITY.lrMaxYawDeg) return 1;
  const gap = Math.abs(f.earLeft - f.earRight) / baseline.earOpen;
  return Math.max(0, Math.min(1, (QUALITY.lrBad - gap) / (QUALITY.lrBad - QUALITY.lrOk)));
}

export type WindowQuality = {
  level: QualityLevel; // this window alone
  reason: QualityReason | null;
  wajah: number | null; // valid face time ÷ time with frames
  mata: number | null; // readable eye time ÷ time with frames
  fps: number | null; // sampling rate without the stalls (features.ts samplingFps)
};

// One window. Leaving the screen and hiding the eyes at the desk are judged by the rules (rules.ts: "tidak di
// depan layar", hiddenFaceNote), as are too few frames per second (lowFpsNote); this adds what the rules cannot see.
export function windowQuality(
  frames: readonly FrameSignal[],
  baseline: Baseline,
  now: number,
  windowMs: number,
  checkRange = false,
  light: LightWindow | null = null,
): WindowQuality {
  const all = windowFrames(frames, now, windowMs);
  // Light first (W1.5): in a dark room the landmarker loses the face, which would otherwise read as leaving.
  const lit = light !== null && light.n >= LIGHT.minSamples ? light : null;
  const problem = (share: number) => lit !== null && share >= LIGHT.minShare;
  if (lit && problem(lit.dark)) return { level: "tidak-dinilai", reason: "cahaya", wajah: null, mata: null, fps: samplingFps(all) };
  if (lit && problem(lit.glare)) return { level: "tidak-dinilai", reason: "silau", wajah: null, mata: null, fps: samplingFps(all) };
  if (all.length === 0) return { level: "tidak-dinilai", reason: "fps", wajah: null, mata: null, fps: null };
  const weights = frameWeights(all);
  const seenMs = weights.reduce((a, b) => a + b, 0);
  const share = (weightOf: (f: FrameSignal) => number) =>
    seenMs > 0 ? all.reduce((sum, f, i) => sum + weights[i] * weightOf(f), 0) / seenMs : 0;
  const facesSeen = all.filter((f) => f.face).length / all.length;
  const wajah = share((f) => (validFace(f, baseline) ? 1 : 0));
  const mata = share((f) => eyeReliability(f, baseline, checkRange));
  const fps = samplingFps(all);
  const result = (level: QualityLevel, reason: QualityReason | null) => ({ level, reason, wajah, mata, fps });
  // Stalls: the window's first frame up to now, against the time the frames stand for.
  if (seenMs < QUALITY.minDataShare * Math.max(now - all[0].t, seenMs)) return result("tidak-dinilai", "fps");
  // A face that is mostly missing is the rules' business (away, or hidden at the desk); one that is there
  // but turned away or too far is not readable.
  if (facesSeen >= QUALITY.minFaceShare && wajah < QUALITY.minFaceShare) return result("tidak-dinilai", "wajah");
  if (facesSeen >= QUALITY.minFaceShare && mata < QUALITY.minEyeShare) {
    return result("terbatas-mata", checkRange && glassesLikely(baseline) ? "kacamata" : "mata");
  }
  // Glare on the lenses (W1.6c) or eye areas far darker than the face (dark glasses): the lids are not readable.
  if (lit && problem(lit.eyeGlare)) return result("terbatas-mata", "silau");
  if (lit && problem(lit.covered)) return result("terbatas-mata", "mata");
  if (fps !== null && fps < LOW_FPS) return result("terbatas-fps", "fps");
  return result("nilai", null);
}

// ── What the UI shows: a new level after QUALITY.confirmWindows windows in a row ────
export type QualityState = { level: QualityLevel | null; reason: QualityReason | null; candidate: QualityLevel | null; streak: number };

export const initialQualityState = (): QualityState => ({ level: null, reason: null, candidate: null, streak: 0 });

export function stepQuality(
  state: QualityState,
  next: { level: QualityLevel; reason: QualityReason | null },
  required: number = QUALITY.confirmWindows,
): QualityState {
  if (state.level === null || state.level === next.level) return { level: next.level, reason: next.reason, candidate: null, streak: 0 };
  const streak = state.candidate === next.level ? state.streak + 1 : 1;
  return streak >= required
    ? { level: next.level, reason: next.reason, candidate: null, streak: 0 }
    : { ...state, candidate: next.level, streak };
}
