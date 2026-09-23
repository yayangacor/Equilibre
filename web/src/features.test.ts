import { describe, expect, it } from "vitest";
import type { EyeClosure } from "./blink.ts";
import type { BodySample } from "./body.ts";
import { computeWindowFeatures, initialBreakState, minutesSinceBreak, stepBreak } from "./features.ts";
import type { FrameSignal } from "./signals.ts";
import { BASELINE, frame, noFace, repeat } from "./test-helpers.ts";
import type { YawnEvent } from "./yawn.ts";

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

const compute = (frames: FrameSignal[], closures: EyeClosure[] = [], yawns: YawnEvent[] = [], bodies: BodySample[] = []) =>
  computeWindowFeatures({ frames, closures, yawns, bodies }, BASELINE, NOW, WINDOW);

describe("computeWindowFeatures", () => {
  it("computes PERCLOS from face frames under the closed threshold (0.116)", () => {
    const f = compute(tenFps((t, i) => frame(t, { ear: i < 90 ? 0.11 : 0.3 }))); // 15% closed
    expect(f.perclos).toBeCloseTo(0.15);
    expect(f.pct_mata_terbuka).toBeCloseTo(0.85);
    expect(f.n_frame).toBe(600);
    expect(f.pct_wajah_hilang).toBe(0);
    expect(f.durasi_jendela_detik).toBeCloseTo(59.9);
  });

  it("excludes frames outside the window", () => {
    const old = repeat(0, 50).map((_, i) => frame(NOW - WINDOW - i * 100, { ear: 0.05 }));
    const f = compute([...old, ...tenFps((t) => frame(t))]);
    expect(f.n_frame).toBe(600);
    expect(f.perclos).toBe(0);
  });

  it("uses only face frames for ratios but all frames for pct_wajah_hilang", () => {
    const f = compute(tenFps((t, i) => (i % 4 === 0 ? noFace(t) : frame(t, { pitchDeg: i % 2 ? -25 : -5 }))));
    expect(f.pct_wajah_hilang).toBeCloseTo(0.25);
    // Odd frames are head-down (−25 − (−5) = −20° ≤ −15°); they are 2/3 of the face frames.
    expect(f.pct_kepala_menunduk).toBeCloseTo(2 / 3);
    expect(f.perclos).toBe(0);
  });

  it("does not judge the eyes while the head is down (looking at a phone)", () => {
    // Second half: head down 25° with lids low (EAR 0.05), as when reading a phone.
    const f = compute(tenFps((t, i) => (i < 300 ? frame(t) : frame(t, { pitchDeg: -30, ear: 0.05 }))));
    expect(f.perclos).toBe(0);
    expect(f.pct_kepala_menunduk).toBeCloseTo(0.5);
    expect(f.pct_mata_terbuka).toBeCloseTo(0.5);
    expect(f.pct_mata_tertutup).toBe(0); // low lids with the head down are "not seen", not closed
    expect(f.kedip_per_menit).toBe(0); // per minute of readable eyes, not of face time
  });

  it("gives no PERCLOS when the eyes were readable for less than 5 seconds", () => {
    const f = compute(tenFps((t, i) => (i < 40 ? frame(t, { ear: 0.05 }) : frame(t, { pitchDeg: -30 }))));
    expect(f.perclos).toBeNull();
    // Wide-open lids still count as open with the head down: they rule out "tertidur".
    expect(f.pct_mata_terbuka).toBeCloseTo(560 / 600);
    expect(f.pct_mata_tertutup).toBeCloseTo(40 / 600);
  });

  it("leaves blinks shorter than 500 ms out of PERCLOS", () => {
    const t = (i: number) => NOW - WINDOW + (i + 1) * 100;
    const shortStarts = Array.from({ length: 20 }, (_, n) => 10 + n * 20); // 20 blinks of 2 frames
    const closedFrames = new Set([...shortStarts.flatMap((i) => [i, i + 1]), 500, 501, 502, 503, 504, 505]);
    const closures = [
      ...shortStarts.map((i) => blink(t(i + 2), 200)),
      blink(t(506), 600), // a slow blink: still counted
    ];
    const f = compute(tenFps((ft, i) => frame(ft, { ear: closedFrames.has(i) ? 0.05 : 0.3 })), closures);
    expect(f.perclos).toBeCloseTo(6 / 600);
    expect(f.pct_mata_tertutup).toBeCloseTo(46 / 600);
  });

  it("counts blinks per minute of face time and averages their duration", () => {
    const closures = [blink(NOW - 70_000, 100), blink(NOW - 50_000, 100), blink(NOW - 30_000, 300), blink(NOW - 5_000, 1200, "long")];
    const f = compute(tenFps((t) => frame(t)), closures);
    expect(f.kedip_per_menit).toBeCloseTo(2 / (59.9 / 60));
    expect(f.durasi_kedip_ms).toBe(200);
    expect(f.mata_tertutup_lama).toBe(1);
  });

  it("counts yawns that ended inside the window", () => {
    const yawns = [
      { startT: NOW - 65_000, endT: NOW - 62_000, durationMs: 3000 },
      { startT: NOW - 10_000, endT: NOW - 8_000, durationMs: 2000 },
    ];
    expect(compute(tenFps((t) => frame(t)), [], yawns).menguap).toBe(1);
  });

  it("reports body presence and the median body motion", () => {
    // BASELINE.bodyArea 0.4 → present from 0.3 × 0.4 = 0.12 (above the 0.05 floor).
    const bodies = [0.4, 0.35, 0.1, 0.3].map((area, i) => ({ t: NOW - 2000 + i * 500, area, motion: i === 0 ? NaN : i / 100 }));
    const f = compute(tenFps((t) => noFace(t)), [], [], [{ t: NOW - WINDOW - 100, area: 0, motion: 0.5 }, ...bodies]);
    expect(f.pct_tubuh_ada).toBeCloseTo(0.75);
    expect(f.gerak_tubuh).toBeCloseTo(0.02);
  });

  it("reports how often most of the body is in view and how often it is still", () => {
    // "tertidur" needs 0.5 × 0.4 = 0.2 of the frame: a 0.15 mask (a coat on the chair) is present but not enough.
    const bodies = [0.4, 0.35, 0.15, 0.3].map((area, i) => ({ t: NOW - 2000 + i * 500, area, motion: i === 0 ? NaN : i / 100 }));
    const f = compute(tenFps((t) => noFace(t)), [], [], bodies);
    expect(f.pct_tubuh_ada).toBe(1);
    expect(f.pct_tubuh_utuh).toBeCloseTo(0.75);
    expect(f.pct_tubuh_diam).toBeCloseTo(1 / 3); // motions 0.01, 0.02, 0.03 against 0.015
  });

  it("returns nulls when there is not enough data", () => {
    const empty = compute([]);
    expect(empty).toMatchObject({ perclos: null, kedip_per_menit: null, pct_wajah_hilang: null, pct_tubuh_ada: null, n_frame: 0 });
    expect(empty).toMatchObject({ pct_mata_terbuka: null, pct_mata_tertutup: null, pct_tubuh_utuh: null, pct_tubuh_diam: null });

    const away = compute(tenFps((t) => noFace(t)));
    expect(away).toMatchObject({ perclos: null, kedip_per_menit: null, pct_kepala_menunduk: null, pct_wajah_hilang: 1 });
    expect(away).toMatchObject({ pct_mata_terbuka: 0, pct_mata_tertutup: 0, pct_tubuh_ada: null, gerak_tubuh: null });

    expect(compute([frame(NOW - 2000), frame(NOW - 1000)]).kedip_per_menit).toBeNull();
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
