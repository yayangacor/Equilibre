// Canvas helpers shared by the landing visuals: sizing for the device pixel ratio, theme colours, and the face mesh.
import type { Face } from "./faceModel.ts";

export interface Fitted {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
}

/** Sizes the canvas backing store to its CSS box (capped at 2x) and returns a context drawing in CSS pixels. */
export function fitCanvas(canvas: HTMLCanvasElement): Fitted | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

export function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export interface Palette {
  ink: string;
  ink3: string;
  rule: string;
  normal: string;
  normalTint: string;
  paper: string;
}

export function palette(): Palette {
  return {
    ink: cssVar("--ink", "#121518"),
    ink3: cssVar("--ink-3", "#6b7178"),
    rule: cssVar("--rule", "#d8d6ce"),
    normal: cssVar("--s-normal", "#1f9d8a"),
    normalTint: cssVar("--s-normal-tint", "#dcefe9"),
    paper: cssVar("--paper-raised", "#faf9f6"),
  };
}

/** Where the normalized face sits on a canvas: centre and scale in CSS pixels, plus a small tilt. */
export interface View {
  cx: number;
  cy: number;
  s: number;
  rot?: number;
}

/** Maps normalized posed points to canvas pixels. */
export function project(pos: Float32Array, view: View, out: Float32Array): Float32Array {
  const rot = view.rot ?? 0;
  const c = Math.cos(rot);
  const sn = Math.sin(rot);
  for (let i = 0; i < pos.length; i += 2) {
    const x = pos[i] * view.s;
    const y = pos[i + 1] * view.s;
    out[i] = view.cx + x * c - y * sn;
    out[i + 1] = view.cy + x * sn + y * c;
  }
  return out;
}

/** Default weights of the wireframe: faint surface lines, firmer feature contours, and a point on every vertex. */
export const MESH_ALPHA = 0.3;
export const CONTOUR_ALPHA = 0.62;
export const DOT_ALPHA = 1;

export interface FaceStyle {
  ink: string;
  /** 0..1 multiplier for the whole face. */
  alpha?: number;
  /** Per-point reveal (0..1), e.g. for an intro; a line shows as much as its less revealed end. Undefined = all. */
  reveal?: (i: number) => number;
  /** Line alpha of the surface wireframe and of the feature contours. */
  mesh?: number;
  contour?: number;
  /** Alpha of the vertex points (0 = lines only) and their radius. */
  dots?: number;
  dot?: number;
}

const SEGMENTS = new WeakMap<Face, readonly (readonly [number, number])[]>();
/** The contours as single segments, so each can fade in with its own ends. */
function contourSegments(face: Face): readonly (readonly [number, number])[] {
  let segs = SEGMENTS.get(face);
  if (!segs) {
    segs = face.contours.flatMap((line) => line.slice(1).map((b, k) => [line[k], b] as const));
    SEGMENTS.set(face, segs);
  }
  return segs;
}

const LEVELS = 8;

/** Strokes segments at `alpha`; with a reveal, in a few alpha steps (one path per step). */
function strokeSegments(
  ctx: CanvasRenderingContext2D,
  segs: readonly (readonly [number, number])[],
  px: Float32Array,
  alpha: number,
  reveal?: (i: number) => number,
): void {
  if (alpha <= 0) return;
  const steps: (readonly [number, number])[][] = Array.from({ length: reveal ? LEVELS : 1 }, () => []);
  for (const seg of segs) {
    if (!reveal) {
      steps[0].push(seg);
      continue;
    }
    const r = Math.min(reveal(seg[0]), reveal(seg[1]));
    if (r > 0.01) steps[Math.min(LEVELS, Math.ceil(r * LEVELS)) - 1].push(seg);
  }
  steps.forEach((step, k) => {
    if (!step.length) return;
    ctx.globalAlpha = alpha * (reveal ? (k + 1) / LEVELS : 1);
    ctx.beginPath();
    for (const [a, b] of step) {
      ctx.moveTo(px[2 * a], px[2 * a + 1]);
      ctx.lineTo(px[2 * b], px[2 * b + 1]);
    }
    ctx.stroke();
  });
}

/** Draws the face as a wireframe: surface lines, feature contours, irises and a point on every vertex. */
export function drawFace(ctx: CanvasRenderingContext2D, face: Face, px: Float32Array, style: FaceStyle): void {
  const alpha = style.alpha ?? 1;
  if (alpha <= 0) return;
  const dot = style.dot ?? 1.2;
  const reveal = style.reveal;
  ctx.save();
  ctx.strokeStyle = style.ink;
  ctx.fillStyle = style.ink;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  ctx.lineWidth = Math.max(0.5, dot * 0.55);
  strokeSegments(ctx, face.mesh, px, (style.mesh ?? MESH_ALPHA) * alpha, reveal);
  ctx.lineWidth = Math.max(0.75, dot * 0.8);
  const contour = (style.contour ?? CONTOUR_ALPHA) * alpha;
  strokeSegments(ctx, contourSegments(face), px, contour, reveal);

  // Irises: an ellipse through the four ring points, so it flattens as the lids close over it.
  for (const eye of [face.eyeL, face.eyeR]) {
    const [c, top, right, bottom, left] = eye.iris;
    const a = contour * (reveal ? Math.min(...eye.iris.map(reveal)) : 1);
    if (a <= 0.01) continue;
    const rx = Math.hypot(px[2 * right] - px[2 * left], px[2 * right + 1] - px[2 * left + 1]) / 2;
    const ry = Math.hypot(px[2 * bottom] - px[2 * top], px[2 * bottom + 1] - px[2 * top + 1]) / 2;
    ctx.globalAlpha = a;
    ctx.beginPath();
    ctx.ellipse(px[2 * c], px[2 * c + 1], rx, Math.max(0.1, ry), Math.atan2(px[2 * right + 1] - px[2 * left + 1], px[2 * right] - px[2 * left]), 0, Math.PI * 2);
    ctx.stroke();
  }

  const dots = (style.dots ?? DOT_ALPHA) * alpha;
  if (dots > 0) {
    for (let i = 0; i < face.points.length; i++) {
      const fill = face.points[i].kind === "fill";
      const a = dots * (reveal ? reveal(i) : 1) * (fill ? 0.5 : 0.9);
      if (a <= 0.01) continue;
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.arc(px[2 * i], px[2 * i + 1], fill ? dot * 0.75 : dot, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smooth = (a: number, b: number, v: number): number => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Number formatting for readouts: fixed decimals and a true minus sign. */
export function formatReading(value: number, decimals: number, suffix = ""): string {
  const text = Math.abs(value).toFixed(decimals);
  const negative = value < 0 && Number(text) !== 0;
  return `${negative ? "−" : ""}${text}${suffix}`;
}
