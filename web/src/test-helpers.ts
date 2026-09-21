import type { Baseline } from "./calibration.ts";
import type { FrameSignal } from "./signals.ts";

export const FRAME_MS = 100; // 10 fps, like the live loop

export function frame(t: number, overrides: Partial<FrameSignal> = {}): FrameSignal {
  return {
    t,
    face: true,
    earLeft: 0.3,
    earRight: 0.3,
    ear: 0.3,
    jawOpen: 0.05,
    pitchDeg: 0,
    blinkLeft: 0,
    blinkRight: 0,
    lookDown: 0,
    ...overrides,
  };
}

export function noFace(t: number): FrameSignal {
  const nan = NaN;
  return { t, face: false, earLeft: nan, earRight: nan, ear: nan, jawOpen: nan, pitchDeg: nan, blinkLeft: nan, blinkRight: nan, lookDown: nan };
}

// One frame per value, FRAME_MS apart; null = no face in that frame.
export function earSeries(values: readonly (number | null)[], start = 0): FrameSignal[] {
  return values.map((v, i) => {
    const t = start + i * FRAME_MS;
    return v === null ? noFace(t) : frame(t, { ear: v, earLeft: v, earRight: v });
  });
}

export function jawSeries(values: readonly (number | null)[], start = 0): FrameSignal[] {
  return values.map((v, i) => {
    const t = start + i * FRAME_MS;
    return v === null ? noFace(t) : frame(t, { jawOpen: v });
  });
}

export const repeat = <T>(value: T, n: number): T[] => Array.from({ length: n }, () => value);

// Open 0.30, closed 0.10 → blink threshold 0.20, PERCLOS threshold 0.14.
export const BASELINE: Baseline = {
  earOpen: 0.3,
  earClosed: 0.1,
  blinkPerMin: 15,
  blinkDurationMs: 200,
  pitchDeg: -5,
  jawOpenP95: 0.2,
  bodyArea: 0.4,
  createdAt: 0,
};
