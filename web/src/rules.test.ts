import { describe, expect, it } from "vitest";
import type { WindowFeatures } from "./features.ts";
import {
  applyHysteresis,
  classify,
  evaluate,
  hiddenFaceNote,
  initialLabelState,
  SLEEP,
  type Evaluation,
  type Label,
  type SleepContext,
} from "./rules.ts";
import { BASELINE } from "./test-helpers.ts";

const calm: WindowFeatures = {
  perclos: 0.02,
  kedip_per_menit: 14,
  durasi_kedip_ms: 180,
  mata_tertutup_lama: 0,
  menguap: 0,
  pct_kepala_menunduk: 0,
  pct_wajah_hilang: 0,
  pct_mata_terbuka: 0.97,
  pct_tubuh_ada: 1,
  gerak_tubuh: 0.03,
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
    ["one eye closure of 1 s or longer", { mata_tertutup_lama: 1 }, "lelah ringan", 0.25],
    ["head down 60% alone (looking at a phone)", { pct_kepala_menunduk: 0.6 }, "normal", 0],
    ["two signals", { menguap: 2, mata_tertutup_lama: 1 }, "lelah ringan", 0.5],
    ["PERCLOS just under 15%", { perclos: 0.149 }, "lelah ringan", 0.25],
    ["PERCLOS exactly 15%", { perclos: 0.15 }, "lelah", 0.75],
    ["three signals without high PERCLOS", { perclos: 0.1, menguap: 1, mata_tertutup_lama: 2 }, "lelah", 0.75],
    ["all four signals", { perclos: 0.2, durasi_kedip_ms: 400, menguap: 1, mata_tertutup_lama: 1 }, "lelah", 1],
    ["face missing exactly 50%, nobody in view", { pct_wajah_hilang: 0.5, perclos: 0.3, pct_tubuh_ada: 0.2 }, "tidak di depan layar", 0],
    ["face missing, body detection off", { pct_wajah_hilang: 0.9, pct_tubuh_ada: null }, "tidak di depan layar", 0],
    ["face missing 49%", { pct_wajah_hilang: 0.49 }, "normal", 0],
  ])("%s → %s", (_name, overrides, label, skor) => {
    const result = classify({ ...calm, ...overrides }, BASELINE);
    expect(result?.label).toBe(label);
    expect(result?.skor).toBeCloseTo(skor);
    expect(result?.alasan).toHaveLength(result?.label === "tidak di depan layar" ? 1 : (result?.poin ?? -1));
  });

  it("explains head down as context, not as a fatigue sign", () => {
    const result = classify({ ...calm, pct_kepala_menunduk: 0.6 }, BASELINE);
    expect(result?.alasan).toEqual([]);
    expect(result?.catatan).toHaveLength(1);
    expect(result?.catatan[0]).toMatch(/^Kepala menunduk 60% dari 60 detik terakhir, mungkin sedang melihat HP/);
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

// Face hidden for the whole window, someone still at the desk and not moving.
const asleep: WindowFeatures = {
  ...calm,
  perclos: null,
  kedip_per_menit: null,
  durasi_kedip_ms: null,
  pct_kepala_menunduk: null,
  pct_wajah_hilang: 1,
  pct_mata_terbuka: 0,
  pct_tubuh_ada: 0.95,
  gerak_tubuh: 0.004,
};
const tiredFor = (menitLelah: number): SleepContext => ({ menitLelah, minMenitLelah: SLEEP.fatigueMinutes });

describe("tertidur and a hidden face", () => {
  it("says tertidur only after a long stretch of lelah", () => {
    const result = classify(asleep, BASELINE, tiredFor(15));
    expect(result?.label).toBe("tertidur");
    expect(result?.skor).toBe(1);
    expect(result?.alasan).toEqual([
      "Wajah tidak terlihat 100% dari 60 detik terakhir, tapi tubuhmu masih terdeteksi di depan kamera.",
      "Tubuh hampir tidak bergerak (gerak 0,004, batas 0,015).",
      'Sebelumnya status "lelah" sudah 15 menit dalam 60 menit terakhir (syarat 15 menit).',
    ]);
  });

  it("holds the label when the face is hidden but the history is too short", () => {
    expect(classify(asleep, BASELINE, tiredFor(14.9))).toBeNull();
    const prev = applyHysteresis(initialLabelState(), ev("normal"));
    const { state, latest, hold } = evaluate(asleep, BASELINE, prev, tiredFor(3));
    expect(latest).toBeNull();
    expect(state).toBe(prev);
    expect(hold).toMatch(/^Wajah tidak terlihat 100% dari 60 detik terakhir, tapi tubuhmu masih terdeteksi/);
  });

  it.each<[string, Partial<WindowFeatures>]>([
    ["moving (e.g. scrolling a phone in the lap)", { gerak_tubuh: 0.03 }],
    ["eyes seen open 20% of the time", { pct_wajah_hilang: 0.8, pct_mata_terbuka: 0.2 }],
    ["body detection off", { pct_tubuh_ada: null, gerak_tubuh: null }],
  ])("is not tertidur when %s", (_name, overrides) => {
    expect(classify({ ...asleep, ...overrides }, BASELINE, tiredFor(30))?.label).not.toBe("tertidur");
  });

  it("can be tertidur with the face visible but the eyes closed the whole time", () => {
    const slumped = { ...calm, perclos: 1, pct_mata_terbuka: 0, gerak_tubuh: 0.002 };
    expect(classify(slumped, BASELINE, tiredFor(20))?.label).toBe("tertidur");
    expect(classify(slumped, BASELINE, tiredFor(0))?.label).toBe("lelah");
  });

  it("only holds while someone is in view", () => {
    expect(hiddenFaceNote({ ...asleep, pct_tubuh_ada: 0.5 })).not.toBeNull();
    expect(hiddenFaceNote({ ...asleep, pct_tubuh_ada: 0.49 })).toBeNull();
    expect(hiddenFaceNote({ ...asleep, pct_wajah_hilang: 0.3 })).toBeNull();
  });
});

const ev = (label: Label): Evaluation => ({ label, skor: 0, poin: 0, alasan: [], catatan: [] });

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
