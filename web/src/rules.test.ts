import { describe, expect, it } from "vitest";
import type { WindowFeatures } from "./features.ts";
import { applyHysteresis, classify, evaluate, initialLabelState, type Evaluation, type Label } from "./rules.ts";
import { BASELINE } from "./test-helpers.ts";

const calm: WindowFeatures = {
  perclos: 0.02,
  kedip_per_menit: 14,
  durasi_kedip_ms: 180,
  menguap: 0,
  pct_kepala_menunduk: 0,
  pct_wajah_hilang: 0,
  n_frame: 600,
  durasi_jendela_detik: 60,
};

describe("classify", () => {
  it.each<[string, Partial<WindowFeatures>, Label, number]>([
    ["everything calm", {}, "normal", 0],
    ["PERCLOS just under 8%", { perclos: 0.079 }, "normal", 0],
    ["PERCLOS exactly 8%", { perclos: 0.08 }, "lelah ringan", 0.25],
    ["one yawn", { menguap: 1 }, "lelah ringan", 0.25],
    ["slow blinks (1.5× baseline 200 ms)", { durasi_kedip_ms: 300 }, "lelah ringan", 0.25],
    ["head down 30%", { pct_kepala_menunduk: 0.3 }, "lelah ringan", 0.25],
    ["two signals", { menguap: 2, pct_kepala_menunduk: 0.4 }, "lelah ringan", 0.5],
    ["PERCLOS just under 15%", { perclos: 0.149 }, "lelah ringan", 0.25],
    ["PERCLOS exactly 15%", { perclos: 0.15 }, "lelah", 0.75],
    ["three signals without high PERCLOS", { perclos: 0.1, menguap: 1, pct_kepala_menunduk: 0.5 }, "lelah", 0.75],
    ["all four signals", { perclos: 0.2, durasi_kedip_ms: 400, menguap: 1, pct_kepala_menunduk: 0.5 }, "lelah", 1],
    ["face missing exactly 50%", { pct_wajah_hilang: 0.5, perclos: 0.3 }, "tidak di depan layar", 0],
    ["face missing 49%", { pct_wajah_hilang: 0.49 }, "normal", 0],
  ])("%s → %s", (_name, overrides, label, skor) => {
    const result = classify({ ...calm, ...overrides }, BASELINE);
    expect(result?.label).toBe(label);
    expect(result?.skor).toBeCloseTo(skor);
    expect(result?.alasan).toHaveLength(result?.label === "tidak di depan layar" ? 1 : (result?.poin ?? -1));
  });

  it("gives no label before calibration or without frames", () => {
    expect(classify(calm, null)).toBeNull();
    expect(classify({ ...calm, n_frame: 0 }, BASELINE)).toBeNull();
  });

  it("explains each triggered rule in Indonesian", () => {
    const result = classify({ ...calm, perclos: 0.18, menguap: 2 }, BASELINE);
    expect(result?.alasan).toEqual([
      "Mata tertutup 18% dari 60 detik terakhir (batas 15%).",
      "Menguap 2× dalam 60 detik terakhir.",
    ]);
  });

  it("skips the slow-blink rule when calibration saw no blinks", () => {
    const result = classify({ ...calm, durasi_kedip_ms: 900 }, { ...BASELINE, blinkDurationMs: null });
    expect(result?.label).toBe("normal");
  });
});

const ev = (label: Label): Evaluation => ({ label, skor: 0, poin: 0, alasan: [] });

describe("hysteresis", () => {
  it("shows the first label right away", () => {
    expect(applyHysteresis(initialLabelState(), ev("normal")).shown?.label).toBe("normal");
  });

  it("keeps the label after one different evaluation and switches after two", () => {
    let s = applyHysteresis(initialLabelState(), ev("normal"));
    s = applyHysteresis(s, ev("lelah"));
    expect(s.shown?.label).toBe("normal");
    expect(s.candidate).toBe("lelah");
    s = applyHysteresis(s, ev("lelah"));
    expect(s.shown?.label).toBe("lelah");
    expect(s.candidate).toBeNull();
  });

  it("restarts the count when the candidate changes or the old label returns", () => {
    let s = applyHysteresis(initialLabelState(), ev("normal"));
    s = applyHysteresis(s, ev("lelah ringan"));
    s = applyHysteresis(s, ev("lelah"));
    expect(s.shown?.label).toBe("normal");
    s = applyHysteresis(s, ev("normal"));
    s = applyHysteresis(s, ev("lelah"));
    expect(s.shown?.label).toBe("normal");
  });

  it("evaluate() leaves the state alone when there is nothing to classify", () => {
    const prev = applyHysteresis(initialLabelState(), ev("lelah"));
    const { state, latest } = evaluate(calm, null, prev);
    expect(latest).toBeNull();
    expect(state).toBe(prev);
  });
});
