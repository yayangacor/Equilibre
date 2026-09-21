import { describe, expect, it } from "vitest";
import type { BodySample } from "./body.ts";
import { Monitor } from "./monitor.ts";
import type { Label } from "./rules.ts";
import type { FrameSignal } from "./signals.ts";
import { BASELINE, frame, FRAME_MS, noFace } from "./test-helpers.ts";

const EVAL_MS = 10_000;

type Scene = (t: number) => { frame: FrameSignal; body: Omit<BodySample, "t"> };

// Plays a scenario like the live loop: a frame every 100 ms, a body sample every
// 500 ms, an evaluation every 10 s. Returns the shown label after each evaluation.
function play(monitor: Monitor, seconds: number, at: Scene, start = 0): Label[] {
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

// Minutes into a scene at which a label is first shown, or null.
const minutesUntil = (shown: Label[], label: Label) => {
  const i = shown.indexOf(label);
  return i < 0 ? null : ((i + 1) * EVAL_MS) / 60_000;
};

const create = (tidurMenit?: number) => new Monitor(BASELINE, { windowMs: 60_000, evalIntervalMs: EVAL_MS, tidurMenit });

const working = { area: 0.4, motion: 0.03 };
const still = { area: 0.4, motion: 0.003 };
const empty = { area: 0.01, motion: 0.001 };
// BASELINE.bodyArea 0.4: present from 0.12, "most of the body" (tertidur) from 0.2.
const coat = { area: 0.15, motion: 0.001 };

const upright: Scene = (t) => ({ frame: frame(t), body: working });
// Drowsy but awake: eyes closed in 1 of every 5 frames (PERCLOS 20%).
const drowsy: Scene = (t) => ({ frame: frame(t, { ear: (t / FRAME_MS) % 5 === 0 ? 0.05 : 0.3 }), body: working });
const eyesClosed: Scene = (t) => ({ frame: frame(t, { ear: 0.05 }), body: still });
const headOnDesk: Scene = (t) => ({ frame: noFace(t), body: still });
// Face still found, head dropped forward 30° past the baseline, lids low.
const headDropped: Scene = (t) => ({ frame: frame(t, { pitchDeg: -35, ear: 0.05 }), body: still });

// The lookback tolerates 10% open eyes and 10% movement, so "5 minutes" can be
// reached from 4.5 minutes on (and "10" from 9).
describe("Monitor: tertidur", () => {
  it("shows tertidur about 5 minutes after the eyes close, without any fatigue before", () => {
    const monitor = create();
    expect(new Set(play(monitor, 60, upright))).toEqual(new Set(["normal"]));
    const shown = play(monitor, 6 * 60, eyesClosed, 60_000);
    expect(minutesUntil(shown, "lelah")).toBeLessThanOrEqual(0.5); // PERCLOS first
    expect(minutesUntil(shown, "tertidur")).toBeGreaterThanOrEqual(4.5);
    expect(minutesUntil(shown, "tertidur")).toBeLessThanOrEqual(5);
    expect(shown.at(-1)).toBe("tertidur");
  });

  it("shows tertidur about 10 minutes after the head goes down on the desk, holding the label until then", () => {
    const monitor = create();
    play(monitor, 60, upright);
    const shown = play(monitor, 11 * 60, headOnDesk, 60_000);
    const minutes = minutesUntil(shown, "tertidur");
    expect(minutes).toBeGreaterThanOrEqual(9);
    expect(minutes).toBeLessThanOrEqual(10);
    expect(new Set(shown.slice(0, shown.indexOf("tertidur")))).toEqual(new Set(["normal"]));
  });

  it("also takes the 10-minute path when the head drops forward and the face stays visible", () => {
    const monitor = create();
    play(monitor, 60, upright);
    const shown = play(monitor, 11 * 60, headDropped, 60_000);
    expect(minutesUntil(shown, "tertidur")).toBeGreaterThanOrEqual(9);
    expect(shown.at(-1)).toBe("tertidur");
  });

  it("leaves tertidur within 30 seconds of waking up", () => {
    const monitor = create();
    play(monitor, 60, upright);
    expect(play(monitor, 6 * 60, eyesClosed, 60_000).at(-1)).toBe("tertidur");
    const awake = play(monitor, 30, upright, 7 * 60_000);
    expect(awake.at(-1)).not.toBe("tertidur");
  });

  it("shortens both paths for demos (?tidur=1)", () => {
    const monitor = create(1);
    play(monitor, 60, upright);
    const minutes = minutesUntil(play(monitor, 3 * 60, headOnDesk, 60_000), "tertidur");
    expect(minutes).toBeGreaterThanOrEqual(1.8);
    expect(minutes).toBeLessThanOrEqual(2);
  });
});

describe("Monitor: must not say tertidur or lelah", () => {
  it("does not call looking at a phone fatigue", () => {
    const monitor = create();
    // Head down 30° past the baseline with the lids low, as when reading a phone.
    const phone: Scene = (t) => ({ frame: frame(t, { pitchDeg: -35, ear: 0.05 }), body: working });
    const labels = [...play(monitor, 30, upright), ...play(monitor, 90, phone, 30_000)];
    expect(new Set(labels)).toEqual(new Set(["normal"]));
    expect(monitor.features(120_000).pct_kepala_menunduk).toBe(1);
  });

  it("is not tertidur while scrolling a phone in the lap (face hidden, small movements)", () => {
    const monitor = create();
    play(monitor, 60, upright);
    // Every 5th body sample moves: still 80% of the time, below the 90% needed.
    const lap: Scene = (t) => ({ frame: noFace(t), body: (t / 500) % 5 === 0 ? working : still });
    expect(new Set(play(monitor, 12 * 60, lap, 60_000))).toEqual(new Set(["normal"]));
  });

  it("is not tertidur while reading a phone very still, eyes seen open with the head down", () => {
    const monitor = create();
    play(monitor, 60, upright);
    const reading: Scene = (t) => ({ frame: frame(t, { pitchDeg: -35, ear: 0.32 }), body: still });
    expect(new Set(play(monitor, 12 * 60, reading, 60_000))).toEqual(new Set(["normal"]));
  });

  it("is not tertidur when a coat is left on the chair", () => {
    const monitor = create();
    play(monitor, 60, upright);
    const shown = play(monitor, 12 * 60, (t) => ({ frame: noFace(t), body: coat }), 60_000);
    expect(shown).not.toContain("tertidur");
  });

  it("says tidak di depan layar when the body is gone too", () => {
    const monitor = create();
    play(monitor, 90, drowsy);
    const left = play(monitor, 120, (t) => ({ frame: noFace(t), body: empty }), 90_000);
    expect(left.at(-1)).toBe("tidak di depan layar");
  });
});
