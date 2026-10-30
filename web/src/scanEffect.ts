import type { BodyGrid } from "./body.ts";
import { LEFT_EYE, RIGHT_EYE } from "./signals.ts";

// The calibration scan (NOTES D-78, the user's "Tab UX Calibration" sheet): the plain camera → a scan line sweeps
// down in 1 s and turns the person into pixels → 0.5 s later, labelled boxes appear on the left eye, the right eye
// and the mouth with their live values, named as on the Debug page (EAR, Jaw Open). Canvas 2D on the camera's
// overlay canvas; the canvas is mirrored with the video, so text is flipped back. The canvas is at the screen's
// resolution and its context draws in video pixels (overlayFit.ts); the block grid, the boxes, the labels and the
// scan line are placed on whole device pixels so they stay sharp.
// The pixels follow the body segmentation mask (a finer grid of the same mask the rules use), kept only where it
// connects to the face, so a chair the model also marks stays clear. When no part of the mask touches the face (on
// the user's laptop, 30 Oct, the mask landed beside the body, G-95), a head-and-shoulders silhouette built from the
// face landmarks stands in.
// The timeline starts on the first frame with a face, so the sweep is never spent before there is a picture.
// While stage B's progress bar runs, glowing crosses (the user's reference: Codrops ScanEffect, effect 3) start as a
// point at the top of the pixelated person and spread down as a widening ring, again and again, drawn only on the
// blocks of the mask.

export const SCAN = {
  delayMs: 250, // the plain camera first
  sweepMs: 1000,
  settleMs: 600, // the blocks shrink from coarse to fine once the line has passed
  boxesAfterMs: 500,
  boxesInMs: 350,
  viewCols: 48, // columns of the display grid drawn from the body mask
  personAt: 0.5, // mask confidence that counts as the person
  pixel: 14, // px of the camera image per block in the silhouette fallback, once settled
  coarsePixel: 32,
  keepShapeMs: 1000, // a face lost for a moment keeps its silhouette
  waitForFaceMs: 30_000, // after this, only detector frames redraw while no face has been seen
  pulseMs: 3200, // ⚠️ one ring, from a point at the top of the person to the farthest block
  pulseRestMs: 300, // between rings
  ringEase: [0.4, 0, 0.2, 1] as const, // ⚠️ cubic-bezier: the point swells, spreads, then slows to a stop
  ringStart: 0.035, // the ring's half-thickness as a share of its reach: a point at first…
  ringEnd: 0.09, // …thickening as it spreads
  crossGap: 18, // ⚠️ CSS px between crosses at least: one per block, or per few blocks
  crossArm: 5, // CSS px from a cross's centre to the tip of an arm
} as const;

export const SCAN_TOTAL_MS =
  SCAN.delayMs + SCAN.sweepMs + Math.max(SCAN.settleMs, SCAN.boxesAfterMs + SCAN.boxesInMs) + 100;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

// How far the sweep, the settling blocks and the boxes are, 0–1, at `elapsed` ms after the first face.
export function scanProgress(elapsed: number): { sweep: number; settle: number; boxes: number } {
  const swept = elapsed - SCAN.delayMs - SCAN.sweepMs;
  return {
    sweep: clamp01((elapsed - SCAN.delayMs) / SCAN.sweepMs),
    settle: clamp01(swept / SCAN.settleMs),
    boxes: clamp01((swept - SCAN.boxesAfterMs) / SCAN.boxesInMs),
  };
}

// Block size in canvas px: coarse while the line passes, then settling to SCAN.pixel.
export function blockSize(settle: number): number {
  return Math.round(SCAN.coarsePixel + (SCAN.pixel - SCAN.coarsePixel) * easeOut(clamp01(settle)));
}

// Mask cells per block side: 3 while the line passes, then 2, then 1.
export function blockCells(settle: number): number {
  return settle < 1 / 3 ? 3 : settle < 2 / 3 ? 2 : 1;
}

export type Point = { x: number; y: number };
export type Box = { x: number; y: number; w: number; h: number };

// Outer lip corners, top and bottom: the mouth box.
export const MOUTH = [61, 291, 0, 17, 13, 14] as const;

// The box around some landmarks (normalised 0–1) in canvas pixels, padded by `pad` of its larger side.
export function boxOf(points: readonly Point[], indices: readonly number[], width: number, height: number, pad = 0.35): Box | null {
  const picked = indices.map((i) => points[i]).filter((p): p is Point => p !== undefined);
  if (picked.length === 0) return null;
  const xs = picked.map((p) => p.x * width);
  const ys = picked.map((p) => p.y * height);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const side = Math.max(maxX - minX, maxY - minY);
  const px = side * pad;
  return { x: minX - px, y: minY - px, w: maxX - minX + 2 * px, h: maxY - minY + 2 * px };
}

// A head-and-shoulders outline in canvas px, sized from the face: an ellipse for the head (with hair), then a neck,
// rounded shoulders and a torso widening to the bottom of the frame.
export type BodyShape = {
  cx: number;
  headY: number;
  rx: number;
  ry: number;
  neckTop: number;
  neckHalf: number;
  shoulderTop: number;
  shoulderY: number;
  shoulderHalf: number;
  bottomHalf: number;
  bottom: number;
};

// The box around all face landmarks in canvas px, or null without a face of some size.
export function faceBox(landmarks: readonly Point[], width: number, height: number): Box | null {
  if (landmarks.length === 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of landmarks) {
    minX = Math.min(minX, p.x * width);
    maxX = Math.max(maxX, p.x * width);
    minY = Math.min(minY, p.y * height);
    maxY = Math.max(maxY, p.y * height);
  }
  const w = maxX - minX;
  const h = maxY - minY;
  return w > 0 && h > 0 ? { x: minX, y: minY, w, h } : null;
}

export function bodyShape(landmarks: readonly Point[], width: number, height: number): BodyShape | null {
  const face = faceBox(landmarks, width, height);
  if (!face) return null;
  const { x: minX, y: minY, w: fw, h: fh } = face;
  const maxX = minX + fw;
  const maxY = minY + fh;
  const shoulderY = maxY + 0.45 * fh;
  return {
    cx: (minX + maxX) / 2,
    headY: minY + 0.42 * fh,
    rx: 0.62 * fw,
    ry: 0.72 * fh,
    neckTop: maxY - 0.05 * fh,
    neckHalf: 0.3 * fw,
    shoulderTop: shoulderY - 0.22 * fh,
    shoulderY,
    shoulderHalf: 1.25 * fw,
    bottomHalf: 1.6 * fw,
    bottom: Math.max(height, shoulderY + 1),
  };
}

export function inBody(s: BodyShape, x: number, y: number): boolean {
  const hx = (x - s.cx) / s.rx;
  const hy = (y - s.headY) / s.ry;
  if (hx * hx + hy * hy <= 1) return true;
  if (y < s.neckTop || y > s.bottom) return false;
  let half: number;
  if (y < s.shoulderTop) half = s.neckHalf;
  else if (y < s.shoulderY) {
    const t = (y - s.shoulderTop) / (s.shoulderY - s.shoulderTop);
    half = s.neckHalf + (s.shoulderHalf - s.neckHalf) * Math.sqrt(t); // a rounded shoulder
  } else {
    half = s.shoulderHalf + ((s.bottomHalf - s.shoulderHalf) * (y - s.shoulderY)) / Math.max(1, s.bottom - s.shoulderY);
  }
  return Math.abs(x - s.cx) <= half;
}

// The person in blocks of k×k mask cells: on where the block's mean confidence counts as the person, then only the
// blocks connected (4-neighbours) to one that overlaps the face. Null when no person block overlaps the face.
export type Blocks = { cols: number; rows: number; bw: number; bh: number; on: Uint8Array };

export function personBlocks(view: BodyGrid, k: number, face: Box, width: number, height: number): Blocks | null {
  const cols = Math.ceil(view.cols / k);
  const rows = Math.ceil(view.rows / k);
  const bw = (k * width) / view.cols;
  const bh = (k * height) / view.rows;
  const person = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0;
      let n = 0;
      for (let y = r * k; y < Math.min(view.rows, (r + 1) * k); y++) {
        for (let x = c * k; x < Math.min(view.cols, (c + 1) * k); x++) {
          sum += view.cells[y * view.cols + x];
          n++;
        }
      }
      if (n > 0 && sum / n >= SCAN.personAt) person[r * cols + c] = 1;
    }
  }
  const on = new Uint8Array(cols * rows);
  const queue: number[] = [];
  const c0 = Math.max(0, Math.floor(face.x / bw));
  const c1 = Math.min(cols - 1, Math.floor((face.x + face.w) / bw));
  const r0 = Math.max(0, Math.floor(face.y / bh));
  const r1 = Math.min(rows - 1, Math.floor((face.y + face.h) / bh));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const i = r * cols + c;
      if (person[i] && !on[i]) {
        on[i] = 1;
        queue.push(i);
      }
    }
  }
  if (queue.length === 0) return null;
  while (queue.length > 0) {
    const i = queue.pop()!;
    const r = Math.floor(i / cols);
    const c = i % cols;
    const next = [r > 0 ? i - cols : -1, r < rows - 1 ? i + cols : -1, c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1];
    for (const j of next) {
      if (j >= 0 && person[j] && !on[j]) {
        on[j] = 1;
        queue.push(j);
      }
    }
  }
  return { cols, rows, bw, bh, on };
}

// The silhouette fallback in the same blocks: on where a block's centre is inside the shape. The blocks tile the
// frame, `block` canvas px on a side or a little more.
export function silhouetteBlocks(shape: BodyShape, block: number, width: number, height: number): Blocks {
  const cols = Math.max(1, Math.round(width / block));
  const rows = Math.max(1, Math.round(height / block));
  const bw = width / cols;
  const bh = height / rows;
  const on = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (inBody(shape, (c + 0.5) * bw, (r + 0.5) * bh)) on[r * cols + c] = 1;
    }
  }
  return { cols, rows, bw, bh, on };
}

// A CSS-style cubic-bezier timing function: x(s) = t is solved for s (Newton, then bisection), y(s) returned.
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const xAt = (s: number) => ((ax * s + bx) * s + cx) * s;
  const yAt = (s: number) => ((ay * s + by) * s + cy) * s;
  const slopeAt = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let s = t;
    for (let i = 0; i < 8; i++) {
      const err = xAt(s) - t;
      if (Math.abs(err) < 1e-6) return yAt(s);
      const slope = slopeAt(s);
      if (Math.abs(slope) < 1e-6) break;
      s -= err / slope;
    }
    let lo = 0;
    let hi = 1;
    s = t;
    while (hi - lo > 1e-6) {
      if (xAt(s) < t) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return yAt(s);
  };
}

const ringEase = cubicBezier(...SCAN.ringEase);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

export type Ring = { radius: number; half: number; alpha: number };

// Stage B's ring `elapsed` ms after it started: a point (radius 0) that spreads to `reach` px on SCAN.ringEase,
// thickening as it goes, fading in at once and out while it slows (gone by 0.9 of the pulse, when it only crawls
// along the bottom corners); null in the rest between rings.
export function ringAt(elapsed: number, reach: number): Ring | null {
  const t = (elapsed % (SCAN.pulseMs + SCAN.pulseRestMs)) / SCAN.pulseMs;
  if (t >= 1) return null;
  const e = ringEase(t);
  return {
    radius: e * reach,
    half: reach * (SCAN.ringStart + (SCAN.ringEnd - SCAN.ringStart) * e),
    alpha: clamp01(t / 0.06) * (1 - smoothstep(0.55, 0.9, t)),
  };
}

// How lit a cross `d` px from the ring's line is: 1 on it, easing to 0 at `half` px away.
export function ringLight(d: number, half: number): number {
  const x = Math.abs(d) / half;
  return x < 1 ? 0.5 + 0.5 * Math.cos(Math.PI * x) : 0;
}

// How many of a cross's 4 arms show: all of them on the ring's line, fragments towards its edges, as in the
// reference. `seed` (0–1) is fixed per cross, so which crosses break up does not flicker between frames.
export function armsShown(light: number, seed: number): number {
  return Math.min(4, Math.floor(light * 4 + seed));
}

// A fixed number in 0–1 for a grid position.
export function seedOf(c: number, r: number): number {
  const x = Math.sin(c * 12.9898 + r * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

// The confidence-weighted centre of a grid, normalised 0–1 (Debug's mask readout); null for an empty grid.
export function gridCentre(view: BodyGrid): Point | null {
  let sum = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < view.cells.length; i++) {
    const v = view.cells[i];
    sum += v;
    sx += v * ((i % view.cols) + 0.5);
    sy += v * (Math.floor(i / view.cols) + 0.5);
  }
  return sum > 0 ? { x: sx / sum / view.cols, y: sy / sum / view.rows } : null;
}

export type ScanValues = { earLeft: number; earRight: number; jawOpen: number };

const PAPER = "#f6f5f1";
const INK = "#121518";
// A cross's arms in the order its fragments appear: two in a row give "-", "|" or a corner.
const ARMS = [
  [1, 0],
  [-1, 0],
  [0, -1],
  [0, 1],
] as const;

export class ScanEffect {
  private armedAt = 0;
  private startedAt = 0;
  private shape: BodyShape | null = null;
  private face: Box | null = null;
  private shapeAt = 0;
  private ringsFrom = 0; // when stage B's rings started; 0 while it is off
  private readonly small = document.createElement("canvas");
  // The context's transform for this frame, video px → device px (x' = s·x + x), and device px per CSS px.
  private device = { s: 1, x: 0, y: 0, css: 1 };
  // Whether the last frame drew the mask (true) or the silhouette fallback (false); for Debug.
  followsMask = false;

  get running(): boolean {
    return this.armedAt > 0;
  }

  // Waits for the first face, then plays the opening once.
  arm(now: number) {
    this.armedAt = now;
    this.startedAt = 0;
    this.shape = null;
  }

  stop() {
    this.armedAt = 0;
    this.startedAt = 0;
    this.shape = null;
    this.ringsFrom = 0;
  }

  // The rings of crosses run from `now` until stopRings() or stop(), once the opening's line has passed.
  startRings(now: number) {
    this.ringsFrom = now;
  }

  stopRings() {
    this.ringsFrom = 0;
  }

  // Whether to redraw every display frame: during the opening, while the rings run, or while waiting for a
  // face (bounded).
  animating(now: number): boolean {
    if (!this.running) return false;
    if (this.ringsFrom > 0) return true;
    if (this.startedAt === 0) return now - this.armedAt < SCAN.waitForFaceMs;
    return now - this.startedAt < SCAN_TOTAL_MS;
  }

  // Draws one frame on a cleared canvas whose context draws in video pixels. `view` is the finer grid of the latest
  // body mask.
  draw(
    ctx: CanvasRenderingContext2D,
    video: HTMLVideoElement,
    landmarks: readonly Point[] | undefined,
    values: ScanValues | null,
    view: BodyGrid | null,
    now: number,
  ) {
    if (!this.running) return;
    const { videoWidth: w, videoHeight: h } = video;
    if (!w || !h) return;
    const found = landmarks ? bodyShape(landmarks, w, h) : null;
    if (found && landmarks) {
      this.shape = found;
      this.face = faceBox(landmarks, w, h);
      this.shapeAt = now;
    } else if (now - this.shapeAt > SCAN.keepShapeMs) {
      this.shape = null;
      this.face = null;
    }
    if (this.startedAt === 0) {
      if (!this.shape) return; // the plain camera until a face shows
      this.startedAt = now;
    }
    // CSS px per video px: the video covers its box (object-fit: cover).
    const scale = Math.max(ctx.canvas.clientWidth / w, ctx.canvas.clientHeight / h) || 1;
    const unit = 1 / scale;
    const m = ctx.getTransform();
    this.device = { s: m.a, x: m.e, y: m.f, css: m.a * unit };
    const { sweep, settle, boxes } = scanProgress(now - this.startedAt);
    const lineY = sweep * h;
    if (this.shape && sweep > 0) {
      const masked = view && this.face ? personBlocks(view, blockCells(settle), this.face, w, h) : null;
      this.followsMask = masked !== null;
      const blocks = masked ?? silhouetteBlocks(this.shape, blockSize(settle), w, h);
      this.pixelateBlocks(ctx, video, blocks, w, h, lineY);
      if (this.ringsFrom > 0 && sweep >= 1) this.crossRing(ctx, blocks, now - this.ringsFrom, this.shape.cx, unit);
    }
    if (sweep > 0 && sweep < 1) this.sweepLine(ctx, w, lineY, sweep, unit);
    if (boxes > 0 && landmarks && values && this.shape) this.boxes(ctx, landmarks, values, this.shape.cx, w, h, easeOut(boxes), unit);
  }

  // The bright line with a soft band trailing above it, and its progress.
  private sweepLine(ctx: CanvasRenderingContext2D, w: number, lineY: number, sweep: number, unit: number) {
    const bandH = 140 * unit;
    const band = ctx.createLinearGradient(0, lineY - bandH, 0, lineY);
    band.addColorStop(0, "rgb(246 245 241 / 0)");
    band.addColorStop(1, "rgb(246 245 241 / 0.42)");
    ctx.fillStyle = band;
    ctx.fillRect(0, lineY - bandH, w, bandH);
    const { s, y: oy, css } = this.device;
    const thick = Math.max(2, Math.round(3 * css));
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.shadowColor = PAPER;
    ctx.shadowBlur = 18 * s; // device px, untouched by the transform: the glow of 18 video px it always had
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, Math.round(lineY * s + oy - thick / 2), ctx.canvas.width, thick);
    ctx.restore();
    this.label(ctx, `SCANNING ${Math.round(sweep * 100)}%`, w - 70 * unit, lineY - 12 * unit, 1, false);
  }

  // The person (mask or silhouette) above the scan line, as blocks of the camera image with a thin grid between them.
  // Drawn in device px: every block edge on a whole pixel, so neighbouring blocks meet without a soft seam.
  private pixelateBlocks(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, b: Blocks, w: number, h: number, lineY: number) {
    if (this.small.width !== b.cols || this.small.height !== b.rows) {
      this.small.width = b.cols;
      this.small.height = b.rows;
    }
    const sctx = this.small.getContext("2d");
    if (!sctx) return;
    // The last block may run past the frame's edge: sample the frame at the blocks' own scale.
    sctx.drawImage(video, 0, 0, w / b.bw, h / b.bh);
    const { s, x: ox, y: oy } = this.device;
    const colX = (c: number) => Math.round(c * b.bw * s + ox);
    const rowY = (r: number) => Math.round(r * b.bh * s + oy);
    const lineAt = Math.round(lineY * s + oy);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    let any = false;
    for (let r = 0; r < b.rows; r++) {
      const y0 = rowY(r);
      const y1 = Math.min(rowY(r + 1), lineAt);
      if (y1 <= y0) break;
      for (let c = 0; c < b.cols; c++) {
        if (!b.on[r * b.cols + c]) continue;
        ctx.rect(colX(c), y0, colX(c + 1) - colX(c), y1 - y0);
        any = true;
      }
    }
    if (!any) {
      ctx.restore();
      return;
    }
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.small, ox, oy, b.cols * b.bw * s, b.rows * b.bh * s);
    this.blockGrid(ctx, b, colX, rowY);
    ctx.restore();
  }

  // In device px: a light tint, then 1-CSS-px lines on the block edges, filled as one path so crossings are not
  // doubled.
  private blockGrid(ctx: CanvasRenderingContext2D, b: Blocks, colX: (c: number) => number, rowY: (r: number) => number) {
    const { width, height } = ctx.canvas;
    ctx.fillStyle = "rgb(18 21 24 / 0.18)";
    ctx.fillRect(0, 0, width, height);
    const line = Math.max(1, Math.round(this.device.css));
    const back = Math.floor(line / 2);
    ctx.fillStyle = "rgb(246 245 241 / 0.28)";
    ctx.beginPath();
    for (let c = 0; c <= b.cols; c++) ctx.rect(colX(c) - back, 0, line, height);
    for (let r = 0; r <= b.rows; r++) ctx.rect(0, rowY(r) - back, width, line);
    ctx.fill();
  }

  // Stage B's ring: a cross on the centre of the person's blocks (every block, or every few so they stay
  // SCAN.crossGap CSS px apart), lit near a circle centred at the top of the person (above the face, `originX`) and
  // broken into fragments towards the ring's edges. Each cross is a faint wide stroke for the glow, a dark rim so it
  // reads on light skin, then a thin bright core; crosses share 4 brightness levels, stroked once each.
  private crossRing(ctx: CanvasRenderingContext2D, b: Blocks, elapsed: number, originX: number, unit: number) {
    let top = -1;
    for (let i = 0; i < b.on.length && top < 0; i++) if (b.on[i]) top = Math.floor(i / b.cols);
    if (top < 0) return;
    const oy = top * b.bh;
    const dist = (c: number, r: number) => Math.hypot((c + 0.5) * b.bw - originX, (r + 0.5) * b.bh - oy);
    let reach = 0;
    for (let i = 0; i < b.on.length; i++) if (b.on[i]) reach = Math.max(reach, dist(i % b.cols, Math.floor(i / b.cols)));
    const ring = ringAt(elapsed, reach);
    if (!ring || ring.alpha === 0) return;
    const step = Math.max(1, Math.round((SCAN.crossGap * unit) / b.bw));
    const arm = SCAN.crossArm * unit;
    const levels = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
    let any = false;
    for (let r = top - (top % step); r < b.rows; r += step) {
      for (let c = 0; c < b.cols; c += step) {
        if (!b.on[r * b.cols + c]) continue;
        const light = ringLight(dist(c, r) - ring.radius, ring.half);
        if (light === 0) continue;
        const seed = seedOf(c, r);
        const arms = armsShown(light, seed);
        const path = levels[Math.min(3, Math.floor(light * 4))];
        const x = (c + 0.5) * b.bw;
        const y = (r + 0.5) * b.bh;
        const first = Math.floor(seed * 4);
        for (let i = 0; i < arms; i++) {
          const [dx, dy] = ARMS[(first + i) % 4];
          path.moveTo(x, y);
          path.lineTo(x + dx * arm, y + dy * arm);
          any = true;
        }
      }
    }
    if (!any) return;
    ctx.save();
    ctx.lineCap = "round";
    levels.forEach((path, i) => {
      const alpha = (ring.alpha * (i + 1)) / 4;
      ctx.strokeStyle = PAPER;
      ctx.globalAlpha = 0.18 * alpha;
      ctx.lineWidth = 7 * unit;
      ctx.stroke(path);
      ctx.strokeStyle = INK;
      ctx.globalAlpha = 0.35 * alpha;
      ctx.lineWidth = 3.5 * unit;
      ctx.stroke(path);
      ctx.strokeStyle = PAPER;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 1.6 * unit;
      ctx.stroke(path);
    });
    ctx.restore();
  }

  private boxes(
    ctx: CanvasRenderingContext2D,
    landmarks: readonly Point[],
    values: ScanValues,
    faceX: number,
    w: number,
    h: number,
    t: number,
    unit: number,
  ) {
    const parts: [Box | null, string, boolean][] = [
      [boxOf(landmarks, LEFT_EYE, w, h), `EAR L ${values.earLeft.toFixed(2)}`, true],
      [boxOf(landmarks, RIGHT_EYE, w, h), `EAR R ${values.earRight.toFixed(2)}`, true],
      [boxOf(landmarks, MOUTH, w, h, 0.2), `JAW OPEN ${values.jawOpen.toFixed(2)}`, false],
    ];
    const centers = parts.flatMap(([b]) => (b ? [{ x: b.x + b.w / 2, y: b.y + b.h / 2 }] : []));
    ctx.save();
    ctx.globalAlpha = t;
    // Thin links between the tracked parts, as in the reference.
    ctx.strokeStyle = "rgb(246 245 241 / 0.55)";
    ctx.lineWidth = unit;
    ctx.beginPath();
    centers.forEach((c, i) => (i === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y)));
    ctx.stroke();
    for (const [box, text, outward] of parts) {
      if (!box) continue;
      const scale = 0.7 + 0.3 * t;
      const bw = box.w * scale;
      const bh = box.h * scale;
      const bx = box.x + (box.w - bw) / 2;
      const by = box.y + (box.h - bh) / 2;
      // A paper line ±1.5 CSS px on a dark rim each side; both widths of one parity, so the paper sits centred.
      const paper = Math.max(1, Math.round(1.5 * this.device.css));
      const rim = Math.max(1, Math.round(0.75 * this.device.css));
      this.crispRect(ctx, bx, by, bw, bh, paper + 2 * rim, INK);
      this.crispRect(ctx, bx, by, bw, bh, paper, PAPER);
      // Eye labels hang off the outer edge of their box so the two never overlap.
      let x = bx + bw / 2;
      if (outward) {
        const tab = this.tabWidth(ctx, text, unit);
        x = bx + bw / 2 < faceX ? bx + bw - tab / 2 : bx + tab / 2;
      }
      this.label(ctx, text, x, by - 6 * unit, t, true);
    }
    ctx.restore();
  }

  // A rectangle outline `line` device px wide with its edges on whole device pixels.
  private crispRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, line: number, color: string) {
    const { s, x: ox, y: oy } = this.device;
    const x0 = Math.round(x * s + ox);
    const y0 = Math.round(y * s + oy);
    const half = (line % 2) / 2; // an odd width is centred on a pixel, an even one between two
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = color;
    ctx.lineWidth = line;
    ctx.strokeRect(x0 + half, y0 + half, Math.round((x + w) * s + ox) - x0, Math.round((y + h) * s + oy) - y0);
    ctx.restore();
  }

  private font(unit: number) {
    return `500 ${(12 * unit).toFixed(2)}px "IBM Plex Mono", ui-monospace, monospace`;
  }

  private tabWidth(ctx: CanvasRenderingContext2D, text: string, unit: number): number {
    ctx.save();
    ctx.font = this.font(unit);
    const width = ctx.measureText(text).width + 10 * unit;
    ctx.restore();
    return width;
  }

  // A mono label on a paper tab, centred on x with its baseline at y; the canvas is mirrored, so flip it back.
  // Set in device px from a whole pixel, so the tab's edges and the glyphs stay sharp.
  private label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, alpha: number, tab: boolean) {
    const { s, x: ox, y: oy, css } = this.device;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.setTransform(-1, 0, 0, 1, Math.round(x * s + ox), Math.round(y * s + oy));
    ctx.font = this.font(css);
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    if (tab) {
      const width = 2 * Math.round((ctx.measureText(text).width + 10 * css) / 2);
      ctx.fillStyle = PAPER;
      ctx.fillRect(-width / 2, -Math.round(14 * css), width, Math.round(19 * css));
      ctx.fillStyle = INK;
    } else {
      ctx.fillStyle = PAPER;
    }
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }
}
