import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import { median } from "./calibration.ts";
import { LEFT_EYE, RIGHT_EYE } from "./signals.ts";

// Light on the face (plan P20 W1.5, ported from branch final-h6-h7, P17 H17; W1.6c glare on the lenses): how
// bright the face is, how much of it is overexposed, how dark the eye areas are against it, and how much of
// each eye area is blown out. Measured on the device about once a second (main.ts reads a few pixels of the
// video, nothing is kept). Without a face it reads the middle of the frame, so a dark room is not taken for
// leaving the desk. quality.ts turns a window of samples into "too dark" or "glare" instead of a guess.

export type LightSample = {
  t: number; // ms, same clock as FrameSignal.t
  face: boolean; // false: the middle of the frame was read, no face was found
  luma: number; // mean brightness, 0–255 (Rec. 601)
  clipped: number; // share of those pixels at LIGHT.overexposed or brighter
  eyes: number; // mean brightness of the two eye areas ÷ luma; NaN without a face or when luma is 0
  eyeGlare: number; // the larger share of blown-out pixels of the two eye areas; NaN without a face
};

// ⚠️ Initial values, not yet tuned on a camera (plan P20 W1.9, R-11).
export const LIGHT = {
  intervalMs: 1000, // light changes slowly; once a second is plenty
  darkLuma: 40, // the face (or the frame) counts as too dark below this mean brightness
  overexposed: 250, // a pixel this bright has lost its detail
  glareShare: 0.25, // the face counts as overexposed from this share of such pixels
  coveredEyes: 0.35, // eye areas this dark against the face: dark glasses or something else in front of them
  // Research report §2.7: up to 2% saturated pixels in the eye crop is fine, from 8% the lid is not readable.
  eyeGlare: 0.08,
  minShare: 0.5, // a window has the problem when this share of its samples has it,
  minSamples: 5, // and it has at least this many samples
} as const;

export type Box = { x: number; y: number; w: number; h: number }; // pixels of the video frame

// The middle of the face box (inside the face oval: no background at the corners, eyes, nose and mouth
// included) and one box around each eye, wider and taller than the lid opening so a lens covers it.
export function faceBoxes(
  landmarks: readonly NormalizedLandmark[],
  width: number,
  height: number,
): { face: Box; eyes: [Box, Box] } | null {
  if (landmarks.length === 0 || width <= 0 || height <= 0) return null;
  const xs = landmarks.map((p) => p.x * width);
  const ys = landmarks.map((p) => p.y * height);
  const [left, right, top, bottom] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const face = clip(
    { x: left + 0.25 * (right - left), y: top + 0.2 * (bottom - top), w: 0.5 * (right - left), h: 0.65 * (bottom - top) },
    width,
    height,
  );
  const eye = (indices: readonly number[]): Box | null => {
    const ex = indices.map((i) => landmarks[i].x * width);
    const ey = indices.map((i) => landmarks[i].y * height);
    const span = Math.max(...ex) - Math.min(...ex);
    const cx = (Math.max(...ex) + Math.min(...ex)) / 2;
    const cy = (Math.max(...ey) + Math.min(...ey)) / 2;
    return clip({ x: cx - 0.6 * span, y: cy - 0.3 * span, w: 1.2 * span, h: 0.6 * span }, width, height);
  };
  const eyes = [eye(RIGHT_EYE), eye(LEFT_EYE)];
  if (!face || !eyes[0] || !eyes[1]) return null;
  return { face, eyes: [eyes[0], eyes[1]] };
}

// The middle half of the frame, read when no face is found.
export const frameMiddle = (width: number, height: number): Box | null =>
  clip({ x: width / 4, y: height / 4, w: width / 2, h: height / 2 }, width, height);

// Inside the frame, at least 2 × 2 pixels; null when nothing of it is left.
function clip(b: Box, width: number, height: number): Box | null {
  const x = Math.max(0, b.x);
  const y = Math.max(0, b.y);
  const w = Math.min(width, b.x + b.w) - x;
  const h = Math.min(height, b.y + b.h) - y;
  return w >= 2 && h >= 2 ? { x, y, w, h } : null;
}

// Mean brightness and the overexposed share of RGBA pixels (CanvasRenderingContext2D.getImageData).
export function brightness(rgba: ArrayLike<number>): { luma: number; clipped: number } {
  const n = Math.floor(rgba.length / 4);
  if (n === 0) return { luma: NaN, clipped: NaN };
  let sum = 0;
  let over = 0;
  for (let i = 0; i < n; i++) {
    const y = 0.299 * rgba[4 * i] + 0.587 * rgba[4 * i + 1] + 0.114 * rgba[4 * i + 2];
    sum += y;
    if (y >= LIGHT.overexposed) over++;
  }
  return { luma: sum / n, clipped: over / n };
}

export function toLightSample(
  t: number,
  area: { luma: number; clipped: number },
  eyeAreas: readonly { luma: number; clipped: number }[] | null,
): LightSample {
  if (!eyeAreas || eyeAreas.length === 0) return { t, face: false, ...area, eyes: NaN, eyeGlare: NaN };
  const eyes = eyeAreas.reduce((a, b) => a + b.luma, 0) / eyeAreas.length;
  return {
    t,
    face: true,
    ...area,
    eyes: area.luma > 0 ? eyes / area.luma : NaN,
    eyeGlare: Math.max(...eyeAreas.map((e) => e.clipped)),
  };
}

// The samples with t in (now − windowMs, now]: how many, the share with each problem, and medians for the notes.
// Glare and covered eyes are judged on face samples only.
export type LightWindow = {
  n: number;
  dark: number;
  glare: number;
  covered: number;
  eyeGlare: number;
  luma: number | null;
  clipped: number | null;
  eyes: number | null;
};

export function lightWindow(samples: readonly LightSample[], now: number, windowMs: number): LightWindow {
  const inWindow = samples.filter((s) => s.t > now - windowMs && s.t <= now && Number.isFinite(s.luma));
  const faces = inWindow.filter((s) => s.face);
  const n = inWindow.length;
  const share = (of: readonly LightSample[], has: (s: LightSample) => boolean) =>
    of.length > 0 ? of.filter(has).length / of.length : 0;
  const eyes = faces.map((s) => s.eyes).filter(Number.isFinite);
  return {
    n,
    dark: share(inWindow, (s) => s.luma < LIGHT.darkLuma),
    glare: share(faces, (s) => s.clipped >= LIGHT.glareShare),
    covered: share(faces, (s) => s.eyes < LIGHT.coveredEyes),
    eyeGlare: share(faces, (s) => s.eyeGlare >= LIGHT.eyeGlare),
    luma: n > 0 ? median(inWindow.map((s) => s.luma)) : null,
    clipped: faces.length > 0 ? median(faces.map((s) => s.clipped)) : null,
    eyes: eyes.length > 0 ? median(eyes) : null,
  };
}
