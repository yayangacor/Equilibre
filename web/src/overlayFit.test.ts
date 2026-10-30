import { describe, expect, it } from "vitest";
import { OVERLAY, overlayFit } from "./overlayFit.ts";

describe("overlayFit", () => {
  it("draws a full-screen box at the screen's resolution, not the video's", () => {
    // 640×480 camera on a 1536×864 CSS box at 125%: 1920×1080 canvas pixels, 3 per video pixel.
    const fit = overlayFit(640, 480, 1536, 864, 1.25);
    expect(fit).toMatchObject({ width: 1920, height: 1080, scale: 3, x: 0, y: -180 });
  });

  it("places the video as object-fit: cover does: centred, covering the canvas, cropping the long side", () => {
    const fit = overlayFit(640, 480, 1536, 864, 1.25);
    expect(320 * fit.scale + fit.x).toBe(fit.width / 2);
    expect(240 * fit.scale + fit.y).toBe(fit.height / 2);
    expect(fit.x).toBeLessThanOrEqual(0);
    expect(fit.y).toBeLessThanOrEqual(0);
    expect(640 * fit.scale + fit.x).toBeGreaterThanOrEqual(fit.width);
    expect(480 * fit.scale + fit.y).toBeGreaterThanOrEqual(fit.height);
  });

  it("keeps the box's shape, so the browser's own cover adds no second crop", () => {
    const fit = overlayFit(1280, 720, 900, 600, 2);
    expect(fit.width / fit.height).toBeCloseTo(900 / 600, 3);
  });

  it("caps the canvas on a very large, dense screen (negative control: 4K at 200% is not drawn at full size)", () => {
    const fit = overlayFit(640, 480, 3840, 2160, 2);
    expect(fit.width * fit.height).toBeLessThanOrEqual(OVERLAY.maxPixels * 1.001);
    expect(fit.width).toBeLessThan(3840 * 2);
  });

  it("falls back to the video's size for a hidden canvas", () => {
    expect(overlayFit(640, 480, 0, 0, 1.5)).toEqual({ width: 640, height: 480, scale: 1, x: 0, y: 0 });
  });
});
