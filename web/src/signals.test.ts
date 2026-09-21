import type { FaceLandmarkerResult, NormalizedLandmark } from "@mediapipe/tasks-vision";
import { describe, expect, it } from "vitest";
import { eyeAspectRatio, matrixLayout, pitchFromMatrix, RIGHT_EYE, toFrameSignal } from "./signals.ts";

const point = (x: number, y: number): NormalizedLandmark => ({ x, y, z: 0, visibility: 1 });

function landmarksWithRightEye(): NormalizedLandmark[] {
  const lm = Array.from({ length: 478 }, () => point(0.5, 0.5));
  const [p1, p2, p3, p4, p5, p6] = RIGHT_EYE;
  lm[p1] = point(0.3, 0.5);
  lm[p4] = point(0.4, 0.5); // 0.1 × 640 = 64 px wide
  lm[p2] = point(0.33, 0.48);
  lm[p6] = point(0.33, 0.52); // 0.04 × 480 = 19.2 px tall
  lm[p3] = point(0.37, 0.48);
  lm[p5] = point(0.37, 0.52);
  return lm;
}

describe("eyeAspectRatio", () => {
  it("scales normalized landmarks to pixels before measuring", () => {
    // (19.2 + 19.2) / (2 × 64) = 0.3; without scaling it would be 0.4.
    expect(eyeAspectRatio(landmarksWithRightEye(), RIGHT_EYE, 640, 480)).toBeCloseTo(0.3, 6);
  });
});

// 4×4 pose: rotation about X by `downDeg` (then about Y by `yawDeg`), face 50 cm in front of the camera.
function poseMatrix(downDeg: number, yawDeg = 0, layout: "column-major" | "row-major" = "column-major"): number[] {
  const a = (downDeg * Math.PI) / 180;
  const b = (yawDeg * Math.PI) / 180;
  const rx = [
    [1, 0, 0],
    [0, Math.cos(a), -Math.sin(a)],
    [0, Math.sin(a), Math.cos(a)],
  ];
  const ry = [
    [Math.cos(b), 0, Math.sin(b)],
    [0, 1, 0],
    [-Math.sin(b), 0, Math.cos(b)],
  ];
  const r = ry.map((row) => [0, 1, 2].map((c) => row.reduce((sum, v, k) => sum + v * rx[k][c], 0)));
  const m = [
    [...r[0], 1.5],
    [...r[1], -2],
    [...r[2], -50],
    [0, 0, 0, 1],
  ];
  return layout === "row-major" ? m.flat() : [0, 1, 2, 3].flatMap((c) => m.map((row) => row[c]));
}

describe("pitchFromMatrix", () => {
  it("detects the matrix layout from the translation", () => {
    expect(matrixLayout(poseMatrix(10))).toBe("column-major");
    expect(matrixLayout(poseMatrix(10, 0, "row-major"))).toBe("row-major");
  });

  it("is negative when the head tilts down, in both layouts", () => {
    expect(pitchFromMatrix(poseMatrix(20))).toBeCloseTo(-20, 6);
    expect(pitchFromMatrix(poseMatrix(20, 0, "row-major"))).toBeCloseTo(-20, 6);
    expect(pitchFromMatrix(poseMatrix(-10))).toBeCloseTo(10, 6);
  });

  it("ignores turning the head sideways", () => {
    expect(pitchFromMatrix(poseMatrix(20, 35))).toBeCloseTo(-20, 6);
  });
});

describe("toFrameSignal", () => {
  it("marks frames without a face and leaves every number NaN", () => {
    const empty: FaceLandmarkerResult = { faceLandmarks: [], faceBlendshapes: [], facialTransformationMatrixes: [] };
    const s = toFrameSignal(empty, 640, 480, 123);
    expect(s.face).toBe(false);
    expect(s.t).toBe(123);
    expect([s.ear, s.jawOpen, s.pitchDeg].every(Number.isNaN)).toBe(true);
  });

  it("reads blendshapes and pitch when a face is present", () => {
    const result = {
      faceLandmarks: [landmarksWithRightEye()],
      faceBlendshapes: [
        {
          categories: [
            { categoryName: "jawOpen", score: 0.6, index: 0, displayName: "" },
            { categoryName: "eyeBlinkLeft", score: 0.1, index: 1, displayName: "" },
          ],
          headIndex: 0,
          headName: "",
        },
      ],
      facialTransformationMatrixes: [{ rows: 4, columns: 4, data: poseMatrix(15) }],
    } satisfies FaceLandmarkerResult;
    const s = toFrameSignal(result, 640, 480, 0);
    expect(s.face).toBe(true);
    expect(s.earRight).toBeCloseTo(0.3, 6);
    expect(s.jawOpen).toBe(0.6);
    expect(s.blinkLeft).toBe(0.1);
    expect(s.blinkRight).toBeNaN();
    expect(s.pitchDeg).toBeCloseTo(-15, 6);
  });
});
