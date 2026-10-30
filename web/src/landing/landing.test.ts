import { describe, expect, it } from "vitest";
import { FACE_POINTS, OPEN_EAR, buildFace, earReading, posePoints } from "./faceModel.ts";
import { formatReading } from "./draw.ts";
import { allocate } from "./see.ts";
import { hasSession } from "./session.ts";

describe("synthetic face", () => {
  const face = buildFace();
  const pose = (blink: number, jaw = 0) => posePoints(face.points, { blink, jaw }, new Float32Array(face.points.length * 2));

  it("has MediaPipe's point count, five iris points per eye, and is the same on every build", () => {
    expect(face.points).toHaveLength(FACE_POINTS);
    expect(face.points.filter((p) => p.kind === "iris")).toHaveLength(10);
    expect(buildFace().points).toEqual(face.points);
  });

  it("reads the open-eye EAR when open and a low EAR when the lids collapse (the readout dips with the blink)", () => {
    expect(earReading(face, pose(0), face.eyeL)).toBeCloseTo(OPEN_EAR, 5);
    const closed = earReading(face, pose(1), face.eyeR);
    expect(closed).toBeLessThan(0.08);
    expect(closed).toBeGreaterThan(0);
    expect(earReading(face, pose(0.5), face.eyeL)).toBeLessThan(OPEN_EAR);
  });

  it("opens the mouth with the jaw but leaves the eyes alone (negative control)", () => {
    const shut = pose(0, 0);
    const open = pose(0, 0.3);
    const lowerLip = face.mouth[16];
    expect(open[2 * lowerLip + 1]).toBeGreaterThan(shut[2 * lowerLip + 1]);
    expect(earReading(face, open, face.eyeL)).toBeCloseTo(OPEN_EAR, 5);
  });
});

describe("landing helpers", () => {
  it("spreads samples over the drawing in proportion to length, exactly 478 in total", () => {
    const counts = allocate([100, 300, 1, 600], 478);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(478);
    expect(counts[2]).toBeGreaterThanOrEqual(1);
    expect(counts[3]).toBeGreaterThan(counts[1]);
  });

  it("formats readouts with a true minus sign and never shows −0", () => {
    expect(formatReading(-3, 0, "°")).toBe("−3°");
    expect(formatReading(-0.001, 2)).toBe("0.00");
    expect(formatReading(0.284, 2)).toBe("0.28");
  });

  it("recognises a Supabase session key only (negative controls)", () => {
    expect(hasSession(["theme", "sb-abcdefghijkl-auth-token"])).toBe(true);
    expect(hasSession(["sb-abcdefghijkl-auth-token-code-verifier"])).toBe(false);
    expect(hasSession(["equilibre-history", "auth-token"])).toBe(false);
    expect(hasSession([])).toBe(false);
  });
});
