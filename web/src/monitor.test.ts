import { describe, expect, it } from "vitest";
import type { BodySample } from "./body.ts";
import { Monitor } from "./monitor.ts";
import type { Label } from "./rules.ts";
import type { FrameSignal } from "./signals.ts";
import { BASELINE, frame, FRAME_MS, noFace } from "./test-helpers.ts";

const EVAL_MS = 10_000;

// Plays a scenario like the live loop: a frame every 100 ms, a body sample every
// 500 ms, an evaluation every 10 s. Returns the shown label after each evaluation.
function play(
  monitor: Monitor,
  seconds: number,
  at: (t: number) => { frame: FrameSignal; body: Omit<BodySample, "t"> },
  start = 0,
): Label[] {
  const shown: Label[] = [];
  for (let t = start + FRAME_MS; t <= start + seconds * 1000; t += FRAME_MS) {
    const step = at(t);
    if (t % 500 === 0) monitor.pushBody({ t, ...step.body });
    monitor.pushFrame(step.frame);
    if (t % EVAL_MS === 0) {
      monitor.evaluate(t);
      shown.push(monitor.labelState.shown?.label ?? ("-" as Label));
    }
  }
  return shown;
}

const create = (minMenitLelah?: number) =>
  new Monitor(BASELINE, { windowMs: 60_000, evalIntervalMs: EVAL_MS, minMenitLelah });

const working = { area: 0.4, motion: 0.03 };
const still = { area: 0.4, motion: 0.003 };
const empty = { area: 0.01, motion: 0.001 };

// Drowsy but awake: eyes closed in 1 of every 5 frames (PERCLOS 20%).
const drowsy = (t: number) => ({ frame: frame(t, { ear: (t / FRAME_MS) % 5 === 0 ? 0.05 : 0.3 }), body: working });
const headOnDesk = (t: number) => ({ frame: noFace(t), body: still });

describe("Monitor", () => {
  it("does not call looking at a phone fatigue", () => {
    const monitor = create();
    const upright = (t: number) => ({ frame: frame(t), body: working });
    // Head down 30° past the baseline with the lids low, as when reading a phone.
    const phone = (t: number) => ({ frame: frame(t, { pitchDeg: -35, ear: 0.05 }), body: working });
    const labels = [...play(monitor, 30, upright), ...play(monitor, 90, phone, 30_000)];
    expect(new Set(labels)).toEqual(new Set(["normal"]));
    expect(monitor.features(120_000).pct_kepala_menunduk).toBe(1);
  });

  it("goes from lelah to tertidur when the head goes down on the desk after enough fatigue", () => {
    const monitor = create(1);
    const before = play(monitor, 90, drowsy);
    expect(before.at(-1)).toBe("lelah");
    expect(monitor.menitLelah(90_000)).toBeCloseTo(1.5);

    const after = play(monitor, 120, headOnDesk, 90_000);
    // Hidden face with the body still there: "lelah" is held until the window is
    // almost all hidden, then "tertidur" after the usual 2 confirmations.
    expect(after.slice(0, 5).every((l) => l === "lelah")).toBe(true);
    expect(after.at(-1)).toBe("tertidur");
  });

  it("does not say tertidur without a long fatigue history", () => {
    const monitor = create(); // 15 minutes of "lelah" needed
    play(monitor, 90, drowsy);
    expect(new Set(play(monitor, 120, headOnDesk, 90_000))).toEqual(new Set(["lelah"]));
  });

  it("says tidak di depan layar when the body is gone too", () => {
    const monitor = create(1);
    play(monitor, 90, drowsy);
    const left = play(monitor, 120, (t) => ({ frame: noFace(t), body: empty }), 90_000);
    expect(left.at(-1)).toBe("tidak di depan layar");
  });
});
