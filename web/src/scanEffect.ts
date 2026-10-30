import type { BodyGrid } from "./body.ts";
import { LEFT_EYE, RIGHT_EYE } from "./signals.ts";

// The calibration scan (NOTES D-78, the user's "Tab UX Calibration" sheet): the plain camera → a scan line sweeps
// down in 1 s and turns the person (the segmentation grid the body features use) into pixels → 0.5 s later,
// labelled boxes appear on the left eye, the right eye and the mouth with their live values, named as on the Debug
// page (EAR, Jaw Open). Canvas 2D on the camera's overlay canvas, drawn only on frames the detector produced
// (±10/s), so it costs the detector almost nothing. The canvas is mirrored with the video, so text is flipped back.

export const SCAN = {
  delayMs: 250, // the plain camera first
  sweepMs: 1000,
  boxesAfterMs: 500,
  boxesInMs: 350,
  pixel: 14, // px of the camera image per pixel block
  personAt: 0.5, // grid confidence that counts as the person
} as const;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

// How far the sweep and the boxes are, 0–1, at `elapsed` ms after the scan started.
export function scanProgress(elapsed: number): { sweep: number; boxes: number } {
  const sweep = clamp01((elapsed - SCAN.delayMs) / SCAN.sweepMs);
  const boxes = clamp01((elapsed - SCAN.delayMs - SCAN.sweepMs - SCAN.boxesAfterMs) / SCAN.boxesInMs);
  return { sweep, boxes };
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

export type ScanValues = { earLeft: number; earRight: number; jawOpen: number };

const PAPER = "#f6f5f1";
const INK = "#121518";
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

export class ScanEffect {
  private startedAt = 0;
  private readonly small = document.createElement("canvas");

  get running(): boolean {
    return this.startedAt > 0;
  }

  start(now: number) {
    this.startedAt = now;
  }

  stop() {
    this.startedAt = 0;
  }

  // Draws one frame on a cleared canvas the size of the video.
  draw(
    ctx: CanvasRenderingContext2D,
    video: HTMLVideoElement,
    grid: BodyGrid | null,
    landmarks: readonly Point[] | undefined,
    values: ScanValues | null,
    now: number,
  ) {
    const { width: w, height: h } = ctx.canvas;
    const { sweep, boxes } = scanProgress(now - this.startedAt);
    const lineY = sweep * h;
    if (grid && sweep > 0) this.pixelate(ctx, video, grid, w, h, lineY);
    if (sweep > 0 && sweep < 1) {
      const band = ctx.createLinearGradient(0, lineY - 60, 0, lineY);
      band.addColorStop(0, "rgb(246 245 241 / 0)");
      band.addColorStop(1, "rgb(246 245 241 / 0.32)");
      ctx.fillStyle = band;
      ctx.fillRect(0, lineY - 60, w, 60);
      ctx.fillStyle = PAPER;
      ctx.fillRect(0, lineY - 1, w, 2);
      this.label(ctx, `SCANNING ${Math.round(sweep * 100)}%`, w - 70, lineY - 10, 0.9, false);
    }
    if (boxes > 0 && landmarks && values) this.boxes(ctx, landmarks, values, w, h, easeOut(boxes));
  }

  // The person above the scan line, as pixel blocks of the camera image with a thin grid.
  private pixelate(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, grid: BodyGrid, w: number, h: number, lineY: number) {
    const sw = Math.max(1, Math.round(w / SCAN.pixel));
    const sh = Math.max(1, Math.round(h / SCAN.pixel));
    if (this.small.width !== sw || this.small.height !== sh) {
      this.small.width = sw;
      this.small.height = sh;
    }
    const sctx = this.small.getContext("2d");
    if (!sctx) return;
    sctx.drawImage(video, 0, 0, sw, sh);

    const cw = w / grid.cols;
    const ch = h / grid.rows;
    ctx.save();
    ctx.beginPath();
    let any = false;
    for (let i = 0; i < grid.cells.length; i++) {
      if (grid.cells[i] < SCAN.personAt) continue;
      const y = Math.floor(i / grid.cols) * ch;
      if (y > lineY) continue;
      ctx.rect((i % grid.cols) * cw, y, cw, Math.min(ch, lineY - y));
      any = true;
    }
    if (!any) {
      ctx.restore();
      return;
    }
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.small, 0, 0, w, h);
    ctx.fillStyle = "rgb(18 21 24 / 0.22)";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "rgb(246 245 241 / 0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= w; x += SCAN.pixel) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
    }
    for (let y = 0; y <= h; y += SCAN.pixel) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(w, y + 0.5);
    }
    ctx.stroke();
    ctx.restore();
  }

  private boxes(ctx: CanvasRenderingContext2D, landmarks: readonly Point[], values: ScanValues, w: number, h: number, t: number) {
    const parts: [Box | null, string][] = [
      [boxOf(landmarks, LEFT_EYE, w, h), `EAR L ${values.earLeft.toFixed(2)}`],
      [boxOf(landmarks, RIGHT_EYE, w, h), `EAR R ${values.earRight.toFixed(2)}`],
      [boxOf(landmarks, MOUTH, w, h, 0.2), `JAW OPEN ${values.jawOpen.toFixed(2)}`],
    ];
    const centers = parts.flatMap(([b]) => (b ? [{ x: b.x + b.w / 2, y: b.y + b.h / 2 }] : []));
    ctx.save();
    ctx.globalAlpha = t;
    // Thin links between the tracked parts, as in the reference.
    ctx.strokeStyle = "rgb(246 245 241 / 0.55)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    centers.forEach((c, i) => (i === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y)));
    ctx.stroke();
    for (const [box, text] of parts) {
      if (!box) continue;
      const scale = 0.7 + 0.3 * t;
      const bw = box.w * scale;
      const bh = box.h * scale;
      const bx = box.x + (box.w - bw) / 2;
      const by = box.y + (box.h - bh) / 2;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 3;
      ctx.strokeRect(bx, by, bw, bh);
      ctx.strokeStyle = PAPER;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(bx, by, bw, bh);
      this.label(ctx, text, bx + bw / 2, by - 6, t, true);
    }
    ctx.restore();
  }

  // A mono label on a paper tab, centred on x with its baseline at y; the canvas is mirrored, so flip it back.
  private label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, alpha: number, tab: boolean) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.scale(-1, 1);
    ctx.font = '500 11px "IBM Plex Mono", ui-monospace, monospace';
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    if (tab) {
      const width = ctx.measureText(text).width + 10;
      ctx.fillStyle = PAPER;
      ctx.fillRect(-width / 2, -13, width, 17);
      ctx.fillStyle = INK;
    } else {
      ctx.fillStyle = PAPER;
    }
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }
}
