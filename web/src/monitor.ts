import { initialBlinkState, LOW_FPS, stepBlink, type EyeClosure } from "./blink.ts";
import { BLINK_SEQUENCE, blinkScore, blinkShape, type BlinkShape } from "./blinkScore.ts";
import type { BodySample } from "./body.ts";
import { blinkThreshold, closureConfirmThreshold, type Baseline } from "./calibration.ts";
import { computeWindowFeatures, eyesReadable, samplingFps, windowFrames, type WindowFeatures } from "./features.ts";
import {
  initialQualityState,
  stepQuality,
  windowQuality,
  type QualityLevel,
  type QualityReason,
  type QualityState,
  type WindowQuality,
} from "./quality.ts";
import {
  ADVICE,
  evaluate,
  initialLabelState,
  type HoldCause,
  longRestAdvice,
  SLEEP,
  type Evaluation,
  type Label,
  type LabelState,
  type SleepLookback,
} from "./rules.ts";
import type { FrameSignal } from "./signals.ts";
import { initialYawnState, stepYawn, type YawnEvent } from "./yawn.ts";

// The fatigue pipeline after calibration: rolling window → features → label.
// main.ts (webcam) and scripts/replay.ts (recorded CSV) both run it, so a threshold
// change behaves the same in both. Pure: no DOM, and time only comes from the input.

export type MonitorOptions = {
  windowMs: number;
  evalIntervalMs: number; // how often evaluate() is called; each evaluation stands for this much time
  tidurMenit?: number; // SLEEP.eyesClosedMinutes unless shortened for demos (?tidur=N); the hidden-eyes path scales along
  blinkPattern?: boolean; // ?label=gabungan (NOTES D-72): the blink-pattern score may raise "normal" to "lelah ringan"
  // The baseline's closed EAR comes from a deliberate eyes-closed stage (the app's calibration), so its ratio to the
  // open EAR tells whether the lids can be told apart at all (plan P20 W1.6a). Off for calibrations without that
  // stage: UTA-RLDD stands in its deepest blink frames, which puts the ratio at 0.07–0.44 without glasses (G-57).
  eyesClosedStage?: boolean;
};

export type EvaluationStep = {
  features: WindowFeatures;
  latest: Evaluation | null;
  hold: string | null;
  lookback: SleepLookback;
  menitLelah: number;
  saran: string | null; // long rest advice (longRestAdvice)
  cause: HoldCause | null; // why this window was not judged
  quality: WindowQuality; // this window alone (quality.ts)
  assessed: QualityState; // what the UI shows: a new level after two windows in a row
  lastAssessedT: number | null; // the last evaluation that gave a label, for "last assessed N min ago"
};

const HEAVY: readonly Label[] = ["lelah", "tertidur"];

export class Monitor {
  readonly baseline: Baseline;
  readonly options: MonitorOptions;
  labelState: LabelState = initialLabelState();
  private frames: FrameSignal[] = [];
  private bodies: BodySample[] = [];
  private closures: EyeClosure[] = [];
  private blinkShapes: BlinkShape[] = []; // the last BLINK_SEQUENCE blinks within keepMs, for blinkScore
  private yawns: YawnEvent[] = [];
  // Shown label after each evaluation that judged the face (no hold).
  private history: { t: number; label: Label }[] = [];
  private blinkState = initialBlinkState();
  private yawnState = initialYawnState();
  private assessed = initialQualityState();
  private lastAssessedT: number | null = null;

  readonly sleepMinutes: { eyesClosed: number; eyesHidden: number };
  private readonly keepMs: number; // raw data is kept for the longest window that reads it

  constructor(baseline: Baseline, options: MonitorOptions) {
    this.baseline = baseline;
    this.options = options;
    const eyesClosed = options.tidurMenit ?? SLEEP.eyesClosedMinutes;
    this.sleepMinutes = { eyesClosed, eyesHidden: (eyesClosed * SLEEP.eyesHiddenMinutes) / SLEEP.eyesClosedMinutes };
    this.keepMs = Math.max(options.windowMs, this.sleepMinutes.eyesHidden * 60_000);
  }

  pushFrame(s: FrameSignal): { closure: EyeClosure | null; yawn: YawnEvent | null } {
    this.frames.push(s);
    const blink = stepBlink(
      this.blinkState,
      s.t,
      s.ear,
      blinkThreshold(this.baseline),
      eyesReadable(s, this.baseline),
      closureConfirmThreshold(this.baseline),
      { left: s.earLeft, right: s.earRight, yawDeg: s.yawDeg },
    );
    this.blinkState = blink.state;
    if (blink.event) this.closures.push(blink.event);
    if (blink.event?.kind === "blink") {
      // The reopened frame (endT = s.t) is already in this.frames.
      const shape = blinkShape(this.frames, blink.event.startT, blink.event.endT);
      if (shape) this.blinkShapes.push(shape);
      if (this.blinkShapes.length > BLINK_SEQUENCE) this.blinkShapes.shift();
    }
    const yawn = stepYawn(this.yawnState, s.t, s.jawOpen, s.face);
    this.yawnState = yawn.state;
    if (yawn.event) this.yawns.push(yawn.event);

    const cutoff = s.t - this.keepMs;
    dropBefore(this.frames, cutoff, (f) => f.t);
    dropBefore(this.closures, cutoff, (c) => c.endT);
    dropBefore(this.blinkShapes, cutoff, (b) => b.endT);
    dropBefore(this.yawns, cutoff, (y) => y.endT);
    dropBefore(this.bodies, cutoff, (b) => b.t);
    return { closure: blink.event, yawn: yawn.event };
  }

  pushBody(b: BodySample) {
    this.bodies.push(b);
  }

  // Blink-pattern score (blinkScore.ts, NOTES D-49): information only, unless options.blinkPattern (D-72).
  // null when the baseline has no blink norm (calibrated before the score existed). It was trained on 10 fps
  // blinks, so below LOW_FPS there is no score (lowFps; plan P20 W1.3).
  blinkScore(now: number): { chance: number | null; n: number; lowFps: boolean } | null {
    if (!this.baseline.kedip) return null;
    const score = blinkScore(this.blinkShapes, now, this.baseline.kedip);
    const fps = samplingFps(windowFrames(this.frames, now, this.options.windowMs));
    const lowFps = fps !== null && fps < LOW_FPS;
    return { chance: lowFps ? null : score.chance, n: score.n, lowFps };
  }

  features(now: number, windowMs: number = this.options.windowMs): WindowFeatures {
    const data = { frames: this.frames, closures: this.closures, yawns: this.yawns, bodies: this.bodies };
    return computeWindowFeatures(data, this.baseline, now, windowMs);
  }

  lookback(now: number): SleepLookback {
    const { eyesClosed, eyesHidden } = this.sleepMinutes;
    return {
      eyesClosed: this.features(now, eyesClosed * 60_000),
      eyesHidden: this.features(now, eyesHidden * 60_000),
      eyesClosedMinutes: eyesClosed,
      eyesHiddenMinutes: eyesHidden,
    };
  }

  // Minutes the shown label was "lelah" or "tertidur" within ADVICE.historyMinutes.
  menitLelah(now: number): number {
    const from = now - ADVICE.historyMinutes * 60_000;
    const heavy = this.history.filter((h) => h.t > from && h.t <= now && HEAVY.includes(h.label)).length;
    return (heavy * this.options.evalIntervalMs) / 60_000;
  }

  evaluate(now: number): EvaluationStep {
    const features = this.features(now);
    const lookback = this.lookback(now);
    const checkRange = this.options.eyesClosedStage ?? false;
    const quality = windowQuality(this.frames, this.baseline, now, this.options.windowMs, checkRange);
    const score = this.options.blinkPattern ? this.blinkScore(now) : null;
    const pattern = score && score.chance !== null ? { chance: score.chance, n: score.n } : null;
    const result = evaluate(features, this.baseline, this.labelState, lookback, pattern, quality);
    this.labelState = result.state;
    if (result.latest && this.labelState.shown) {
      this.history.push({ t: now, label: this.labelState.shown.label });
      dropBefore(this.history, now - ADVICE.historyMinutes * 60_000, (h) => h.t);
    }
    if (result.latest) this.lastAssessedT = now;
    // A window with a label was judged at its own level (away and asleep come from the rules, whatever the face
    // looked like); one without, for the reason the rules gave.
    const level: QualityLevel = result.latest ? (quality.level === "tidak-dinilai" ? "nilai" : quality.level) : "tidak-dinilai";
    const reason: QualityReason | null = result.latest ? (level === "nilai" ? null : quality.reason) : (result.cause ?? "fps");
    this.assessed = stepQuality(this.assessed, { level, reason });
    const menitLelah = this.menitLelah(now);
    return {
      features,
      latest: result.latest,
      hold: result.hold,
      lookback,
      menitLelah,
      saran: longRestAdvice(menitLelah),
      cause: result.cause,
      quality,
      assessed: this.assessed,
      lastAssessedT: this.lastAssessedT,
    };
  }
}

function dropBefore<T>(list: T[], cutoff: number, time: (item: T) => number) {
  let n = 0;
  while (n < list.length && time(list[n]) <= cutoff) n++;
  if (n > 0) list.splice(0, n);
}
