import { describe, expect, it } from "vitest";
import type { EyeClosure } from "./blink.ts";
import { computeWindowFeatures, initialBreakState, minutesSinceBreak, stepBreak } from "./features.ts";
import { BASELINE, frame, noFace, repeat } from "./test-helpers.ts";

const WINDOW = 60_000;
const NOW = 100_000;

// 600 frames at 10 fps filling (40 s, 100 s].
const tenFps = (make: (t: number, i: number) => ReturnType<typeof frame>) =>
  Array.from({ length: 600 }, (_, i) => make(NOW - WINDOW + (i + 1) * 100, i));

const blink = (endT: number, durationMs: number, kind: EyeClosure["kind"] = "blink"): EyeClosure => ({
  kind,
  startT: endT - durationMs,
  endT,
  durationMs,
});

describe("computeWindowFeatures", () => {
  it("computes PERCLOS from face frames under the P80 threshold (0.14)", () => {
    const frames = tenFps((t, i) => frame(t, { ear: i < 90 ? 0.12 : 0.3 })); // 15% closed
    const f = computeWindowFeatures(frames, [], [], BASELINE, NOW, WINDOW);
    expect(f.perclos).toBeCloseTo(0.15);
    expect(f.n_frame).toBe(600);
    expect(f.pct_wajah_hilang).toBe(0);
    expect(f.durasi_jendela_detik).toBeCloseTo(59.9);
  });

  it("excludes frames outside the window", () => {
    const old = repeat(0, 50).map((_, i) => frame(NOW - WINDOW - i * 100, { ear: 0.05 }));
    const f = computeWindowFeatures([...old, ...tenFps((t) => frame(t))], [], [], BASELINE, NOW, WINDOW);
    expect(f.n_frame).toBe(600);
    expect(f.perclos).toBe(0);
  });

  it("uses only face frames for ratios but all frames for pct_wajah_hilang", () => {
    const frames = tenFps((t, i) => (i % 4 === 0 ? noFace(t) : frame(t, { pitchDeg: i % 2 ? -25 : -5 })));
    const f = computeWindowFeatures(frames, [], [], BASELINE, NOW, WINDOW);
    expect(f.pct_wajah_hilang).toBeCloseTo(0.25);
    // Odd frames are head-down (−25 − (−5) = −20° ≤ −15°); they are 2/3 of the face frames.
    expect(f.pct_kepala_menunduk).toBeCloseTo(2 / 3);
    expect(f.perclos).toBe(0);
  });

  it("counts blinks per minute of face time and averages their duration", () => {
    const frames = tenFps((t) => frame(t));
    const closures = [blink(NOW - 70_000, 100), blink(NOW - 50_000, 100), blink(NOW - 30_000, 300), blink(NOW - 5_000, 1200, "long")];
    const f = computeWindowFeatures(frames, closures, [], BASELINE, NOW, WINDOW);
    expect(f.kedip_per_menit).toBeCloseTo(2 / (59.9 / 60));
    expect(f.durasi_kedip_ms).toBe(200);
  });

  it("counts yawns that ended inside the window", () => {
    const yawns = [
      { startT: NOW - 65_000, endT: NOW - 62_000, durationMs: 3000 },
      { startT: NOW - 10_000, endT: NOW - 8_000, durationMs: 2000 },
    ];
    expect(computeWindowFeatures(tenFps((t) => frame(t)), [], yawns, BASELINE, NOW, WINDOW).menguap).toBe(1);
  });

  it("returns nulls when there is not enough data", () => {
    const empty = computeWindowFeatures([], [], [], BASELINE, NOW, WINDOW);
    expect(empty).toMatchObject({ perclos: null, kedip_per_menit: null, pct_wajah_hilang: null, n_frame: 0 });

    const away = computeWindowFeatures(tenFps((t) => noFace(t)), [], [], BASELINE, NOW, WINDOW);
    expect(away).toMatchObject({ perclos: null, kedip_per_menit: null, pct_kepala_menunduk: null, pct_wajah_hilang: 1 });

    const justStarted = [frame(NOW - 2000), frame(NOW - 1000)];
    expect(computeWindowFeatures(justStarted, [], [], BASELINE, NOW, WINDOW).kedip_per_menit).toBeNull();
  });
});

describe("minutes since break", () => {
  it("counts from session start until the face is gone for 2 minutes", () => {
    let s = initialBreakState(0);
    s = stepBreak(s, 60_000, false); // short absence…
    s = stepBreak(s, 100_000, true); // …is not a break
    expect(minutesSinceBreak(s, 600_000)).toBe(10);

    s = stepBreak(s, 600_000, false);
    expect(minutesSinceBreak(s, 750_000)).toBe(0); // away for 2.5 min: on a break now
    s = stepBreak(s, 750_000, true);
    expect(minutesSinceBreak(s, 750_000 + 5 * 60_000)).toBe(5);
  });
});
