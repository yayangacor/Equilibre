import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import { describe, expect, it } from "vitest";
import { brightness, faceBoxes, LIGHT, lightWindow, toLightSample, wholeFrame, type LightSample } from "./light.ts";
import { LEFT_EYE, RIGHT_EYE } from "./signals.ts";

// 478 landmarks on a face filling x 0.3–0.7, y 0.2–0.8 of the frame, the eyes as two 0.1-wide slits at y 0.4.
function face(): NormalizedLandmark[] {
  const points: NormalizedLandmark[] = Array.from({ length: 478 }, (_, i) => ({
    x: 0.3 + 0.4 * ((i % 20) / 19),
    y: 0.2 + 0.6 * (Math.floor(i / 20) / 23),
    z: 0,
    visibility: 0,
  }));
  const eye = (indices: readonly number[], left: number) => {
    const [p1, p2, p3, p4, p5, p6] = indices;
    const at = (x: number, y: number) => ({ x, y, z: 0, visibility: 0 });
    points[p1] = at(left, 0.4);
    points[p4] = at(left + 0.1, 0.4);
    points[p2] = at(left + 0.03, 0.39);
    points[p3] = at(left + 0.07, 0.39);
    points[p6] = at(left + 0.03, 0.41);
    points[p5] = at(left + 0.07, 0.41);
  };
  eye(RIGHT_EYE, 0.36);
  eye(LEFT_EYE, 0.54);
  return points;
}

// RGBA pixels, all of one grey value, plus `bright` pixels at 255.
const pixels = (grey: number, n: number, bright = 0) =>
  Array.from({ length: n }, (_, i) => (i < bright ? [255, 255, 255, 255] : [grey, grey, grey, 255])).flat();

describe("light: where it is measured", () => {
  it("reads the middle of the face, inside the oval, and a box around each eye", () => {
    const boxes = faceBoxes(face(), 640, 480);
    expect(boxes).not.toBeNull();
    const { face: f, eyes } = boxes!;
    // Face box 0.3–0.7 × 0.2–0.8 of 640 × 480 → its middle half across, 0.2–0.85 down.
    expect(f.x).toBeCloseTo(256, 0);
    expect(f.w).toBeCloseTo(128, 0);
    expect(f.y).toBeCloseTo(153.6, 0);
    expect(f.h).toBeCloseTo(187.2, 0);
    // Right eye spans x 0.36–0.46 (64 px): the box is 1.2 × as wide and 0.6 × as tall, around its centre.
    expect(eyes[0].w).toBeCloseTo(76.8, 0);
    expect(eyes[0].h).toBeCloseTo(38.4, 0);
    expect(eyes[0].x + eyes[0].w / 2).toBeCloseTo(0.41 * 640, 0);
    expect(eyes[0].y + eyes[0].h / 2).toBeCloseTo(0.4 * 480, 0);
    expect(eyes[1].x).toBeGreaterThan(eyes[0].x + eyes[0].w - 1);
  });

  it("keeps the boxes inside the frame, and gives up without landmarks", () => {
    const edge = face().map((p) => ({ ...p, x: p.x - 0.4 })); // the right eye partly out of the left edge
    const boxes = faceBoxes(edge, 640, 480);
    expect(boxes).not.toBeNull();
    expect(boxes!.eyes[0]).toMatchObject({ x: 0 });
    expect(boxes!.eyes[0].w).toBeCloseTo(44.8, 1);
    for (const b of boxes ? [boxes.face, ...boxes.eyes] : []) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(640);
    }
    expect(faceBoxes([], 640, 480)).toBeNull();
  });
});

describe("light: brightness", () => {
  it("averages Rec. 601 luma and counts overexposed pixels", () => {
    const flat = brightness(pixels(100, 100));
    expect(flat.luma).toBeCloseTo(100, 6);
    expect(flat.clipped).toBe(0);
    const glare = brightness(pixels(100, 100, 30));
    expect(glare.luma).toBeCloseTo(0.3 * 255 + 0.7 * 100, 5);
    expect(glare.clipped).toBeCloseTo(0.3, 5);
    // Pure red is dark in luma terms (0.299 × 255).
    expect(brightness([255, 0, 0, 255]).luma).toBeCloseTo(76.2, 1);
    expect(Number.isNaN(brightness([]).luma)).toBe(true);
  });

  it("puts the eye areas against the face, and keeps the worse lens glare", () => {
    const sample = toLightSample(5, { luma: 120, clipped: 0.01 }, [
      { luma: 30, clipped: 0.02 },
      { luma: 42, clipped: 0.11 },
    ]);
    expect(sample).toEqual({ t: 5, face: true, luma: 120, clipped: 0.01, eyes: 0.3, eyeGlare: 0.11 });
    const dark = toLightSample(5, { luma: 0, clipped: 0 }, [{ luma: 0, clipped: 0 }, { luma: 0, clipped: 0 }]);
    expect(Number.isNaN(dark.eyes)).toBe(true);
  });

  it("reads the whole frame when no face is found (a head on the desk fills the middle, review C 8 Nov)", () => {
    expect(wholeFrame(640, 480)).toEqual({ x: 0, y: 0, w: 640, h: 480 });
    expect(wholeFrame(1, 480)).toBeNull();
    const s = toLightSample(7, { luma: 12, clipped: 0 }, null);
    expect(s).toMatchObject({ face: false, luma: 12 });
    expect([s.eyes, s.eyeGlare].every(Number.isNaN)).toBe(true);
  });
});

describe("light: the window", () => {
  const sample = (t: number, luma: number, clipped = 0, eyes = 0.8, eyeGlare = 0): LightSample => ({
    t,
    face: true,
    luma,
    clipped,
    eyes,
    eyeGlare,
  });

  it("counts the share of samples with each problem inside (now − window, now]", () => {
    const samples = [sample(0, 20), sample(1_000, 20), sample(2_000, 30), sample(3_000, 120, 0.4), sample(4_000, 120, 0, 0.2)];
    const w = lightWindow(samples, 4_000, 4_000); // drops t = 0
    expect(w.n).toBe(4);
    expect(w.dark).toBeCloseTo(0.5);
    expect(w.glare).toBeCloseTo(0.25);
    expect(w.covered).toBeCloseTo(0.25);
    expect(w.luma).toBe(75); // median of 20, 30, 120, 120
  });

  it("counts darkness on every sample, glare and covered eyes on face samples only", () => {
    const noFace = (t: number, luma: number): LightSample => ({ t, face: false, luma, clipped: 0, eyes: NaN, eyeGlare: NaN });
    const w = lightWindow([noFace(1_000, 10), noFace(2_000, 10), sample(3_000, 120, 0, 0.8, 0.1), sample(4_000, 120)], 4_000, 60_000);
    expect(w.dark).toBeCloseTo(0.5);
    expect(w.eyeGlare).toBeCloseTo(0.5); // one of the two face samples
    expect(w.covered).toBe(0);
  });

  it("is empty without samples, and leaves broken ones out", () => {
    expect(lightWindow([], 10_000, 60_000)).toMatchObject({ n: 0, dark: 0, luma: null, eyes: null });
    expect(lightWindow([sample(1_000, NaN)], 10_000, 60_000).n).toBe(0);
  });

  it("marks the thresholds as initial values", () => {
    expect(LIGHT).toMatchObject({ darkLuma: 40, glareShare: 0.25, coveredEyes: 0.35, eyeGlare: 0.08, minShare: 0.5, minSamples: 5 });
  });
});
