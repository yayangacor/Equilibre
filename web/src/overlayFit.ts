// The overlay canvas at the screen's resolution (the user, 30 Oct: the scan's boxes, labels and crosses looked
// blurry when a canvas the video's size, 640×480, was stretched over a full-screen box). The canvas takes its CSS
// box times the device pixel ratio, and the context's transform puts video pixels where object-fit: cover puts the
// video, so drawing code keeps working in video pixels.

export const OVERLAY = {
  maxPixels: 6_000_000, // ⚠️ canvas pixels at most: 2560×1440 at 125% fits, a 4K screen at 200% draws a little softer
} as const;

// The canvas size in its own pixels, and the transform from video pixels to them: x' = scale·x + x.
export type OverlayFit = { width: number; height: number; scale: number; x: number; y: number };

export function overlayFit(videoW: number, videoH: number, boxW: number, boxH: number, dpr: number): OverlayFit {
  // A hidden canvas has no box: the video's own size, as before.
  if (boxW <= 0 || boxH <= 0) return { width: videoW, height: videoH, scale: 1, x: 0, y: 0 };
  const density = Math.min(dpr > 0 ? dpr : 1, Math.sqrt(OVERLAY.maxPixels / (boxW * boxH)));
  const width = Math.max(1, Math.round(boxW * density));
  const height = Math.max(1, Math.round(boxH * density));
  const scale = Math.max(width / videoW, height / videoH);
  return { width, height, scale, x: (width - videoW * scale) / 2, y: (height - videoH * scale) / 2 };
}
