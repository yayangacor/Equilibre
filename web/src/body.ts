// Body presence from the selfie segmenter's person mask. The face landmarker loses
// the face as soon as the head goes down far (phone in the lap, head on the desk),
// and then "not at the desk" and "at the desk, face hidden" look the same. The
// person mask still covers hair, shoulders and arms, so it tells them apart.
// Pure (no DOM), like the other pipeline modules. Only the numbers below are kept;
// the mask itself is dropped right after this step.

export type BodySample = {
  t: number; // ms, same clock as FrameSignal.t
  area: number; // share of the frame covered by the person (mean mask confidence), 0–1
  motion: number; // mean change of the coarse mask since the previous sample, 0–1; NaN for the first sample
};

// Coarse person mask: mean confidence per cell, row-major.
export type BodyGrid = { cols: number; rows: number; cells: Float32Array };

export const GRID_COLS = 16;

// ⚠️ Initial values, tuned from recorded sessions (see docs/tuning-notes.md).
export const BODY = {
  minArea: 0.05, // below this there is no person in view at all
  minShareOfBaseline: 0.3, // …or less than 30% of the area seen while working normally during calibration
} as const;

// Averages a confidence mask (row-major, width × height) into GRID_COLS columns and
// as many rows as keep the cells roughly square.
export function maskToGrid(mask: ArrayLike<number>, width: number, height: number, cols = GRID_COLS): BodyGrid {
  const rows = Math.max(1, Math.round((cols * height) / width));
  const sums = new Float32Array(cols * rows);
  const counts = new Uint32Array(cols * rows);
  for (let y = 0; y < height; y++) {
    const rowOffset = Math.min(rows - 1, Math.floor((y * rows) / height)) * cols;
    for (let x = 0; x < width; x++) {
      const cell = rowOffset + Math.min(cols - 1, Math.floor((x * cols) / width));
      sums[cell] += mask[y * width + x];
      counts[cell]++;
    }
  }
  for (let i = 0; i < sums.length; i++) sums[i] = counts[i] > 0 ? sums[i] / counts[i] : 0;
  return { cols, rows, cells: sums };
}

const mean = (values: ArrayLike<number>) => {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i];
  return values.length > 0 ? sum / values.length : NaN;
};

export function toBodySample(grid: BodyGrid, previous: BodyGrid | null, t: number): BodySample {
  let motion = NaN;
  if (previous && previous.cols === grid.cols && previous.rows === grid.rows) {
    let sum = 0;
    for (let i = 0; i < grid.cells.length; i++) sum += Math.abs(grid.cells[i] - previous.cells[i]);
    motion = sum / grid.cells.length;
  }
  return { t, area: mean(grid.cells), motion };
}

// baselineArea = Baseline.bodyArea (null for a baseline made before body detection existed).
export function bodyPresent(sample: BodySample, baselineArea: number | null): boolean {
  const relative = baselineArea === null ? 0 : BODY.minShareOfBaseline * baselineArea;
  return sample.area >= Math.max(BODY.minArea, relative);
}
