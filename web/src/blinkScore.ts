import { detectEyeClosures } from "./blink.ts";
import { blinkThreshold, closureConfirmThreshold, type Baseline } from "./calibration.ts";
import { eyesReadable } from "./features.ts";
import type { FrameSignal } from "./signals.ts";

// Drowsiness score from the shape of the recent blinks (plan P04, NOTES D-48 D-49). Features of the UTA-RLDD
// paper (Ghoddoosian et al., CVPRW 2019, eq. 2–5): duration, amplitude, eye-opening velocity and frequency,
// z-scored against the person's own calibration blinks and averaged over the last BLINK_SEQUENCE blinks.
// A logistic regression trained on 12 UTA-RLDD participants (alert vs drowsy videos) turns them into the
// chance that the pattern looks drowsy. Tested once on 6 unseen participants before the other 6 were added:
// 77.9% of 60 s windows, 10 of 12 videos. Shown only: the label stays with the rules (D-49).
// Pure, like the other pipeline modules: scripts/rldd-dataset.ts builds its training data with it.

export type BlinkShape = {
  startT: number; // first closed frame
  endT: number; // first reopened frame
  durasi: number; // ms
  amplitudo: number; // (EAR[start] − 2·EAR[bottom] + EAR[end]) / 2, start = last open frame
  kecepatan: number; // eye-opening velocity: (EAR[end] − EAR[bottom]) per second
};

type Stat = { mean: number; sd: number };
// Stored in the baseline (Baseline.kedip): the calibration blinks' statistics.
export type BlinkNorm = { durasi: Stat; amplitudo: Stat; kecepatan: Stat; perMenit: number; n: number };

export const BLINK_SEQUENCE = 30; // the paper's T
// ⚠️ Fewer calibration blinks than this give no norm; fewer recent blinks than MIN_SCORE_BLINKS give no score.
export const MIN_CALIBRATION_BLINKS = 5;
export const MIN_SCORE_BLINKS = 10;

const SHAPES = ["durasi", "amplitudo", "kecepatan"] as const;

// `frames` sorted by t and holding the closure; null when the frame before it or the reopened frame is missing.
export function blinkShape(frames: readonly FrameSignal[], startT: number, endT: number): BlinkShape | null {
  const s = frames.findIndex((f) => f.t === startT);
  const end = frames.findIndex((f) => f.t === endT);
  if (s <= 0 || end <= s) return null;
  let bottom = s;
  for (let i = s; i < end; i++) if (frames[i].ear < frames[bottom].ear) bottom = i;
  const [a, b, c] = [frames[s - 1].ear, frames[bottom].ear, frames[end].ear];
  if (![a, b, c].every(Number.isFinite)) return null;
  return {
    startT,
    endT,
    durasi: endT - startT,
    amplitudo: (a - 2 * b + c) / 2,
    kecepatan: (c - b) / ((frames[end].t - frames[bottom].t) / 1000),
  };
}

// Blinks with the same detector and thresholds as Monitor (blink.ts), so calibration and live blinks match.
export function blinkShapes(frames: readonly FrameSignal[], baseline: Baseline): BlinkShape[] {
  return detectEyeClosures(frames, blinkThreshold(baseline), (f) => eyesReadable(f, baseline), closureConfirmThreshold(baseline))
    .filter((e) => e.kind === "blink")
    .flatMap((e) => blinkShape(frames, e.startT, e.endT) ?? []);
}

// Norm from the calibration's "kerja normal" stage; frequency per minute of face time.
export function calibrateBlinks(normalFrames: readonly FrameSignal[], baseline: Baseline): BlinkNorm | null {
  const shapes = blinkShapes(normalFrames, baseline);
  if (shapes.length < MIN_CALIBRATION_BLINKS || normalFrames.length < 2) return null;
  const spanMin = (normalFrames[normalFrames.length - 1].t - normalFrames[0].t) / 60_000;
  const faceShare = normalFrames.filter((f) => f.face).length / normalFrames.length;
  const stat = (name: (typeof SHAPES)[number]): Stat => {
    const v = shapes.map((b) => b[name]);
    const mean = v.reduce((x, y) => x + y, 0) / v.length;
    return { mean, sd: Math.sqrt(v.reduce((x, y) => x + (y - mean) ** 2, 0) / v.length) || 1 };
  };
  return {
    durasi: stat("durasi"),
    amplitudo: stat("amplitudo"),
    kecepatan: stat("kecepatan"),
    perMenit: shapes.length / (spanMin * faceShare),
    n: shapes.length,
  };
}

export const SEQUENCE_FEATURES = ["zk_durasi_rata", "zk_amplitudo_rata", "zk_kecepatan_rata", "zk_frekuensi_relatif"] as const;
export type SequenceFeatures = Record<(typeof SEQUENCE_FEATURES)[number], number | null>;

// The last BLINK_SEQUENCE blinks that ended by `now`; frequency = their rate over the sequence's span,
// relative to the calibration rate. n = blinks in the sequence.
export function sequenceFeatures(shapes: readonly BlinkShape[], now: number, norm: BlinkNorm): { values: SequenceFeatures; n: number } {
  const seq = shapes.filter((b) => b.endT <= now).slice(-BLINK_SEQUENCE);
  const zMean = (name: (typeof SHAPES)[number]) =>
    seq.length > 0 ? seq.reduce((a, b) => a + (b[name] - norm[name].mean) / norm[name].sd, 0) / seq.length : null;
  const spanMin = seq.length > 1 ? (now - seq[0].startT) / 60_000 : null;
  return {
    values: {
      zk_durasi_rata: zMean("durasi"),
      zk_amplitudo_rata: zMean("amplitudo"),
      zk_kecepatan_rata: zMean("kecepatan"),
      zk_frekuensi_relatif: spanMin && norm.perMenit > 0 ? seq.length / spanMin / norm.perMenit : null,
    },
    n: seq.length,
  };
}

// Logistic regression exported by `scripts/rldd-evaluate.ts --ekspor` (plan P04): logit = bias + Σ weight·(x − center)/scale,
// a missing feature takes its training median (fill).
export type BlinkModel = {
  features: readonly (typeof SEQUENCE_FEATURES)[number][];
  fill: readonly number[];
  center: readonly number[];
  scale: readonly number[];
  weights: readonly number[];
  bias: number;
};

// Trained 30 Sep on 947 windows of 12 participants (Fold1_part1 + Fold1_part2, alert vs drowsy videos, calibration
// windows left out); leave-one-subject-out on those 12: 73.5% (majority 67.9%), 17 of 24 videos. Longer and more
// frequent blinks push the score up. The training windows were 68% drowsy, so a pattern equal to the person's own
// calibration still gives ±28%; 50% is the point where the validated classifier says "drowsy".
export const MODEL: BlinkModel = {
  features: SEQUENCE_FEATURES,
  fill: [0.74583, 0.10785, -0.08081, 1.239795],
  center: [1.144548, 0.14891, 0.053774, 1.586292],
  scale: [1.153673, 0.749955, 1.057778, 1.068854],
  weights: [1.615387, -0.410471, 0.294226, 1.968161],
  bias: 1.687326,
};

export function drowsyChance(values: SequenceFeatures, model: BlinkModel = MODEL): number {
  let logit = model.bias;
  model.features.forEach((name, j) => {
    const x = values[name] ?? model.fill[j];
    logit += (model.weights[j] * (x - model.center[j])) / model.scale[j];
  });
  return 1 / (1 + Math.exp(-logit));
}

// chance is null while fewer than MIN_SCORE_BLINKS recent blinks are known; n = blinks in the sequence.
export function blinkScore(shapes: readonly BlinkShape[], now: number, norm: BlinkNorm, model: BlinkModel = MODEL) {
  const { values, n } = sequenceFeatures(shapes, now, norm);
  return { chance: n < MIN_SCORE_BLINKS ? null : drowsyChance(values, model), n };
}
