import { describe, expect, it } from "vitest";
import { FACE_POINTS, OPEN_EAR, buildFace, earReading, posePoints } from "./faceModel.ts";
import { formatReading } from "./draw.ts";
import { edgePoints } from "./see.ts";
import { hasSession } from "./session.ts";

describe("face mesh", () => {
  const face = buildFace();
  const pose = (blink: number, jaw = 0, yaw = 0) =>
    posePoints(face.points, { blink, jaw, yaw }, new Float32Array(face.points.length * 2));

  it("has MediaPipe's point count, five iris points per eye, and is the same on every build", () => {
    expect(face.points).toHaveLength(FACE_POINTS);
    expect(face.points.filter((p) => p.kind === "iris")).toHaveLength(10);
    expect(buildFace().points).toEqual(face.points);
  });

  it("draws every surface point on at least two lines, and only the 468 surface points", () => {
    const degree = new Array<number>(468).fill(0);
    for (const [a, b] of face.mesh) {
      degree[a]++;
      degree[b]++;
    }
    expect(Math.min(...degree)).toBeGreaterThanOrEqual(2);
    expect(Math.max(...face.mesh.flat())).toBeLessThan(468);
    // Fewer lines than the 1365 triangle edges: the diagonals that make quads are left out.
    expect(face.mesh.length).toBeLessThan(1365);
    expect(face.mesh.length).toBeGreaterThan(1000);
  });

  it("keeps the face in the frame the layouts were made for", () => {
    const ys = face.points.map((p) => p.y);
    const xs = face.points.map((p) => p.x);
    expect(Math.min(...ys)).toBeCloseTo(-0.98, 5);
    expect(Math.max(...ys)).toBeCloseTo(1.06, 5);
    expect(Math.max(...xs.map(Math.abs))).toBeLessThan(0.9);
  });

  it("reads the open-eye EAR when open and a low EAR when the lids collapse (the readout dips with the blink)", () => {
    expect(earReading(face, pose(0), face.eyeL)).toBeCloseTo(OPEN_EAR, 5);
    const closed = earReading(face, pose(1), face.eyeR);
    expect(closed).toBeLessThan(0.08);
    expect(closed).toBeGreaterThan(0);
    expect(earReading(face, pose(0.5), face.eyeL)).toBeLessThan(OPEN_EAR);
  });

  it("opens the mouth with the jaw but leaves the eyes and the upper lip alone (negative controls)", () => {
    const shut = pose(0, 0);
    const open = pose(0, 0.3);
    const lowerLip = 17; // MediaPipe: lower lip, centre
    const upperLip = 0; // upper lip, centre
    expect(open[2 * lowerLip + 1] - shut[2 * lowerLip + 1]).toBeGreaterThan(0.15);
    expect(open[2 * upperLip + 1] - shut[2 * upperLip + 1]).toBeLessThan(0.01);
    expect(earReading(face, open, face.eyeL)).toBeCloseTo(OPEN_EAR, 5);
    // Nothing above the mouth moves.
    const moved = face.points.filter((p, i) => p.y < face.points[upperLip].y && open[2 * i + 1] !== shut[2 * i + 1]);
    expect(moved).toHaveLength(0);
  });

  it("turns the head: the nose tip moves towards the turn, and no yaw is the neutral pose", () => {
    const noseTip = 1;
    expect(pose(0, 0, 0.2)[2 * noseTip]).toBeGreaterThan(pose(0, 0, 0)[2 * noseTip] + 0.05);
    expect(pose(0, 0, 0)).toEqual(posePoints(face.points, { blink: 0, jaw: 0 }, new Float32Array(face.points.length * 2)));
  });
});

describe("landing helpers", () => {
  it("lifts the points off the picture's edges, spread apart and the same every time", () => {
    // 60 × 40 dark picture with a bright rectangle from (15, 10) to (45, 30).
    const w = 60;
    const h = 40;
    const gray = new Float32Array(w * h).map((_, i) => ((i % w) >= 15 && (i % w) < 45 && i / w >= 10 && i / w < 30 ? 255 : 0));
    const pts = edgePoints(gray, w, h, 60);
    expect(pts).toHaveLength(60);
    const offEdge = pts.filter(([u, v]) => {
      const x = u * w - 0.5;
      const y = v * h - 0.5;
      const nearX = Math.abs(x - 14.5) <= 1.5 || Math.abs(x - 44.5) <= 1.5;
      const nearY = Math.abs(y - 9.5) <= 1.5 || Math.abs(y - 29.5) <= 1.5;
      const inside = x >= 13 && x <= 46 && y >= 8 && y <= 31;
      return !(inside && (nearX || nearY));
    });
    expect(offEdge).toHaveLength(0);
    expect(new Set(pts.map((p) => p.join())).size).toBe(60);
    expect(edgePoints(gray, w, h, 60)).toEqual(pts);
  });

  it("still gives every face point a source when the picture has no edges (negative control)", () => {
    const pts = edgePoints(new Float32Array(16 * 9).fill(128), 16, 9, 478);
    expect(pts).toHaveLength(478);
    expect(pts.every(([u, v]) => u > 0 && u < 1 && v > 0 && v < 1)).toBe(true);
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
