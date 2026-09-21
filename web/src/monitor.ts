import { initialBlinkState, stepBlink, type EyeClosure } from "./blink.ts";
import type { BodySample } from "./body.ts";
import { blinkThreshold, type Baseline } from "./calibration.ts";
import { computeWindowFeatures, eyesReadable, type WindowFeatures } from "./features.ts";
import { evaluate, initialLabelState, SLEEP, type Evaluation, type Label, type LabelState } from "./rules.ts";
import type { FrameSignal } from "./signals.ts";
import { initialYawnState, stepYawn, type YawnEvent } from "./yawn.ts";

// The fatigue pipeline after calibration: rolling window → features → label.
// main.ts (webcam) and scripts/replay.ts (recorded CSV) both run it, so a threshold
// change behaves the same in both. Pure: no DOM, and time only comes from the input.

export type MonitorOptions = {
  windowMs: number;
  evalIntervalMs: number; // how often evaluate() is called; each evaluation stands for this much time
  minMenitLelah?: number; // SLEEP.fatigueMinutes unless shortened for demos (?lelah=N)
};

export type EvaluationStep = {
  features: WindowFeatures;
  latest: Evaluation | null;
  hold: string | null;
  menitLelah: number;
};

const HEAVY: readonly Label[] = ["lelah", "tertidur"];

export class Monitor {
  readonly baseline: Baseline;
  readonly options: MonitorOptions;
  labelState: LabelState = initialLabelState();
  private frames: FrameSignal[] = [];
  private bodies: BodySample[] = [];
  private closures: EyeClosure[] = [];
  private yawns: YawnEvent[] = [];
  // Shown label after each evaluation that judged the face (no hold), for "tertidur".
  private history: { t: number; label: Label }[] = [];
  private blinkState = initialBlinkState();
  private yawnState = initialYawnState();

  constructor(baseline: Baseline, options: MonitorOptions) {
    this.baseline = baseline;
    this.options = options;
  }

  pushFrame(s: FrameSignal): { closure: EyeClosure | null; yawn: YawnEvent | null } {
    this.frames.push(s);
    const blink = stepBlink(this.blinkState, s.t, s.ear, blinkThreshold(this.baseline), eyesReadable(s, this.baseline));
    this.blinkState = blink.state;
    if (blink.event) this.closures.push(blink.event);
    const yawn = stepYawn(this.yawnState, s.t, s.jawOpen, s.face);
    this.yawnState = yawn.state;
    if (yawn.event) this.yawns.push(yawn.event);

    const cutoff = s.t - this.options.windowMs;
    dropBefore(this.frames, cutoff, (f) => f.t);
    dropBefore(this.closures, cutoff, (c) => c.endT);
    dropBefore(this.yawns, cutoff, (y) => y.endT);
    dropBefore(this.bodies, cutoff, (b) => b.t);
    return { closure: blink.event, yawn: yawn.event };
  }

  pushBody(b: BodySample) {
    this.bodies.push(b);
  }

  features(now: number): WindowFeatures {
    const data = { frames: this.frames, closures: this.closures, yawns: this.yawns, bodies: this.bodies };
    return computeWindowFeatures(data, this.baseline, now, this.options.windowMs);
  }

  // Minutes the shown label was "lelah" (or already "tertidur") within SLEEP.historyMinutes.
  menitLelah(now: number): number {
    const from = now - SLEEP.historyMinutes * 60_000;
    const heavy = this.history.filter((h) => h.t > from && h.t <= now && HEAVY.includes(h.label)).length;
    return (heavy * this.options.evalIntervalMs) / 60_000;
  }

  evaluate(now: number): EvaluationStep {
    const features = this.features(now);
    const menitLelah = this.menitLelah(now);
    const sleep = { menitLelah, minMenitLelah: this.options.minMenitLelah ?? SLEEP.fatigueMinutes };
    const result = evaluate(features, this.baseline, this.labelState, sleep);
    this.labelState = result.state;
    if (result.latest && this.labelState.shown) {
      this.history.push({ t: now, label: this.labelState.shown.label });
      dropBefore(this.history, now - SLEEP.historyMinutes * 60_000, (h) => h.t);
    }
    return { features, latest: result.latest, hold: result.hold, menitLelah };
  }
}

function dropBefore<T>(list: T[], cutoff: number, time: (item: T) => number) {
  let n = 0;
  while (n < list.length && time(list[n]) <= cutoff) n++;
  if (n > 0) list.splice(0, n);
}
