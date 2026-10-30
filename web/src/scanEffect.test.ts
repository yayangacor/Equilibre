import { describe, expect, it } from "vitest";
import { blockSize, bodyShape, boxOf, inBody, SCAN, SCAN_TOTAL_MS, scanProgress } from "./scanEffect.ts";

describe("scanProgress", () => {
  it("shows the plain camera first, then sweeps in 1 s, then the boxes 0.5 s later", () => {
    expect(scanProgress(0)).toEqual({ sweep: 0, settle: 0, boxes: 0 });
    expect(scanProgress(SCAN.delayMs + SCAN.sweepMs / 2).sweep).toBeCloseTo(0.5);
    const swept = SCAN.delayMs + SCAN.sweepMs;
    expect(scanProgress(swept)).toEqual({ sweep: 1, settle: 0, boxes: 0 });
    expect(scanProgress(swept + SCAN.boxesAfterMs - 1).boxes).toBe(0); // negative control: not before 0.5 s
    expect(scanProgress(swept + SCAN.boxesAfterMs + SCAN.boxesInMs).boxes).toBe(1);
    expect(scanProgress(60_000)).toEqual({ sweep: 1, settle: 1, boxes: 1 });
  });

  it("ends the opening after every part has finished", () => {
    expect(scanProgress(SCAN_TOTAL_MS)).toEqual({ sweep: 1, settle: 1, boxes: 1 });
  });

  it("settles the blocks from coarse to fine", () => {
    expect(blockSize(0)).toBe(SCAN.coarsePixel);
    expect(blockSize(1)).toBe(SCAN.pixel);
    expect(blockSize(0.5)).toBeLessThan(SCAN.coarsePixel);
    expect(blockSize(0.5)).toBeGreaterThan(SCAN.pixel);
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

describe("bodyShape and inBody", () => {
  // A face in the middle of a 640×480 frame: x 0.42–0.58, y 0.2–0.5 (as the 30 Oct screenshot: seated, centred).
  const face = [
    { x: 0.42, y: 0.35 },
    { x: 0.58, y: 0.35 },
    { x: 0.5, y: 0.2 },
    { x: 0.5, y: 0.5 },
  ];
  const s = bodyShape(face, 640, 480)!;

  it("covers the head, the hair above the forehead, the neck and the torso down to the frame's bottom", () => {
    expect(inBody(s, 320, 168)).toBe(true); // face centre
    expect(inBody(s, 320, 80)).toBe(true); // hair above the forehead
    expect(inBody(s, 320, 250)).toBe(true); // neck
    expect(inBody(s, 320 + 1.2 * 102, 330)).toBe(true); // a shoulder
    expect(inBody(s, 320, 470)).toBe(true); // chest at the bottom edge
  });

  it("leaves the background beside the head and the frame's corners out (negative control)", () => {
    expect(inBody(s, 40, 470)).toBe(false); // bottom-left corner: the chairs in the screenshot
    expect(inBody(s, 600, 470)).toBe(false);
    expect(inBody(s, 150, 168)).toBe(false); // beside the head
    expect(inBody(s, 490, 168)).toBe(false);
    expect(inBody(s, 10, 10)).toBe(false);
  });

  it("needs a face", () => {
    expect(bodyShape([], 640, 480)).toBeNull();
    expect(bodyShape([{ x: 0.5, y: 0.5 }], 640, 480)).toBeNull(); // no size
  });
});
