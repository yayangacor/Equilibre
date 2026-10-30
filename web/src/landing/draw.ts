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

export interface FaceStyle {
  ink: string;
  /** 0..1 multiplier for the whole face. */
  alpha?: number;
  /** Per-point alpha (0..1), e.g. for an intro; undefined = all visible. */
  pointAlpha?: (i: number) => number;
  mesh?: number;
  contour?: number;
  dot?: number;
}

/** Draws mesh links, feature contours and points from projected pixel positions. */
export function drawFace(ctx: CanvasRenderingContext2D, face: Face, px: Float32Array, style: FaceStyle): void {
  const alpha = style.alpha ?? 1;
  if (alpha <= 0) return;
  const dot = style.dot ?? 1.25;
  ctx.save();
  ctx.strokeStyle = style.ink;
  ctx.fillStyle = style.ink;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const mesh = (style.mesh ?? 0.09) * alpha;
  if (mesh > 0) {
    ctx.globalAlpha = mesh;
    ctx.lineWidth = 0.75;
    ctx.beginPath();
    for (const [a, b] of face.mesh) {
      ctx.moveTo(px[2 * a], px[2 * a + 1]);
      ctx.lineTo(px[2 * b], px[2 * b + 1]);
    }
    ctx.stroke();
  }

  const contour = (style.contour ?? 0.38) * alpha;
  if (contour > 0) {
    ctx.globalAlpha = contour;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const line of face.contours) {
      line.forEach((i, k) => (k === 0 ? ctx.moveTo(px[2 * i], px[2 * i + 1]) : ctx.lineTo(px[2 * i], px[2 * i + 1])));
    }
    ctx.stroke();
  }

  for (let i = 0; i < face.points.length; i++) {
    const kind = face.points[i].kind;
    const a = alpha * (style.pointAlpha ? style.pointAlpha(i) : 1) * (kind === "fill" ? 0.5 : 0.95);
    if (a <= 0.01) continue;
    ctx.globalAlpha = a;
    ctx.beginPath();
    ctx.arc(px[2 * i], px[2 * i + 1], kind === "fill" ? dot * 0.85 : dot, 0, Math.PI * 2);
    ctx.fill();
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
