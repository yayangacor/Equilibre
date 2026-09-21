import { describe, expect, it } from "vitest";
import { bodyPresent, maskToGrid, toBodySample } from "./body.ts";

// A width × height mask with the person (confidence 1) in the given column range.
function mask(width: number, height: number, person: (x: number, y: number) => boolean): Float32Array {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = person(x, y) ? 1 : 0;
  return data;
}

describe("maskToGrid", () => {
  it("averages the mask into roughly square cells", () => {
    const grid = maskToGrid(mask(64, 48, (x) => x < 32), 64, 48, 16);
    expect([grid.cols, grid.rows]).toEqual([16, 12]);
    expect(grid.cells[0]).toBe(1); // left half: person
    expect(grid.cells[15]).toBe(0); // right half: background
  });

  it("keeps partial coverage as a fraction", () => {
    const grid = maskToGrid(mask(8, 8, (x, y) => x === 0 && y < 2), 8, 8, 2);
    expect(grid.cells[0]).toBeCloseTo(2 / 16);
  });
});

describe("toBodySample", () => {
  it("reports the covered area and the change since the previous grid", () => {
    const sitting = maskToGrid(mask(32, 24, (x) => x >= 8 && x < 24), 32, 24, 16);
    const leaning = maskToGrid(mask(32, 24, (x) => x >= 10 && x < 26), 32, 24, 16);
    const first = toBodySample(sitting, null, 0);
    expect(first.area).toBeCloseTo(0.5);
    expect(first.motion).toBeNaN();
    expect(toBodySample(sitting, sitting, 500).motion).toBe(0);
    // One column emptied and one filled: 2 of 16 columns changed.
    expect(toBodySample(leaning, sitting, 1000).motion).toBeCloseTo(2 / 16);
  });
});

describe("bodyPresent", () => {
  it("needs a minimum area, and 30% of the calibrated area when there is one", () => {
    const at = (area: number) => ({ t: 0, area, motion: 0 });
    expect(bodyPresent(at(0.06), null)).toBe(true);
    expect(bodyPresent(at(0.04), null)).toBe(false);
    expect(bodyPresent(at(0.11), 0.4)).toBe(false); // 0.3 × 0.4 = 0.12
    expect(bodyPresent(at(0.12), 0.4)).toBe(true);
  });
});
