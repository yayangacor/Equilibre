import { describe, expect, it } from "vitest";
import type { LightSample } from "./light.ts";
import { lightWindow } from "./light.ts";
import { Monitor } from "./monitor.ts";
import {
  eyeReliability,
  glassesLikely,
  initialQualityState,
  stepQuality,
  validFace,
  windowQuality,
  type QualityLevel,
} from "./quality.ts";
import { classify, evaluate, initialLabelState } from "./rules.ts";
import type { FrameSignal } from "./signals.ts";
import { BASELINE, frame, noFace } from "./test-helpers.ts";

const NOW = 100_000;
const WINDOW = 60_000;
// The test baseline's closed EAR is 0.33 × open: as if calibrated with glasses. Most tests use one with a real
// eyes-closed stage, as the app's own calibrations (0.05–0.15).
const CLEAR = { ...BASELINE, earClosed: 0.03 };

const window = (stepMs: number, make: (t: number, i: number) => FrameSignal) =>
  Array.from({ length: Math.floor(WINDOW / stepMs) }, (_, i) => make(NOW - WINDOW + (i + 1) * stepMs, i));
const quality = (frames: FrameSignal[], baseline = CLEAR, checkRange = true) =>
  windowQuality(frames, baseline, NOW, WINDOW, checkRange);

describe("frame quality", () => {
  it("accepts a face that is unknown on the new columns (older CSVs, UTA-RLDD)", () => {
    expect(validFace(frame(0, { yawDeg: NaN, rollDeg: NaN, eyeDistPx: NaN }), CLEAR)).toBe(true);
  });

  it("rejects a face turned or tilted too far, tilted back, or too small in the picture", () => {
    expect(validFace(frame(0, { yawDeg: 35 }), CLEAR)).toBe(false);
    expect(validFace(frame(0, { rollDeg: -30 }), CLEAR)).toBe(false);
    expect(validFace(frame(0, { pitchDeg: CLEAR.pitchDeg + 25 }), CLEAR)).toBe(false);
    expect(validFace(frame(0, { eyeDistPx: 30 }), CLEAR)).toBe(false);
    expect(validFace(frame(0, { yawDeg: 25, rollDeg: 20, eyeDistPx: 40 }), CLEAR)).toBe(true);
  });

  it("trusts the eyes less as left and right disagree, unless the head is turned", () => {
    expect(eyeReliability(frame(0), CLEAR)).toBe(1);
    expect(eyeReliability(frame(0, { earLeft: 0.3, earRight: 0.24 }), CLEAR)).toBe(1); // gap 0.2 × open
    expect(eyeReliability(frame(0, { earLeft: 0.3, earRight: 0.21 }), CLEAR)).toBeCloseTo(0.8, 6); // gap 0.3 × open
    expect(eyeReliability(frame(0, { earLeft: 0.3, earRight: 0.12 }), CLEAR)).toBe(0); // gap 0.6 × open
    expect(eyeReliability(frame(0, { earLeft: 0.3, earRight: 0.12, yawDeg: 20 }), CLEAR)).toBe(1);
  });

  it("does not trust eyes with the head down or a calibration that could not tell open from closed", () => {
    expect(eyeReliability(frame(0, { pitchDeg: CLEAR.pitchDeg - 20 }), CLEAR)).toBe(0);
    expect(glassesLikely(BASELINE)).toBe(true);
    expect(eyeReliability(frame(0), BASELINE, true)).toBe(0);
    expect(eyeReliability(frame(0), BASELINE, false)).toBe(1); // no eyes-closed stage to judge by
  });
});

describe("window quality (plan P20 W1.4)", () => {
  it("judges a steady 10 fps window fully", () => {
    expect(quality(window(100, (t) => frame(t)))).toMatchObject({ level: "nilai", reason: null, wajah: 1, mata: 1 });
  });

  it("limits a 5 fps window to the time-based signs", () => {
    expect(quality(window(200, (t) => frame(t)))).toMatchObject({ level: "terbatas-fps", reason: "fps" });
  });

  it("does not judge a window in which the face was mostly turned away", () => {
    const q = quality(window(100, (t, i) => frame(t, { yawDeg: i % 10 < 6 ? 40 : 0 })));
    expect(q).toMatchObject({ level: "tidak-dinilai", reason: "wajah" });
    expect(q.wajah).toBeCloseTo(0.4, 1);
  });

  it("leaves the eye signs out when the eyes were readable less than 60% of the time", () => {
    const glare = quality(window(100, (t, i) => frame(t, i % 2 === 0 ? { earLeft: 0.3, earRight: 0.1 } : {})));
    expect(glare).toMatchObject({ level: "terbatas-mata", reason: "mata" });
    expect(quality(window(100, (t) => frame(t)), BASELINE)).toMatchObject({ level: "terbatas-mata", reason: "kacamata" });
  });

  it("leaves a mostly missing face to the rules (away, or hidden at the desk)", () => {
    expect(quality(window(100, (t, i) => (i % 10 < 7 ? noFace(t) : frame(t)))).level).toBe("nilai");
  });

  it("does not judge a window that is mostly a stall, and blames the frames, not the face", () => {
    // Frames only in the first 20 s and the last 5 s of the window: 35 s missing.
    const frames = window(100, (t) => frame(t)).filter((f) => f.t <= NOW - 40_000 || f.t > NOW - 5_000);
    expect(quality(frames)).toMatchObject({ level: "tidak-dinilai", reason: "fps", wajah: 1, mata: 1 });
    // 25 s missing: judged on the 35 s seen.
    const shorter = window(100, (t) => frame(t)).filter((f) => f.t <= NOW - 30_000 || f.t > NOW - 5_000);
    expect(quality(shorter).level).toBe("nilai");
  });
});

describe("light in the window (plan P20 W1.5, W1.6c)", () => {
  const lights = (make: (t: number) => Partial<LightSample>) =>
    lightWindow(
      Array.from({ length: 60 }, (_, i) => {
        const t = NOW - WINDOW + (i + 1) * 1000;
        return { t, face: true, luma: 120, clipped: 0, eyes: 0.8, eyeGlare: 0, ...make(t) };
      }),
      NOW,
      WINDOW,
    );
  const steady = window(100, (t) => frame(t));

  it("does not judge a dark window, even when the face was lost in it", () => {
    const dark = lights(() => ({ luma: 25 }));
    expect(windowQuality(steady, CLEAR, NOW, WINDOW, true, dark)).toMatchObject({ level: "tidak-dinilai", reason: "cahaya" });
    const lost = window(100, (t) => noFace(t));
    const room = lights(() => ({ face: false, luma: 15, eyes: NaN, eyeGlare: NaN }));
    expect(windowQuality(lost, CLEAR, NOW, WINDOW, true, room).reason).toBe("cahaya");
  });

  it("does not judge a face washed out by glare", () => {
    expect(windowQuality(steady, CLEAR, NOW, WINDOW, true, lights(() => ({ clipped: 0.4 }))).reason).toBe("silau");
  });

  it("leaves the eye signs out with glare on the lenses or dark glasses", () => {
    expect(windowQuality(steady, CLEAR, NOW, WINDOW, true, lights(() => ({ eyeGlare: 0.12 })))).toMatchObject({
      level: "terbatas-mata",
      reason: "silau",
    });
    expect(windowQuality(steady, CLEAR, NOW, WINDOW, true, lights(() => ({ eyes: 0.2 })))).toMatchObject({
      level: "terbatas-mata",
      reason: "mata",
    });
  });

  it("ignores a light problem in fewer than half of the samples, and too few samples", () => {
    expect(windowQuality(steady, CLEAR, NOW, WINDOW, true, lights((t) => ({ luma: t % 3000 === 0 ? 20 : 120 }))).level).toBe("nilai");
    const few = lightWindow([{ t: NOW, face: true, luma: 10, clipped: 0, eyes: 0.8, eyeGlare: 0 }], NOW, WINDOW);
    expect(windowQuality(steady, CLEAR, NOW, WINDOW, true, few).level).toBe("nilai");
  });
});

describe("rules with window quality", () => {
  const features = (overrides = {}) => ({
    perclos: 0.2,
    kedip_per_menit: 15,
    durasi_kedip_ms: 200,
    mata_tertutup_lama: 2,
    menguap: 0,
    pct_kepala_menunduk: 0,
    pct_wajah_hilang: 0,
    pct_mata_terbuka: 0.8,
    pct_mata_tertutup: 0.2,
    pct_tubuh_ada: 1,
    pct_tubuh_utuh: 1,
    pct_tubuh_diam: 0.5,
    gerak_tubuh: 0.01,
    n_frame: 600,
    durasi_jendela_detik: 60,
    ...overrides,
  });
  const limited = (level: QualityLevel, reason: "mata" | "kacamata" | "wajah" | "cahaya" | "fps" | null) => ({
    level,
    reason,
    wajah: 1,
    mata: 0.3,
    fps: 10,
  });

  it("reads only yawns when the eyes cannot be trusted, up to mildly tired", () => {
    expect(classify(features(), CLEAR)?.label).toBe("lelah");
    const eyesLimited = classify(features(), CLEAR, null, limited("terbatas-mata", "kacamata"));
    expect(eyesLimited).toMatchObject({ label: "normal", tanda: [] });
    expect(eyesLimited?.catatan[0]).toMatch(/often glasses/);
    const yawned = classify(features({ menguap: 3 }), CLEAR, null, limited("terbatas-mata", "mata"));
    expect(yawned).toMatchObject({ label: "lelah ringan", tanda: ["menguap"] });
  });

  it("gives no label for a window it could not read, and says why", () => {
    const step = evaluate(features(), CLEAR, initialLabelState(), null, null, limited("tidak-dinilai", "wajah"));
    expect(step.latest).toBeNull();
    expect(step.cause).toBe("wajah");
    expect(step.hold).toMatch(/turned away or too far/);
  });

  it("says too dark instead of away when the room is dark", () => {
    const gone = features({ pct_wajah_hilang: 0.9, pct_tubuh_ada: 0 });
    const step = evaluate(gone, CLEAR, initialLabelState(), null, null, limited("tidak-dinilai", "cahaya"));
    expect(step.latest).toBeNull();
    expect(step.cause).toBe("cahaya");
    expect(step.hold).toMatch(/Too dark/);
  });

  it("still says away when the face is gone, whatever the quality", () => {
    const away = classify(features({ pct_wajah_hilang: 0.9, pct_tubuh_ada: 0 }), CLEAR, null, limited("tidak-dinilai", "wajah"));
    expect(away?.label).toBe("tidak di depan layar");
  });
});

describe("what the UI shows changes after two windows in a row", () => {
  it("switches on the second window, and updates the reason within a level", () => {
    let s = stepQuality(initialQualityState(), { level: "nilai", reason: null });
    s = stepQuality(s, { level: "tidak-dinilai", reason: "fps" });
    expect(s.level).toBe("nilai");
    s = stepQuality(s, { level: "tidak-dinilai", reason: "wajah" });
    expect(s).toMatchObject({ level: "tidak-dinilai", reason: "wajah" });
    s = stepQuality(s, { level: "tidak-dinilai", reason: "fps" });
    expect(s.reason).toBe("fps");
    s = stepQuality(s, { level: "nilai", reason: null });
    expect(s.level).toBe("tidak-dinilai"); // one window is not enough
    s = stepQuality(s, { level: "tidak-dinilai", reason: "fps" }); // back to the shown level: the streak ends
    s = stepQuality(s, { level: "nilai", reason: null });
    expect(s.level).toBe("tidak-dinilai");
    s = stepQuality(s, { level: "terbatas-fps", reason: "fps" }); // two windows unlike the shown one: the latest shows
    expect(s).toMatchObject({ level: "terbatas-fps", reason: "fps" });
  });

  it("does not stay on a stale level while two other levels take turns (review C, 8 Nov)", () => {
    let s = stepQuality(initialQualityState(), { level: "tidak-dinilai", reason: "wajah" });
    for (let i = 0; i < 8; i++) s = stepQuality(s, i % 2 === 0 ? { level: "nilai", reason: null } : { level: "terbatas-fps", reason: "fps" });
    expect(s.level).not.toBe("tidak-dinilai");
  });

  it("judges a window holding one frame as too few frames, with or without a face (review C, 8 Nov)", () => {
    for (const one of [frame(60_000), noFace(60_000)]) {
      expect(windowQuality([one], CLEAR, 60_000, WINDOW)).toMatchObject({ level: "tidak-dinilai", reason: "fps" });
    }
    const monitor = new Monitor(CLEAR, { windowMs: WINDOW, evalIntervalMs: 10_000 });
    monitor.pushFrame(noFace(60_000));
    const step = monitor.evaluate(60_000);
    expect(step.latest).toBeNull();
    expect(step.cause).toBe("fps");
  });

  it("greys out a label that has not been refreshed, through the Monitor", () => {
    const monitor = new Monitor(CLEAR, { windowMs: WINDOW, evalIntervalMs: 10_000, eyesClosedStage: true });
    const levels: (QualityLevel | null)[] = [];
    let last: number | null = null;
    for (let t = 100; t <= 180_000; t += 100) {
      // Facing the camera for 90 s, then turned away.
      monitor.pushFrame(frame(t, { yawDeg: t <= 90_000 ? 0 : 45 }));
      if (t % 10_000 === 0) {
        const step = monitor.evaluate(t);
        levels.push(step.assessed.level);
        last = step.lastAssessedT;
      }
    }
    expect(levels.slice(0, 9).every((l) => l === "nilai")).toBe(true);
    expect(levels.at(-1)).toBe("tidak-dinilai");
    expect(monitor.labelState.shown?.label).toBe("normal"); // kept, shown as stale
    expect(last).toBeLessThan(140_000);
  });
});
