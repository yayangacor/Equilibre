import { describe, expect, it } from "vitest";
import type { WindowFeatures } from "./features.ts";
import {
  applyHysteresis,
  BLINK_PATTERN_THRESHOLD,
  classify,
  evaluate,
  hiddenFaceNote,
  initialLabelState,
  longRestAdvice,
  withBlinkPattern,
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
    ["slow blinks (2× baseline 200 ms)", { durasi_kedip_ms: 400 }, "lelah ringan", 0.25],
    ["blinks just under 2× (lids half down over a phone)", { durasi_kedip_ms: 399 }, "normal", 0],
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
    expect(result?.tanda).toHaveLength(result?.poin ?? -1);
  });

  it("names each triggered rule in tanda, in the order of alasan (D-41)", () => {
    const all = classify(
      { ...calm, perclos: 0.18, durasi_kedip_ms: 900, menguap: 1, mata_tertutup_lama: 2, kedip_per_menit: 31 },
      BASELINE,
    );
    expect(all?.tanda).toEqual(["mata_sering_tertutup", "kedipan_lambat", "menguap", "mata_terpejam_lama", "kedipan_sering"]);
    expect(all?.alasan).toHaveLength(5);
    // Negative control: fast blinks alone are a note, not a sign sent to the server.
    expect(classify({ ...calm, kedip_per_menit: 31 }, BASELINE)?.tanda).toEqual([]);
    expect(classify({ ...calm, pct_kepala_menunduk: 0.6 }, BASELINE)?.tanda).toEqual([]);
  });

  it("explains head down as context, not as a fatigue sign", () => {
    const result = classify({ ...calm, pct_kepala_menunduk: 0.6 }, BASELINE);
    expect(result?.alasan).toEqual([]);
    expect(result?.catatan).toHaveLength(1);
    expect(result?.catatan[0]).toMatch(/^Head down 60% of the last 60 s, perhaps looking at a phone/);
  });

  it("gives no label before calibration or without frames", () => {
    expect(classify(calm, null)).toBeNull();
    expect(classify({ ...calm, n_frame: 0 }, BASELINE)).toBeNull();
  });

  it("explains each triggered rule in a sentence", () => {
    const result = classify({ ...calm, perclos: 0.18, menguap: 2 }, BASELINE);
    expect(result?.alasan).toEqual([
      "Eyes closed 18% of the last 60 s (limit 15%).",
      "Yawned 2× in the last 60 s.",
    ]);
  });

  it("skips the slow-blink rule when calibration saw no blinks", () => {
    const result = classify({ ...calm, durasi_kedip_ms: 900 }, { ...BASELINE, blinkDurationMs: null });
    expect(result?.label).toBe("normal");
  });

  it("explains fast blinks as a note when nothing else points to fatigue", () => {
    const alone = classify({ ...calm, kedip_per_menit: 31 }, BASELINE);
    expect(alone?.catatan).toEqual([
      "Blinking 31×/min, more often than usual (15; limit 30), but not counted because there is no other sign of fatigue.",
    ]);
    const withYawn = classify({ ...calm, kedip_per_menit: 31, menguap: 1 }, BASELINE);
    expect(withYawn?.alasan).toEqual([
      "Yawned 1× in the last 60 s.",
      "Blinking 31×/min, more often than usual (15; limit 30).",
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
    expect(result?.tanda).toEqual(["tertidur_mata_tak_terlihat"]);
    expect(result?.alasan).toEqual([
      "Eyes not seen (face hidden or head down) over the last 10 min, and seen open only 0% (limit 10%).",
      "Body stayed in front of the camera and still 97% of that time (limit 90%).",
    ]);
  });

  it("says tertidur after 5 minutes when the eyes were seen closed", () => {
    // Only 5 minutes of data: the 10-minute path cannot apply yet.
    const result = classify(slumped, BASELINE, lookback(over(5, slumped), over(5, slumped)));
    expect(result?.label).toBe("tertidur");
    expect(result?.alasan[0]).toBe(
      "Eyes closed 100% over the last 5 min, and seen open only 0% (limit 10%).",
    );
    expect(result?.tanda).toEqual(["tertidur_mata_terpejam"]);
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
    expect(hold).toMatch(/^Eyes not seen 100% of the last 60 s \(face hidden or head down\)/);
    expect(hold).toMatch(/If you stay still and your eyes are not seen open for 10 min, the state becomes "Asleep"\.$/);
  });

  it("says open eyes are what keeps it from tertidur, instead of promising it (26 Sep)", () => {
    // The 26 Sep recording: head resting, face seen in a quarter of the frames, eyes open in all of them.
    const resting = { ...asleep, pct_wajah_hilang: 0.74, pct_mata_terbuka: 0.26, pct_mata_tertutup: 0 };
    const note = hiddenFaceNote(resting, 2);
    expect(note).toMatch(/Eyes still seen open 26% \(limit 10%\), so this does not count as asleep\.$/);
    expect(note).not.toMatch(/the state becomes "Asleep"/);
    // Negative control: at the limit the note still explains how tertidur can follow.
    expect(hiddenFaceNote({ ...resting, pct_mata_terbuka: 0.1 }, 2)).toMatch(/the state becomes "Asleep"\.$/);
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
    expect(hiddenFaceNote(bowed)).toMatch(/^Eyes not seen 80% of the last 60 s/);
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
      'In the last 60 min you spent 15 min "Tired" or "Asleep" (limit 15 min). ' +
        "Stop for now and get proper rest. If you feel unwell, consider taking time off.",
    );
  });
});

const ev = (label: Label): Evaluation => ({ label, skor: 0, poin: 0, alasan: [], tanda: [], catatan: [] });

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
    s = applyHysteresis(s, ev("lelah"));
    s = applyHysteresis(s, ev("tidak di depan layar"));
    expect(s.shown?.label).toBe("normal");
    s = applyHysteresis(s, ev("normal"));
    s = applyHysteresis(s, ev("lelah"));
    expect(s.shown?.label).toBe("normal");
  });

  it("lets lelah ringan and lelah confirm each other on the way in, showing the lighter one", () => {
    // The 21 Sep pattern (NOTES G-31): raw labels alternate, the shown label used to stay "normal".
    const light = { ...ev("lelah ringan"), alasan: ["Menguap 1×."] };
    let s = applyHysteresis(initialLabelState(), ev("normal"));
    s = applyHysteresis(s, light);
    expect(s.candidate).toBe("lelah ringan");
    s = applyHysteresis(s, ev("lelah"));
    expect(s.shown).toBe(light); // the lighter evaluation itself, with its own reasons and score
    // Same the other way round, and with the heavier one first the candidate reads as the lighter.
    s = applyHysteresis(applyHysteresis(initialLabelState(), ev("normal")), ev("lelah"));
    s = applyHysteresis(s, ev("lelah ringan"));
    expect(s.shown?.label).toBe("lelah ringan");
    // Two "lelah" in a row still show "lelah".
    s = applyHysteresis(applyHysteresis(initialLabelState(), ev("normal")), ev("lelah"));
    s = applyHysteresis(s, ev("lelah"));
    expect(s.shown?.label).toBe("lelah");
  });

  it("keeps hysteresis between lelah ringan and lelah once one of them is shown", () => {
    // Negative control: one lighter evaluation must not pull "lelah" down.
    let s = applyHysteresis(initialLabelState(), ev("lelah"));
    s = applyHysteresis(s, ev("lelah ringan"));
    expect(s.shown?.label).toBe("lelah");
    s = applyHysteresis(s, ev("lelah"));
    expect(s.shown?.label).toBe("lelah");
    // Escalating from "lelah ringan" still needs "lelah" twice in a row.
    s = applyHysteresis(initialLabelState(), ev("lelah ringan"));
    s = applyHysteresis(s, ev("lelah"));
    expect(s.shown?.label).toBe("lelah ringan");
    s = applyHysteresis(s, ev("lelah"));
    expect(s.shown?.label).toBe("lelah");
  });

  it("holds the label when the window has fewer than 3 frames per second", () => {
    const prev = applyHysteresis(initialLabelState(), ev("normal"));
    // Hidden tab: ±1 fps and one closed frame in ten would read as tired.
    const hidden = { ...calm, n_frame: 20, durasi_jendela_detik: 20, perclos: 0.1 };
    const { state, latest, hold } = evaluate(hidden, BASELINE, prev);
    expect(latest).toBeNull();
    expect(state).toBe(prev);
    expect(hold).toContain("Monitoring paused");
    // Negative control: power saving (±5 fps) is still judged.
    const saving = evaluate({ ...hidden, n_frame: 100 }, BASELINE, prev);
    expect(saving.latest?.label).toBe("lelah ringan");
    expect(saving.hold).toBeNull();
  });

  it("evaluate() leaves the state alone when there is nothing to classify", () => {
    const prev = applyHysteresis(initialLabelState(), ev("lelah"));
    const { state, latest } = evaluate(calm, null, prev);
    expect(latest).toBeNull();
    expect(state).toBe(prev);
  });
});

describe("rules + blink pattern (?label=gabungan, D-72)", () => {
  const drowsyPattern = { chance: 0.8, n: 30 };

  it("raises normal to lelah ringan from the threshold, with pola_kedip as the only sign", () => {
    const normal = classify(calm, BASELINE);
    expect(withBlinkPattern(normal, { chance: 0.7, n: 30 })).toBe(normal);
    const raised = withBlinkPattern(normal, { chance: BLINK_PATTERN_THRESHOLD, n: 30 });
    expect(raised).toMatchObject({ label: "lelah ringan", skor: 0.25, poin: 1, tanda: ["pola_kedip"] });
    expect(raised?.alasan).toEqual(["Your last 30 blinks look like a drowsy blink pattern: score 71% (limit 71%)."]);
    expect(BLINK_PATTERN_THRESHOLD).toBe(0.71);
  });

  it("never changes a label the rules set, a held window, or a window without a score", () => {
    for (const f of [{ menguap: 1 }, { perclos: 0.2 }, { pct_wajah_hilang: 0.8 }]) {
      const rules = classify({ ...calm, ...f }, BASELINE);
      expect(rules?.label).not.toBe("normal");
      expect(withBlinkPattern(rules, drowsyPattern)).toBe(rules);
    }
    expect(withBlinkPattern(null, drowsyPattern)).toBeNull();
    const normal = classify(calm, BASELINE);
    expect(withBlinkPattern(normal, null)).toBe(normal);
  });

  it("evaluate() reads the pattern only when given one, so the default stays the rules", () => {
    expect(evaluate(calm, BASELINE, initialLabelState()).latest?.label).toBe("normal");
    expect(evaluate(calm, BASELINE, initialLabelState(), null, drowsyPattern).latest?.tanda).toEqual(["pola_kedip"]);
  });
});
