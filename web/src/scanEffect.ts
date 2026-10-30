import { LEFT_EYE, RIGHT_EYE } from "./signals.ts";

// The calibration scan (NOTES D-78, the user's "Tab UX Calibration" sheet): the plain camera → a scan line sweeps
// down in 1 s and turns the person into pixels → 0.5 s later, labelled boxes appear on the left eye, the right eye
// and the mouth with their live values, named as on the Debug page (EAR, Jaw Open). Canvas 2D on the camera's
// overlay canvas; the canvas is mirrored with the video, so text is flipped back.
// The person is a silhouette built from the face landmarks (head, neck, shoulders, torso), not the body
// segmentation grid: that grid is fine for the area and motion the rules use, but on the user's laptop (30 Oct) its
// cells landed beside the body, while the face landmarks always sit on the face.
// The timeline starts on the first frame with a face, so the sweep is never spent before there is a picture.

export const SCAN = {
  delayMs: 250, // the plain camera first
  sweepMs: 1000,
  settleMs: 600, // the blocks shrink from coarse to fine once the line has passed
  boxesAfterMs: 500,
  boxesInMs: 350,
  pixel: 14, // px of the camera image per block, once settled
  coarsePixel: 32,
  keepShapeMs: 1000, // a face lost for a moment keeps its silhouette
  waitForFaceMs: 30_000, // after this, only detector frames redraw while no face has been seen
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

export function bodyShape(landmarks: readonly Point[], width: number, height: number): BodyShape | null {
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
  const fw = maxX - minX;
  const fh = maxY - minY;
  if (!(fw > 0 && fh > 0)) return null;
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

export type ScanValues = { earLeft: number; earRight: number; jawOpen: number };

const PAPER = "#f6f5f1";
const INK = "#121518";

export class ScanEffect {
  private armedAt = 0;
  private startedAt = 0;
  private shape: BodyShape | null = null;
  private shapeAt = 0;
  private readonly small = document.createElement("canvas");

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
  }

  // Whether to redraw every display frame: during the opening, or while waiting for a face (bounded).
  animating(now: number): boolean {
    if (!this.running) return false;
    if (this.startedAt === 0) return now - this.armedAt < SCAN.waitForFaceMs;
    return now - this.startedAt < SCAN_TOTAL_MS;
  }

  // Draws one frame on a cleared canvas the size of the video.
  draw(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, landmarks: readonly Point[] | undefined, values: ScanValues | null, now: number) {
    if (!this.running) return;
    const { width: w, height: h } = ctx.canvas;
    const found = landmarks ? bodyShape(landmarks, w, h) : null;
    if (found) {
      this.shape = found;
      this.shapeAt = now;
    } else if (now - this.shapeAt > SCAN.keepShapeMs) this.shape = null;
    if (this.startedAt === 0) {
      if (!this.shape) return; // the plain camera until a face shows
      this.startedAt = now;
    }
    // Canvas px per CSS px: the canvas has the video's size and is scaled to cover its box.
    const scale = Math.max(ctx.canvas.clientWidth / w, ctx.canvas.clientHeight / h) || 1;
    const unit = 1 / scale;
    const { sweep, settle, boxes } = scanProgress(now - this.startedAt);
    const lineY = sweep * h;
    if (this.shape && sweep > 0) this.pixelate(ctx, video, this.shape, w, h, lineY, blockSize(settle), unit);
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
    ctx.save();
    ctx.shadowColor = PAPER;
    ctx.shadowBlur = 18;
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, lineY - 1.5 * unit, w, 3 * unit);
    ctx.restore();
    this.label(ctx, `SCANNING ${Math.round(sweep * 100)}%`, w - 70 * unit, lineY - 12 * unit, 1, false, unit);
  }

  // The person above the scan line, as blocks of the camera image with a thin grid between them.
  private pixelate(
    ctx: CanvasRenderingContext2D,
    video: HTMLVideoElement,
    shape: BodyShape,
    w: number,
    h: number,
    lineY: number,
    block: number,
    unit: number,
  ) {
    const sw = Math.max(1, Math.round(w / block));
    const sh = Math.max(1, Math.round(h / block));
    if (this.small.width !== sw || this.small.height !== sh) {
      this.small.width = sw;
      this.small.height = sh;
    }
    const sctx = this.small.getContext("2d");
    if (!sctx) return;
    sctx.drawImage(video, 0, 0, sw, sh);

    const bw = w / sw;
    const bh = h / sh;
    ctx.save();
    ctx.beginPath();
    let any = false;
    for (let r = 0; r < sh; r++) {
      const y = r * bh;
      if (y > lineY) break;
      for (let c = 0; c < sw; c++) {
        if (!inBody(shape, (c + 0.5) * bw, y + bh / 2)) continue;
        ctx.rect(c * bw, y, bw, Math.min(bh, lineY - y));
        any = true;
      }
    }
    if (!any) {
      ctx.restore();
      return;
    }
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.small, 0, 0, w, h);
    ctx.fillStyle = "rgb(18 21 24 / 0.18)";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "rgb(246 245 241 / 0.28)";
    ctx.lineWidth = unit;
    ctx.beginPath();
    for (let c = 0; c <= sw; c++) {
      ctx.moveTo(c * bw, 0);
      ctx.lineTo(c * bw, h);
    }
    for (let r = 0; r <= sh; r++) {
      ctx.moveTo(0, r * bh);
      ctx.lineTo(w, r * bh);
    }
    ctx.stroke();
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
      ctx.strokeStyle = INK;
      ctx.lineWidth = 3 * unit;
      ctx.strokeRect(bx, by, bw, bh);
      ctx.strokeStyle = PAPER;
      ctx.lineWidth = 1.5 * unit;
      ctx.strokeRect(bx, by, bw, bh);
      // Eye labels hang off the outer edge of their box so the two never overlap.
      let x = bx + bw / 2;
      if (outward) {
        const tab = this.tabWidth(ctx, text, unit);
        x = bx + bw / 2 < faceX ? bx + bw - tab / 2 : bx + tab / 2;
      }
      this.label(ctx, text, x, by - 6 * unit, t, true, unit);
    }
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
  private label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, alpha: number, tab: boolean, unit: number) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.scale(-1, 1);
    ctx.font = this.font(unit);
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    if (tab) {
      const width = ctx.measureText(text).width + 10 * unit;
      ctx.fillStyle = PAPER;
      ctx.fillRect(-width / 2, -14 * unit, width, 19 * unit);
      ctx.fillStyle = INK;
    } else {
      ctx.fillStyle = PAPER;
    }
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }
}
