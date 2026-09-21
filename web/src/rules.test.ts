import { describe, expect, it } from "vitest";
import type { WindowFeatures } from "./features.ts";
import {
  applyHysteresis,
  classify,
  evaluate,
  hiddenFaceNote,
  initialLabelState,
  longRestAdvice,
  type Evaluation,
  type Label,
  type SleepLookback,
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
  pct_mata_tertutup: 0.03,
  pct_tubuh_ada: 1,
  pct_tubuh_utuh: 1,
  pct_tubuh_diam: 0.3,
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
    ["fast blinks alone (2× baseline 15/min)", { kedip_per_menit: 30 }, "normal", 0],
    ["fast blinks with a yawn", { kedip_per_menit: 30, menguap: 1 }, "lelah ringan", 0.5],
    ["blinks just under 2× with a yawn", { kedip_per_menit: 29.9, menguap: 1 }, "lelah ringan", 0.25],
    ["fast blinks with two other signs", { kedip_per_menit: 30, menguap: 1, mata_tertutup_lama: 1 }, "lelah", 0.75],
    [
      "face missing exactly 50%, nobody in view",
      { pct_wajah_hilang: 0.5, pct_mata_terbuka: 0.45, pct_mata_tertutup: 0.05, perclos: 0.3, pct_tubuh_ada: 0.2 },
      "tidak di depan layar",
      0,
    ],
    [
      "face missing, body detection off",
      { pct_wajah_hilang: 0.9, pct_mata_terbuka: 0.1, pct_mata_tertutup: 0, pct_tubuh_ada: null },
      "tidak di depan layar",
      0,
    ],
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

  it("explains fast blinks as a note when nothing else points to fatigue", () => {
    const alone = classify({ ...calm, kedip_per_menit: 31 }, BASELINE);
    expect(alone?.catatan).toEqual([
      "Berkedip 31×/menit, lebih sering dari biasanya (15; batas 30), tapi tidak dihitung karena tidak ada tanda lelah lain.",
    ]);
    const withYawn = classify({ ...calm, kedip_per_menit: 31, menguap: 1 }, BASELINE);
    expect(withYawn?.alasan).toEqual([
      "Menguap 1× dalam 60 detik terakhir.",
      "Berkedip 31×/menit, lebih sering dari biasanya (15; batas 30).",
    ]);
  });

  it("skips the fast-blink rule when calibration saw no blinks", () => {
    const result = classify({ ...calm, kedip_per_menit: 10, menguap: 1 }, { ...BASELINE, blinkPerMin: 0 });
    expect(result?.poin).toBe(1);
  });
});

// Eyes hidden for the whole window, most of the body in view and still.
const asleep: WindowFeatures = {
  ...calm,
  perclos: null,
  kedip_per_menit: null,
  durasi_kedip_ms: null,
  pct_kepala_menunduk: null,
  pct_wajah_hilang: 1,
  pct_mata_terbuka: 0,
  pct_mata_tertutup: 0,
  pct_tubuh_ada: 1,
  pct_tubuh_utuh: 0.95,
  pct_tubuh_diam: 0.97,
  gerak_tubuh: 0.004,
};
// Face visible and upright, eyes closed the whole window.
const slumped: WindowFeatures = { ...asleep, perclos: 1, pct_wajah_hilang: 0, pct_kepala_menunduk: 0, pct_mata_tertutup: 1 };

// The same window stretched over a longer span, as Monitor.lookback() gives it.
const over = (minutes: number, f: WindowFeatures, overrides: Partial<WindowFeatures> = {}): WindowFeatures => ({
  ...f,
  durasi_jendela_detik: minutes * 60,
  ...overrides,
});
const lookback = (eyesClosed: WindowFeatures, eyesHidden: WindowFeatures): SleepLookback => ({
  eyesClosed,
  eyesHidden,
  eyesClosedMinutes: 5,
  eyesHiddenMinutes: 10,
});

describe("tertidur and hidden eyes", () => {
  it("says tertidur after 10 still minutes with the eyes hidden, without any fatigue history", () => {
    const result = classify(asleep, BASELINE, lookback(over(5, asleep), over(10, asleep)));
    expect(result?.label).toBe("tertidur");
    expect(result?.skor).toBe(1);
    expect(result?.alasan).toEqual([
      "Mata tidak terlihat (wajah tersembunyi atau kepala tertunduk) selama 10 menit terakhir, dan hanya terlihat terbuka 0% (batas 10%).",
      "Tubuh tetap di depan kamera dan diam 97% dari waktu itu (batas 90%).",
    ]);
  });

  it("says tertidur after 5 minutes when the eyes were seen closed", () => {
    // Only 5 minutes of data: the 10-minute path cannot apply yet.
    const result = classify(slumped, BASELINE, lookback(over(5, slumped), over(5, slumped)));
    expect(result?.label).toBe("tertidur");
    expect(result?.alasan[0]).toBe(
      "Mata terlihat terpejam 100% selama 5 menit terakhir, dan hanya terlihat terbuka 0% (batas 10%).",
    );
    // Before that, closed eyes are "lelah" (PERCLOS), not yet "tertidur".
    expect(classify(slumped, BASELINE, lookback(over(4, slumped), over(4, slumped)))?.label).toBe("lelah");
  });

  it("waits the full 10 minutes when the eyes were seen closed less than half the time", () => {
    const mixed = over(5, asleep, { pct_mata_tertutup: 0.4 });
    expect(classify(asleep, BASELINE, lookback(mixed, over(6, asleep)))).toBeNull();
    expect(classify(asleep, BASELINE, lookback(mixed, over(10, asleep)))?.label).toBe("tertidur");
  });

  it("holds the label while waiting, and says how long", () => {
    const prev = applyHysteresis(initialLabelState(), ev("lelah"));
    const { state, latest, hold } = evaluate(asleep, BASELINE, prev, lookback(over(5, asleep), over(5, asleep)));
    expect(latest).toBeNull();
    expect(state).toBe(prev);
    expect(hold).toMatch(/^Mata tidak terlihat 100% dari 60 detik terakhir \(wajah tersembunyi atau menunduk\)/);
    expect(hold).toMatch(/Kalau tubuh tetap diam 10 menit, statusnya menjadi "tertidur"\.$/);
  });

  it.each<[string, Partial<WindowFeatures>, Partial<WindowFeatures>]>([
    ["moving now (e.g. scrolling a phone in the lap)", { pct_tubuh_diam: 0.5 }, {}],
    ["moving earlier in the 10 minutes", {}, { pct_tubuh_diam: 0.7 }],
    ["eyes seen open 20% of the window", { pct_wajah_hilang: 0.8, pct_mata_terbuka: 0.2 }, {}],
    ["eyes seen open earlier (head down over a phone)", {}, { pct_mata_terbuka: 0.3 }],
    ["only part of the body in view (a coat on the chair)", { pct_tubuh_utuh: 0.2 }, { pct_tubuh_utuh: 0.2 }],
    [
      "body detection off",
      { pct_tubuh_ada: null, pct_tubuh_utuh: null, pct_tubuh_diam: null },
      { pct_tubuh_utuh: null, pct_tubuh_diam: null },
    ],
    ["less than 90% of the 10 minutes recorded", {}, { durasi_jendela_detik: 539 }],
  ])("is not tertidur when %s", (_name, now, earlier) => {
    const result = classify({ ...asleep, ...now }, BASELINE, lookback(over(5, asleep, earlier), over(10, asleep, earlier)));
    expect(result?.label).not.toBe("tertidur");
  });

  it("is never tertidur without the lookback", () => {
    expect(classify(asleep, BASELINE)).toBeNull();
    expect(classify(slumped, BASELINE)?.label).toBe("lelah");
  });

  it("holds when a bowed head hides the eyes, not only a hidden face", () => {
    const bowed = { ...calm, pct_kepala_menunduk: 0.8, pct_mata_terbuka: 0.15, pct_mata_tertutup: 0.05 };
    expect(classify(bowed, BASELINE)).toBeNull();
    expect(hiddenFaceNote(bowed)).toMatch(/^Mata tidak terlihat 80% dari 60 detik terakhir/);
  });

  it("does not hold while looking down at a phone with the eyes seen open", () => {
    const phone = { ...calm, pct_kepala_menunduk: 0.8, pct_mata_terbuka: 0.95, pct_mata_tertutup: 0 };
    expect(classify(phone, BASELINE)?.label).toBe("normal");
  });

  it("only holds while someone is in view", () => {
    expect(hiddenFaceNote({ ...asleep, pct_tubuh_ada: 0.5 })).not.toBeNull();
    expect(hiddenFaceNote({ ...asleep, pct_tubuh_ada: 0.49 })).toBeNull();
    expect(hiddenFaceNote({ ...asleep, pct_mata_terbuka: 0.7 })).toBeNull();
  });
});

describe("long rest advice", () => {
  it("appears from 15 minutes of lelah/tertidur in the last hour", () => {
    expect(longRestAdvice(14.9)).toBeNull();
    expect(longRestAdvice(15.5)).toBe(
      'Dalam 60 menit terakhir kamu 15 menit dalam kondisi "lelah" atau "tertidur" (batas 15 menit). ' +
        "Sebaiknya berhenti dulu dan istirahat yang cukup. Kalau badan terasa kurang fit, pertimbangkan untuk minta izin.",
    );
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
