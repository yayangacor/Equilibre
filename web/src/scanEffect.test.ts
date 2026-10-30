import { describe, expect, it } from "vitest";
import { boxOf, SCAN, scanProgress } from "./scanEffect.ts";

describe("scanProgress", () => {
  it("shows the plain camera first, then sweeps in 1 s, then the boxes 0.5 s later", () => {
    expect(scanProgress(0)).toEqual({ sweep: 0, boxes: 0 });
    expect(scanProgress(SCAN.delayMs + SCAN.sweepMs / 2).sweep).toBeCloseTo(0.5);
    const swept = SCAN.delayMs + SCAN.sweepMs;
    expect(scanProgress(swept)).toEqual({ sweep: 1, boxes: 0 });
    expect(scanProgress(swept + SCAN.boxesAfterMs - 1).boxes).toBe(0); // negative control: not before 0.5 s
    expect(scanProgress(swept + SCAN.boxesAfterMs + SCAN.boxesInMs).boxes).toBe(1);
    expect(scanProgress(60_000)).toEqual({ sweep: 1, boxes: 1 });
  });
});

describe("boxOf", () => {
  it("frames the chosen landmarks in canvas pixels with padding", () => {
    const points = [
      { x: 0.4, y: 0.5 },
      { x: 0.5, y: 0.45 },
      { x: 0.6, y: 0.5 },
    ];
    const box = boxOf(points, [0, 1, 2], 100, 100, 0)!;
    expect(box.x).toBeCloseTo(40);
    expect(box.y).toBeCloseTo(45);
    expect(box.w).toBeCloseTo(20);
    expect(box.h).toBeCloseTo(5);
    const padded = boxOf(points, [0, 1, 2], 100, 100, 0.5)!;
    expect(padded.x).toBeCloseTo(30);
    expect(padded.w).toBeCloseTo(40);
  });

  it("returns null without landmarks", () => {
    expect(boxOf([], [33, 133], 640, 480)).toBeNull();
  });
});
