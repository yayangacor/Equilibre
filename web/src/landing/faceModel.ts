// Face model for the landing visuals (NOTES D-78): MediaPipe's canonical face mesh, the 468-vertex surface the face
// landmarker fits to every face, drawn as a wireframe of lines and points, plus five iris points per eye (478 points,
// as MediaPipe reports). It is the fixed model that ships inside face_landmarker.task: no photo, no camera.
// Normalized coordinates: x to the right, y down; the face spans about x in [-0.84, 0.84] and y in [-0.98, 1.06].
import { CANONICAL_TRIANGLES, CANONICAL_VERTICES } from "./faceMeshData.ts";

export const FACE_POINTS = 478;
/** The eye aspect ratio (EAR) the open eyes of the model read as. */
export const OPEN_EAR = 0.29;

export type PointKind = "outline" | "brow" | "lid" | "iris" | "nose" | "lip" | "fill";

export interface FacePoint {
  readonly x: number;
  readonly y: number;
  /** Depth towards the viewer, centred on the face; used when the head turns (yaw). */
  readonly z: number;
  readonly kind: PointKind;
  /** How far down the point moves per unit of jaw opening (0 = it does not follow the jaw). */
  readonly jaw: number;
  /** Upper-lid, lid-fold and iris points: the y they move to when the eye closes. */
  readonly closeY?: number;
}

export interface EyeIndices {
  /** Closed loop of lid points: outer corner, upper lid, inner corner, lower lid. */
  readonly loop: readonly number[];
  /** The six landmarks of the EAR formula: corner, upper, upper, corner, lower, lower. */
  readonly ear: readonly [number, number, number, number, number, number];
  /** Iris: centre first, then four ring points (top, right, bottom, left). */
  readonly iris: readonly number[];
}

export interface Face {
  readonly points: readonly FacePoint[];
  /** Feature polylines (closed when the first index is repeated at the end), drawn heavier than the mesh. */
  readonly contours: readonly (readonly number[])[];
  /** Wireframe edges of the surface. */
  readonly mesh: readonly (readonly [number, number])[];
  /** Viewer's left eye (L) and right eye (R). */
  readonly eyeL: EyeIndices;
  readonly eyeR: EyeIndices;
  /** Outer lip loop. */
  readonly mouth: readonly number[];
  /** Mouth corners, viewer's left then right. */
  readonly mouthCorners: readonly [number, number];
  /** Mean raw eye aspect of the open eyes, used to scale readings to OPEN_EAR. */
  readonly openAspect: number;
}

export interface Pose {
  /** 0 = eyes open, 1 = eyes closed. */
  readonly blink: number;
  /** Jaw opening, on the same 0..1 scale as the "Jaw open" readout. */
  readonly jaw: number;
  /** Head turn in radians, positive towards the viewer's right. */
  readonly yaw?: number;
}

/** Small seeded PRNG (mulberry32), so the same sequence comes out on every load. */
export function seeded(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Landmark indices from MediaPipe's connection lists (FaceLandmarker.FACE_LANDMARKS_*, FACEMESH_NOSE). The viewer's
// left eye is MediaPipe's RIGHT_EYE: the subject's right is on the left of a camera image. The EAR sixes are the
// ones the app measures (signals.ts RIGHT_EYE, LEFT_EYE).
const OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
  172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];
const BROWS = [
  [46, 53, 52, 65, 55],
  [70, 63, 105, 66, 107],
  [276, 283, 282, 295, 285],
  [300, 293, 334, 296, 336],
];
const EYES = {
  L: {
    upper: [33, 246, 161, 160, 159, 158, 157, 173, 133],
    lower: [33, 7, 163, 144, 145, 153, 154, 155, 133],
    ear: [33, 160, 158, 133, 153, 144],
    iris: 468,
  },
  R: {
    upper: [263, 466, 388, 387, 386, 385, 384, 398, 362],
    lower: [263, 249, 390, 373, 374, 380, 381, 382, 362],
    ear: [362, 385, 387, 263, 373, 380],
    iris: 473,
  },
} as const;
const LIPS = {
  outerUpper: [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291],
  outerLower: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291],
  innerUpper: [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308],
  innerLower: [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308],
};
const NOSE = [
  [168, 6, 197, 195, 5, 4, 1, 19, 94, 2],
  [98, 97, 2, 326, 327],
  [327, 294, 278, 344, 440, 275, 4, 45, 220, 115, 48, 64, 98],
];

/** Above the eyes the head narrows a little and the whole face is stretched slightly: the canonical mesh stops at
 * mid-forehead with nearly straight sides, and this gives it the egg shape of a classic face wireframe. */
const TOP_TAPER = 0.2;
const STRETCH_Y = 1.07;
/** Normalized face height, top of the forehead to the chin (the old point-cloud face had the same). */
const HEIGHT = 2.04;
const TOP = -0.98;
/** Where a closing upper lid ends, from the corner line (0) to the lower lid (1). */
const LID_CLOSE = 0.65;

/** y of a polyline at x, by linear interpolation (x clamped to the polyline's ends). */
function yAlong(chain: readonly { x: number; y: number }[], x: number): number {
  const pts = [...chain].sort((a, b) => a.x - b.x);
  if (x <= pts[0].x) return pts[0].y;
  for (let k = 1; k < pts.length; k++) {
    if (x <= pts[k].x) {
      const a = pts[k - 1];
      const b = pts[k];
      return a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x || 1);
    }
  }
  return pts[pts.length - 1].y;
}

const smoothstep = (a: number, b: number, v: number): number => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function buildFace(): Face {
  // Canonical vertices: y flipped to point down, warped, then scaled so the face is HEIGHT tall with its top at TOP.
  const raw: [number, number, number][] = [];
  for (let i = 0; i < CANONICAL_VERTICES.length; i += 3) {
    const x = CANONICAL_VERTICES[i];
    const y = -CANONICAL_VERTICES[i + 1];
    const t = Math.max(0, Math.min(1, (-y - 2) / 6.26));
    raw.push([x * (1 - TOP_TAPER * t * t), y * STRETCH_Y, CANONICAL_VERTICES[i + 2]]);
  }
  const minY = Math.min(...raw.map((p) => p[1]));
  const maxY = Math.max(...raw.map((p) => p[1]));
  const meanZ = raw.reduce((a, p) => a + p[2], 0) / raw.length;
  const k = HEIGHT / (maxY - minY);
  const xs = raw.map((p) => p[0] * k);
  const ys = raw.map((p) => (p[1] - minY) * k + TOP);
  const zs = raw.map((p) => (p[2] - meanZ) * k);
  const at = (i: number) => ({ x: xs[i], y: ys[i] });

  const kind: PointKind[] = raw.map(() => "fill");
  const mark = (indices: readonly number[], as: PointKind) => indices.forEach((i) => (kind[i] = as));
  mark(OVAL, "outline");
  BROWS.forEach((b) => mark(b, "brow"));
  NOSE.forEach((n) => mark(n, "nose"));
  mark([...LIPS.outerUpper, ...LIPS.outerLower, ...LIPS.innerUpper, ...LIPS.innerLower], "lip");
  for (const eye of Object.values(EYES)) mark([...eye.upper, ...eye.lower], "lid");

  const closeY: (number | undefined)[] = raw.map(() => undefined);
  const iris: { x: number; y: number; z: number; closeY: number }[] = [];
  for (const eye of [EYES.L, EYES.R]) {
    const upper = eye.upper.map(at);
    const lower = eye.lower.map(at);
    const c0 = upper[0];
    const c1 = upper[upper.length - 1];
    const cornerY = (x: number) => c0.y + ((c1.y - c0.y) * (x - c0.x)) / (c1.x - c0.x);
    const closedY = (x: number) => cornerY(x) + LID_CLOSE * (yAlong(lower, x) - cornerY(x));
    const cx = (c0.x + c1.x) / 2;
    const opening = yAlong(lower, cx) - yAlong(upper, cx);
    for (const i of eye.upper.slice(1, -1)) closeY[i] = closedY(xs[i]);
    // The skin between the lid and the brow folds down with it, less the further up it sits.
    const x0 = Math.min(c0.x, c1.x);
    const x1 = Math.max(c0.x, c1.x);
    for (let i = 0; i < xs.length; i++) {
      if (kind[i] !== "fill" || xs[i] <= x0 || xs[i] >= x1) continue;
      const gap = yAlong(upper, xs[i]) - ys[i];
      if (gap <= 0 || gap > 2 * opening) continue;
      closeY[i] = ys[i] + 0.5 * (1 - gap / (2 * opening)) * (closedY(xs[i]) - yAlong(upper, xs[i]));
    }
    // Iris: centred in the opening, as wide as fits inside it.
    const cy = (yAlong(upper, cx) + yAlong(lower, cx)) / 2;
    const r = Math.min(0.15 * Math.abs(c1.x - c0.x), 0.85 * (opening / 2));
    const z = eye.upper.reduce((a, i) => a + zs[i], 0) / eye.upper.length;
    for (const [dx, dy] of [[0, 0], [0, -r], [r, 0], [0, r], [-r, 0]]) {
      iris.push({ x: cx + dx, y: cy + dy, z, closeY: closedY(cx + dx) });
    }
  }

  // Jaw: below the line where the lips meet, the lower lip, chin and jaw move down together, less towards the
  // ears; outside the mouth the boundary runs from the mouth corners down to the jaw angles. The upper lip stays.
  const upperLip = new Set([...LIPS.outerUpper, ...LIPS.innerUpper]);
  const corners = new Set([61, 291, 78, 308]);
  const meet = LIPS.innerUpper.map((i, n) => ({ x: xs[i], y: (ys[i] + ys[LIPS.innerLower[n]]) / 2 }));
  const mouthHalf = xs[291];
  const cornerLevel = ys[291];
  const jawAngle = { x: Math.abs(xs[288]), y: ys[288] };
  const halfWidth = Math.max(...xs);
  const jaw = xs.map((x, i) => {
    const reach = 0.6 * (1 - 0.6 * (x / halfWidth) ** 2);
    if (corners.has(i)) return 0.25 * reach;
    if (upperLip.has(i)) return 0;
    const ax = Math.abs(x);
    if (ax <= mouthHalf) return ys[i] > yAlong(meet, x) ? reach : 0;
    const edge = cornerLevel + ((ax - mouthHalf) * (jawAngle.y - cornerLevel)) / (jawAngle.x - mouthHalf);
    return reach * smoothstep(edge - 0.01, edge + 0.08, ys[i]);
  });

  const points: FacePoint[] = xs.map((x, i) => {
    const base = { x, y: ys[i], z: zs[i], kind: kind[i], jaw: jaw[i] };
    return closeY[i] === undefined ? base : { ...base, closeY: closeY[i] };
  });
  for (const p of iris) points.push({ ...p, kind: "iris", jaw: 0 });

  // Wireframe: the triangle edges, minus each diagonal that is the longest edge of both triangles sharing it.
  // What is left is mostly quads that follow the face's edge loops (around the eyes, nose and mouth).
  const len = (a: number, b: number) => Math.hypot(xs[a] - xs[b], ys[a] - ys[b], zs[a] - zs[b]);
  const key = (a: number, b: number) => (a < b ? a * 1024 + b : b * 1024 + a);
  const longestIn = new Map<number, number>();
  const edges = new Map<number, [number, number]>();
  for (let t = 0; t < CANONICAL_TRIANGLES.length; t += 3) {
    const [a, b, c] = CANONICAL_TRIANGLES.slice(t, t + 3);
    const sides: [number, number][] = [[a, b], [b, c], [c, a]];
    for (const [p, q] of sides) edges.set(key(p, q), p < q ? [p, q] : [q, p]);
    const [p, q] = sides.reduce((m, s) => (len(s[0], s[1]) > len(m[0], m[1]) ? s : m));
    longestIn.set(key(p, q), (longestIn.get(key(p, q)) ?? 0) + 1);
  }
  const mesh = [...edges].filter(([k]) => longestIn.get(k) !== 2).map(([, e]) => e);

  const loop = (eye: (typeof EYES)["L" | "R"]) => [...eye.upper, ...[...eye.lower].reverse().slice(1)];
  const eyeOf = (eye: (typeof EYES)["L" | "R"]): EyeIndices => ({
    loop: loop(eye),
    ear: eye.ear,
    iris: [0, 1, 2, 3, 4].map((n) => eye.iris + n),
  });
  const eyeL = eyeOf(EYES.L);
  const eyeR = eyeOf(EYES.R);
  const mouth = [...LIPS.outerUpper, ...[...LIPS.outerLower].reverse().slice(1)];
  const contours = [
    [...OVAL, OVAL[0]],
    ...BROWS,
    eyeL.loop,
    eyeR.loop,
    mouth,
    [...LIPS.innerUpper, ...[...LIPS.innerLower].reverse().slice(1)],
    ...NOSE,
  ];

  const neutral = posePoints(points, { blink: 0, jaw: 0 }, new Float32Array(points.length * 2));
  const openAspect = (rawAspect(neutral, eyeL.ear) + rawAspect(neutral, eyeR.ear)) / 2;
  return { points, contours, mesh, eyeL, eyeR, mouth, mouthCorners: [61, 291], openAspect };
}

/** Writes the posed x, y of every point into `out` (x0, y0, x1, y1, ...) and returns it. */
export function posePoints(points: readonly FacePoint[], pose: Pose, out: Float32Array): Float32Array {
  const yaw = pose.yaw ?? 0;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    let y = p.y;
    if (p.closeY !== undefined) y += (p.closeY - p.y) * pose.blink;
    out[2 * i] = p.x * cos + p.z * sin;
    out[2 * i + 1] = y + p.jaw * pose.jaw;
  }
  return out;
}

function rawAspect(pos: Float32Array, ear: EyeIndices["ear"]): number {
  const d = (a: number, b: number) => Math.hypot(pos[2 * a] - pos[2 * b], pos[2 * a + 1] - pos[2 * b + 1]);
  const [p1, p2, p3, p4, p5, p6] = ear;
  return (d(p2, p6) + d(p3, p5)) / (2 * d(p1, p4));
}

/** EAR reading of one eye for posed points, scaled so that open eyes read OPEN_EAR. */
export function earReading(face: Face, pos: Float32Array, eye: EyeIndices): number {
  return (OPEN_EAR * rawAspect(pos, eye.ear)) / face.openAspect;
}

let shared: Face | undefined;
/** One face for the whole page (the hero, the "Watch" step and "What we see" draw the same one). */
export function sharedFace(): Face {
  shared ??= buildFace();
  return shared;
}
