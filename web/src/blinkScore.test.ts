import { describe, expect, it } from "vitest";
import {
  BLINK_SEQUENCE,
  blinkScore,
  blinkShape,
  blinkShapes,
  calibrateBlinks,
  drowsyChance,
  MIN_SCORE_BLINKS,
  MODEL,
  sequenceFeatures,
  type BlinkNorm,
  type BlinkShape,
} from "./blinkScore.ts";
import { Monitor } from "./monitor.ts";
import type { FrameSignal } from "./signals.ts";
import { BASELINE, earSeries, FRAME_MS, frame } from "./test-helpers.ts";

// BASELINE: open 0.30, closed 0.10 → blink threshold 0.20.
const DIP = [0.15, 0.05, 0.15]; // three closed frames: a 300 ms blink, bottom 0.05

// Open eyes with a blink every `periodMs`, for `seconds`; `dip` sets each blink's EAR values.
function blinking(seconds: number, periodMs: number, dip: readonly number[] = DIP, start = 0): FrameSignal[] {
  const frames: FrameSignal[] = [];
  const perPeriod = periodMs / FRAME_MS;
  for (let i = 0; i < (seconds * 1000) / FRAME_MS; i++) {
    const k = i % perPeriod;
    const ear = k >= 5 && k < 5 + dip.length ? dip[k - 5] : 0.3;
    frames.push(frame(start + i * FRAME_MS, { ear, earLeft: ear, earRight: ear }));
  }
  return frames;
}

const shape = (overrides: Partial<BlinkShape>): BlinkShape => ({
  startT: 0,
  endT: 300,
  durasi: 300,
  amplitudo: 0.25,
  kecepatan: 1.25,
  ...overrides,
});

const NORM: BlinkNorm = {
  durasi: { mean: 200, sd: 50 },
  amplitudo: { mean: 0.2, sd: 0.05 },
  kecepatan: { mean: 1, sd: 0.25 },
  perMenit: 15,
  n: 40,
};

describe("blinkShape", () => {
  it("measures duration, amplitude and eye-opening velocity as in the UTA-RLDD paper", () => {
    const frames = earSeries([0.3, 0.3, ...DIP, 0.3, 0.3]);
    // closed from frame 2 (200 ms) to the reopened frame 5 (500 ms), bottom at frame 3 (300 ms)
    const b = blinkShape(frames, 200, 500);
    expect(b).not.toBeNull();
    expect(b!.durasi).toBe(300);
    expect(b!.amplitudo).toBeCloseTo((0.3 - 2 * 0.05 + 0.3) / 2);
    expect(b!.kecepatan).toBeCloseTo((0.3 - 0.05) / 0.2);
  });

  it("gives nothing without an open frame before the closure or a reopened frame", () => {
    const frames = earSeries([...DIP, 0.3]);
    expect(blinkShape(frames, 0, 300)).toBeNull();
    expect(blinkShape(earSeries([0.3, ...DIP]), 100, 400)).toBeNull();
  });
});

describe("blinkShapes / calibrateBlinks", () => {
  it("finds the blinks with Monitor's detector", () => {
    const shapes = blinkShapes(blinking(60, 4000), BASELINE);
    expect(shapes).toHaveLength(15);
    expect(shapes.every((b) => b.durasi === 300)).toBe(true);
  });

  it("stores mean, SD and rate of the calibration blinks", () => {
    const norm = calibrateBlinks(blinking(60, 4000), BASELINE)!;
    expect(norm.n).toBe(15);
    expect(norm.durasi).toEqual({ mean: 300, sd: 1 }); // identical blinks: SD 0 becomes 1
    expect(norm.amplitudo.mean).toBeCloseTo(0.25);
    expect(norm.perMenit).toBeCloseTo(15 / (59.9 / 60));
  });

  it("gives no norm from fewer than 5 blinks", () => {
    expect(calibrateBlinks(blinking(16, 4000), BASELINE)).toBeNull(); // 4 blinks
    expect(calibrateBlinks(blinking(20, 4000), BASELINE)).not.toBeNull();
  });
});

describe("sequenceFeatures", () => {
  it("z-scores the last 30 blinks that ended by now against the calibration", () => {
    const old = Array.from({ length: 10 }, (_, i) => shape({ startT: i * 1000, endT: i * 1000 + 300, durasi: 900 }));
    const recent = Array.from({ length: BLINK_SEQUENCE }, (_, i) =>
      shape({ startT: 60_000 + i * 2000, endT: 60_000 + i * 2000 + 300, durasi: 250, amplitudo: 0.1, kecepatan: 1.5 }),
    );
    const later = shape({ startT: 200_000, endT: 200_300, durasi: 900 });
    const now = 60_000 + (BLINK_SEQUENCE - 1) * 2000 + 300;
    const { values, n } = sequenceFeatures([...old, ...recent, later], now, NORM);
    expect(n).toBe(BLINK_SEQUENCE);
    expect(values.zk_durasi_rata).toBeCloseTo((250 - 200) / 50);
    expect(values.zk_amplitudo_rata).toBeCloseTo((0.1 - 0.2) / 0.05);
    expect(values.zk_kecepatan_rata).toBeCloseTo((1.5 - 1) / 0.25);
    // 30 blinks over (now − first start) = 58.3 s, against 15 per minute
    expect(values.zk_frekuensi_relatif).toBeCloseTo(30 / ((now - 60_000) / 60_000) / 15);
  });

  it("has no values without blinks", () => {
    const { values, n } = sequenceFeatures([], 1000, NORM);
    expect(n).toBe(0);
    expect(Object.values(values).every((v) => v === null)).toBe(true);
  });
});

describe("drowsyChance / blinkScore", () => {
  const same = { zk_durasi_rata: 0, zk_amplitudo_rata: 0, zk_kecepatan_rata: 0, zk_frekuensi_relatif: 1 };

  it("stays low for blinks like the calibration and rises with longer, more frequent blinks", () => {
    expect(drowsyChance(same)).toBeCloseTo(0.283, 2);
    expect(drowsyChance({ ...same, zk_durasi_rata: 1 })).toBeGreaterThan(drowsyChance(same));
    expect(drowsyChance({ ...same, zk_frekuensi_relatif: 1.5 })).toBeGreaterThan(drowsyChance(same));
    expect(drowsyChance({ ...same, zk_durasi_rata: 1, zk_frekuensi_relatif: 1.5 })).toBeGreaterThan(0.5);
  });

  it("fills a missing feature with the training median", () => {
    const filled = { ...same, zk_kecepatan_rata: MODEL.fill[2] };
    expect(drowsyChance({ ...same, zk_kecepatan_rata: null })).toBeCloseTo(drowsyChance(filled));
  });

  it("gives no chance before MIN_SCORE_BLINKS blinks", () => {
    const shapes = Array.from({ length: MIN_SCORE_BLINKS }, (_, i) => shape({ startT: i * 4000, endT: i * 4000 + 300 }));
    const now = 60_000;
    expect(blinkScore(shapes.slice(1), now, NORM)).toEqual({ chance: null, n: MIN_SCORE_BLINKS - 1 });
    expect(blinkScore(shapes, now, NORM).chance).toBeTypeOf("number");
  });
});

describe("Monitor.blinkScore", () => {
  const withNorm = { ...BASELINE, kedip: calibrateBlinks(blinking(60, 4000), BASELINE) };

  function run(monitor: Monitor, frames: FrameSignal[]) {
    const labels: (string | undefined)[] = [];
    for (const f of frames) {
      monitor.pushFrame(f);
      if (f.t > 0 && f.t % 10_000 === 0) {
        monitor.evaluate(f.t);
        labels.push(monitor.labelState.shown?.label);
      }
    }
    return labels;
  }

  it("scores the blinks seen live against the calibration norm", () => {
    const monitor = new Monitor(withNorm, { windowMs: 60_000, evalIntervalMs: 10_000 });
    const frames = blinking(120, 2000, [0.15, 0.05, 0.05, 0.05, 0.15]); // twice as frequent, 500 ms
    run(monitor, frames);
    const score = monitor.blinkScore(frames[frames.length - 1].t)!;
    expect(score.n).toBe(BLINK_SEQUENCE);
    expect(score.chance).toBeGreaterThan(0.5);
    const calm = new Monitor(withNorm, { windowMs: 60_000, evalIntervalMs: 10_000 });
    const calmFrames = blinking(120, 4000);
    run(calm, calmFrames);
    expect(calm.blinkScore(calmFrames[calmFrames.length - 1].t)!.chance).toBeLessThan(0.5);
  });

  it("is off without a blink norm and never changes the label (D-49)", () => {
    const frames = blinking(120, 2000, [0.15, 0.05, 0.05, 0.05, 0.15]);
    const plain = new Monitor(BASELINE, { windowMs: 60_000, evalIntervalMs: 10_000 });
    const scored = new Monitor(withNorm, { windowMs: 60_000, evalIntervalMs: 10_000 });
    expect(run(plain, frames)).toEqual(run(scored, frames));
    expect(plain.blinkScore(frames[frames.length - 1].t)).toBeNull();
  });
});
