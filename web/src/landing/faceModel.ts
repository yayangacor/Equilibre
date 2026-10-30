// Synthetic face point cloud for the landing page (NOTES D-78). It imitates the shape of MediaPipe's face mesh
// (478 points: contours, two irises and a fill of surface points) but is generated from a seed: no photo, no camera.
// Normalized coordinates: x to the right, y down; the face spans about x in [-0.8, 0.8] and y in [-0.98, 1.06].

export const FACE_POINTS = 478;
/** The eye aspect ratio (EAR) the open eyes of the synthetic face read as. */
export const OPEN_EAR = 0.29;

export type PointKind = "outline" | "brow" | "lid" | "iris" | "nose" | "lip" | "fill";

export interface FacePoint {
  readonly x: number;
  readonly y: number;
  readonly kind: PointKind;
  /** How far down the point moves per unit of jaw opening (0 = it does not follow the jaw). */
  readonly jaw: number;
  /** Upper-lid and iris points: the y they collapse to when the eye closes. */
  readonly closeY?: number;
}

export interface EyeIndices {
  /** Closed loop of lid points: outer corner, upper lid, other corner, lower lid. */
  readonly loop: readonly number[];
  /** The six landmarks of the EAR formula: corner, upper, upper, corner, lower, lower. */
  readonly ear: readonly [number, number, number, number, number, number];
  /** Iris: centre first, then four ring points (top, right, bottom, left). */
  readonly iris: readonly number[];
}

export interface Face {
  readonly points: readonly FacePoint[];
  /** Polylines through feature points (closed when the first index is repeated at the end). */
  readonly contours: readonly (readonly number[])[];
  /** Faint neighbour links that make the fill read as a mesh. */
  readonly mesh: readonly (readonly [number, number])[];
  /** Viewer's left eye (L) and right eye (R). */
  readonly eyeL: EyeIndices;
  readonly eyeR: EyeIndices;
  /** Outer lip loop. */
  readonly mouth: readonly number[];
  /** Mean raw eye aspect of the open eyes, used to scale readings to OPEN_EAR. */
  readonly openAspect: number;
}

export interface Pose {
  /** 0 = eyes open, 1 = eyes closed. */
  readonly blink: number;
  /** Jaw opening, on the same 0..1 scale as the "Jaw open" readout. */
  readonly jaw: number;
}

/** Small seeded PRNG (mulberry32), so the face is identical on every load. */
export function seeded(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EYE_Y = -0.17;
const EYE_HALF_W = 0.16;
const LID_UP = 0.085;
const LID_DOWN = 0.055;
const MOUTH_Y = 0.5;

/** Half-width of the face outline at height y (same shape as the outline loop). */
function outlineHalfWidth(y: number): number {
  const s = y >= 0 ? y / 1.06 : y / 0.98;
  if (Math.abs(s) >= 1) return 0;
  return 0.8 * Math.sqrt(1 - s * s) * (1 - 0.24 * Math.max(0, s) ** 2);
}

export function buildFace(seed = 478): Face {
  const points: FacePoint[] = [];
  const contours: number[][] = [];
  const add = (x: number, y: number, kind: PointKind, jaw = 0, closeY?: number): number => {
    points.push(closeY === undefined ? { x, y, kind, jaw } : { x, y, kind, jaw, closeY });
    return points.length - 1;
  };

  // Face outline: 36 points, a closed loop from the top of the forehead; the chin follows the jaw a little.
  const outline: number[] = [];
  for (let k = 0; k < 36; k++) {
    const th = -Math.PI / 2 + (k / 36) * Math.PI * 2;
    const s = Math.sin(th);
    const down = Math.max(0, s);
    outline.push(add(0.8 * Math.cos(th) * (1 - 0.24 * down * down), s >= 0 ? 1.06 * s : 0.98 * s, "outline", 0.5 * down ** 4));
  }
  contours.push([...outline, outline[0]]);

  // Brows: 10 points each, inner end to outer end.
  for (const side of [-1, 1]) {
    const brow: number[] = [];
    for (let k = 0; k < 10; k++) {
      const u = k / 9;
      brow.push(add(side * (0.1 + 0.48 * u), -0.4 - 0.07 * Math.sin(Math.PI * u ** 0.8) + 0.04 * u, "brow"));
    }
    contours.push(brow);
  }

  // Eyes: 16 lid points and 5 iris points each (MediaPipe also has 5 iris points per eye).
  const eye = (side: -1 | 1): EyeIndices => {
    const cx = side * 0.33;
    const lower = (t: number) => EYE_Y + LID_DOWN * (1 - t * t);
    const closed = (t: number) => EYE_Y + LID_DOWN * (1 - t * t) * 0.55;
    const ts = [-0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75];
    const c0 = add(cx - EYE_HALF_W, EYE_Y, "lid");
    const upper = ts.map((t) => add(cx + EYE_HALF_W * t, EYE_Y - LID_UP * (1 - t * t), "lid", 0, closed(t)));
    const c1 = add(cx + EYE_HALF_W, EYE_Y, "lid");
    const low = ts.map((t) => add(cx + EYE_HALF_W * t, lower(t), "lid"));
    const loop = [c0, ...upper, c1, ...[...low].reverse(), c0];
    contours.push(loop);
    const r = 0.042;
    const irisAt = (dx: number, dy: number) => {
      const t = dx / EYE_HALF_W;
      return add(cx + dx, EYE_Y - 0.01 + dy, "iris", 0, closed(t));
    };
    const iris = [irisAt(0, 0), irisAt(0, -r), irisAt(r, 0), irisAt(0, r), irisAt(-r, 0)];
    return { loop, ear: [c0, upper[1], upper[5], c1, low[5], low[1]], iris };
  };
  const eyeL = eye(-1);
  const eyeR = eye(1);

  // Nose: a bridge of 7 points and a base of 11 (wing, tip, wing).
  const bridge: number[] = [];
  for (let k = 0; k < 7; k++) bridge.push(add(0, -0.2 + (0.34 * k) / 6, "nose"));
  contours.push(bridge);
  const base: number[] = [add(-0.16, 0.13, "nose")];
  for (let k = 0; k < 9; k++) {
    const u = -1 + (2 * k) / 8;
    base.push(add(0.13 * u, 0.19 + 0.07 * (1 - u * u), "nose"));
  }
  base.push(add(0.16, 0.13, "nose"));
  contours.push(base);

  // Lips: outer upper 13 (corner to corner), outer lower 11, inner upper 9, inner lower 7.
  const outerUpper: number[] = [];
  for (let k = 0; k < 13; k++) {
    const u = -1 + (2 * k) / 12;
    const bow = 1 - 0.45 * Math.exp(-((u / 0.16) ** 2));
    outerUpper.push(add(0.25 * u, MOUTH_Y - 0.07 * (1 - u * u) * bow, "lip", 0.05));
  }
  const outerLower: number[] = [];
  for (let k = 0; k < 11; k++) {
    const u = 5 / 6 - (k * 10) / 66;
    outerLower.push(add(0.25 * u, MOUTH_Y + 0.09 * (1 - u * u), "lip", 0.6 * (1 - u * u) + 0.1));
  }
  const mouth = [...outerUpper, ...outerLower, outerUpper[0]];
  contours.push(mouth);
  const innerUpper: number[] = [];
  for (let k = 0; k < 9; k++) {
    const u = -1 + (2 * k) / 8;
    innerUpper.push(add(0.2 * u, MOUTH_Y - 0.012 * (1 - u * u), "lip", 0.05));
  }
  const innerLower: number[] = [];
  for (let k = 0; k < 7; k++) {
    const u = 0.75 - (k * 1.5) / 6;
    innerLower.push(add(0.2 * u, MOUTH_Y + 0.012 * (1 - u * u), "lip", 0.6 * (1 - u * u) + 0.1));
  }
  contours.push([...innerUpper, ...innerLower, innerUpper[0]]);

  // Fill: the remaining points spread over the face surface (random sequential addition with a minimum gap).
  const rand = seeded(seed);
  const features = points.length;
  let minGap = 0.058;
  let attempts = 0;
  while (points.length < FACE_POINTS) {
    if (++attempts > 6000) {
      minGap *= 0.94;
      attempts = 0;
    }
    const x = (rand() * 2 - 1) * 0.8;
    const y = -0.98 + rand() * 2.04;
    if (Math.abs(x) > 0.92 * outlineHalfWidth(y)) continue;
    const inEye = (cx: number) => ((x - cx) / 0.23) ** 2 + ((y - EYE_Y) / 0.13) ** 2 < 1;
    if (inEye(-0.33) || inEye(0.33)) continue;
    if (Math.abs(x) < 0.27 && Math.abs(y - MOUTH_Y) < 0.11) continue;
    let ok = true;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const gap = i < features ? 0.045 : minGap;
      if ((p.x - x) ** 2 + (p.y - y) ** 2 < gap * gap) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const below = Math.max(0, Math.min(1, (y - 0.58) / 0.3));
    add(x, y, "fill", 0.35 * below);
  }

  // Mesh: every point links to its three nearest neighbours that are close enough.
  const seen = new Set<number>();
  const mesh: [number, number][] = [];
  for (let i = 0; i < points.length; i++) {
    const near = points
      .map((p, j) => [j, (p.x - points[i].x) ** 2 + (p.y - points[i].y) ** 2] as const)
      .filter(([j, d]) => j !== i && d < 0.15 * 0.15)
      .sort((a, b) => a[1] - b[1])
      .slice(0, 3);
    for (const [j] of near) {
      const key = Math.min(i, j) * 1000 + Math.max(i, j);
      if (seen.has(key)) continue;
      seen.add(key);
      mesh.push([Math.min(i, j), Math.max(i, j)]);
    }
  }

  const neutral = posePoints(points, { blink: 0, jaw: 0 }, new Float32Array(points.length * 2));
  const openAspect = (rawAspect(neutral, eyeL.ear) + rawAspect(neutral, eyeR.ear)) / 2;
  return { points, contours, mesh, eyeL, eyeR, mouth, openAspect };
}

/** Writes the posed x, y of every point into `out` (x0, y0, x1, y1, ...) and returns it. */
export function posePoints(points: readonly FacePoint[], pose: Pose, out: Float32Array): Float32Array {
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    let y = p.y;
    if (p.closeY !== undefined) y += (p.closeY - p.y) * pose.blink;
    out[2 * i] = p.x;
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
/** One face for the whole page (the hero and the "Watch" step draw the same one). */
export function sharedFace(): Face {
  shared ??= buildFace();
  return shared;
}
