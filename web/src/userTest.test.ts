import { describe, expect, it } from "vitest";
import type { Baseline, KeyValueStore } from "./calibration.ts";
import type { BreakRecord, EvaluationRecord, KssRecord, LabelCorrectionRecord } from "./history.ts";
import {
  BREAK_KEYS,
  browserOf,
  calibrated,
  canFinishEarly,
  checkFeedback,
  checkIntake,
  consent,
  CORRECTION_KEYS,
  elapsedMinutes,
  EVALUATION_KEYS,
  finish,
  freshState,
  KSS_KEYS,
  loadTestState,
  markSent,
  osOf,
  parseCode,
  phase,
  postSubmission,
  saveTestState,
  SEND_ATTEMPTS,
  sendWithRetry,
  SUBMISSION_KEYS,
  testDbSuffix,
  toSubmission,
  withSubmissionId,
  type TestState,
} from "./userTest.ts";

const ID = "3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 6, 6, 0, 0); // consent
const START = T0 + 7 * MIN; // calibration done

const intake = checkIntake({ kacamata: "ya", kamera: "bawaan", cahaya: "terang", dahi_tertutup: "tidak" }, "7");
const running = (): TestState => calibrated(consent(freshState("EQ-7K2M"), intake, T0), START);

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const feedback = checkFeedback(
  { label_sesuai: 4, alarm_palsu: "1-2 kali", kantuk_terlewat: "tidak mengantuk", mengganggu: 2, mau_pakai: 4 },
  "  oke  ",
)!;

describe("test code", () => {
  it("accepts EQ- plus 4 to 8 letters or digits, case-insensitive", () => {
    expect(parseCode("EQ-7K2M")).toBe("EQ-7K2M");
    expect(parseCode(" eq-ab12cd34 ")).toBe("EQ-AB12CD34");
    expect(testDbSuffix("EQ-7K2M")).toBe("uji-eq-7k2m");
  });

  it("rejects anything else (negative control)", () => {
    for (const bad of [null, "", "7K2M", "EQ-12", "EQ-123456789", "EQ-7K2M;drop", "XQ-7K2M", "EQ_7K2M"]) {
      expect(parseCode(bad)).toBeNull();
    }
  });
});

describe("test phases", () => {
  it("goes consent → calibration → running → feedback → sent", () => {
    const fresh = freshState("EQ-7K2M");
    expect(phase(fresh, T0)).toBe("persetujuan");
    const agreed = consent(fresh, intake, T0);
    expect(phase(agreed, T0 + MIN)).toBe("kalibrasi");
    const s = calibrated(agreed, START);
    expect(phase(s, START + 59 * MIN)).toBe("berjalan");
    expect(phase(s, START + 60 * MIN)).toBe("feedback");
    expect(phase(markSent(finish(s, START + 61 * MIN), "abc", START + 62 * MIN, false), START + 62 * MIN)).toBe("terkirim");
  });

  it("ignores a calibration before consent, and a second one", () => {
    const fresh = freshState("EQ-7K2M");
    expect(calibrated(fresh, START)).toBe(fresh);
    const s = running();
    expect(calibrated(s, START + 10 * MIN)).toBe(s);
  });

  it("allows an early finish from minute 30 only", () => {
    const s = running();
    expect(canFinishEarly(s, START + 29 * MIN)).toBe(false);
    expect(finish(s, START + 29 * MIN)).toBe(s);
    expect(canFinishEarly(s, START + 30 * MIN)).toBe(true);
    const early = finish(s, START + 35 * MIN);
    expect(early).toMatchObject({ selesai: START + 35 * MIN, selesai_awal: true });
    expect(phase(early, START + 36 * MIN)).toBe("feedback");
  });

  it("ends a full test at exactly 60 minutes, however late the form opens", () => {
    const late = finish(running(), START + 3 * 60 * MIN);
    expect(late).toMatchObject({ selesai: START + 60 * MIN, selesai_awal: false });
    expect(elapsedMinutes(late, START + 3 * 60 * MIN)).toBe(60);
    expect(elapsedMinutes(running(), START + 12.5 * MIN)).toBe(12.5);
  });

  it("survives a reload through storage, and starts over on a foreign or broken record", () => {
    const store = memoryStore();
    const s = running();
    expect(saveTestState(store, s)).toBe(true);
    expect(loadTestState(store, "EQ-7K2M")).toEqual(s);
    expect(loadTestState(store, "EQ-OTHER")).toEqual(freshState("EQ-OTHER"));
    store.setItem("equilibre-uji-EQ-7K2M", "{not json");
    expect(loadTestState(store, "EQ-7K2M")).toEqual(freshState("EQ-7K2M"));
  });
});

describe("answers", () => {
  it("needs all five feedback answers from the listed choices", () => {
    expect(feedback).toMatchObject({ label_sesuai: 4, alarm_palsu: "1-2 kali", komentar: "oke" });
    expect(checkFeedback({ label_sesuai: 4, alarm_palsu: "1-2 kali", kantuk_terlewat: "tidak pernah", mengganggu: 2 }, "")).toBeNull();
    expect(
      checkFeedback({ label_sesuai: 6, alarm_palsu: "1-2 kali", kantuk_terlewat: "tidak pernah", mengganggu: 2, mau_pakai: 4 }, ""),
    ).toBeNull();
    expect(
      checkFeedback({ label_sesuai: 4, alarm_palsu: "kadang", kantuk_terlewat: "tidak pernah", mengganggu: 2, mau_pakai: 4 }, ""),
    ).toBeNull();
  });

  it("cuts the comment at 500 characters", () => {
    const long = checkFeedback(
      { label_sesuai: 3, alarm_palsu: "sering", kantuk_terlewat: "sering", mengganggu: 3, mau_pakai: 3 },
      "x".repeat(800),
    );
    expect(long?.komentar).toHaveLength(500);
  });

  it("keeps optional intake answers only when they are valid", () => {
    expect(intake).toEqual({ kacamata: "ya", kamera: "bawaan", cahaya: "terang", dahi_tertutup: "tidak", jam_tidur: 7 });
    expect(checkIntake({ kacamata: "mungkin" }, "7,5")).toEqual({
      kacamata: null,
      kamera: null,
      cahaya: null,
      dahi_tertutup: null,
      jam_tidur: 7.5,
    });
    expect(checkIntake({}, "30").jam_tidur).toBeNull();
    expect(checkIntake({}, "").jam_tidur).toBeNull();
  });
});

describe("submission", () => {
  const evaluation = (t: number) =>
    ({
      id: 1,
      hari: "2026-10-06",
      sesi: 5,
      t,
      label: "normal",
      label_mentah: "normal",
      dinilai: true,
      sebab_ditahan: null,
      skor: 0,
      poin: 0,
      tanda: [],
      perclos: 0.02,
      kedip_per_menit: 14,
      durasi_kedip_ms: 160,
      mata_tertutup_lama: 0,
      menguap: 0,
      menit_sejak_jeda: 3,
      menit_lelah_60: 0,
      hemat_daya: false,
      video: "must never be sent", // a field the record should not have: the whitelist drops it
    }) as unknown as EvaluationRecord;
  const kss = (t: number) => ({ id: 2, hari: "2026-10-06", sesi: 5, t, kss: 4, label_tampil: "normal", pengingat: true }) as KssRecord;
  const correction = (t: number) =>
    ({ id: 3, hari: "x", sesi: 5, t, label_tampil: "lelah ringan", label_koreksi: "normal", skor: 3, alasan: ["…"] }) as LabelCorrectionRecord;
  const breakRec = (mulai: number, selesai: number) =>
    ({ id: 4, hari: "x", sesi: 5, mulai, selesai, menit: (selesai - mulai) / MIN, pemicu: "kamera" }) as BreakRecord;
  const baseline = { earOpen: 0.31234, earClosed: 0.1, blinkPerMin: 14.04, blinkDurationMs: 151.4, createdAt: START } as Baseline;

  const done = withSubmissionId(finish(running(), START + 60 * MIN), () => ID);
  const records = {
    evaluasi: [evaluation(START - MIN), evaluation(START + MIN), evaluation(START + 60 * MIN), evaluation(START + 61 * MIN)],
    kss: [kss(START - MIN), kss(START + 15 * MIN)],
    koreksi_label: [correction(START + 20 * MIN)],
    jeda: [breakRec(START - 10 * MIN, START - 5 * MIN), breakRec(START + 30 * MIN, START + 33 * MIN)],
    rekomendasi: [{ teks: "not part of a submission" }],
  };
  const sub = toSubmission(done, feedback, records as never, {
    perangkat: { browser: "Chrome 140", os: "Windows", kamera: "640x480", fps_rata: 9.8 },
    baseline,
    now: START + 62 * MIN,
  });

  it("has exactly the listed top-level fields, and no recommendations", () => {
    expect(Object.keys(sub).sort()).toEqual([...SUBMISSION_KEYS].sort());
    expect(sub).not.toHaveProperty("rekomendasi");
    expect(sub).toMatchObject({ id_kiriman: ID, kode: "EQ-7K2M", durasi_menit: 60, selesai_awal: false, isian: intake });
    expect(sub.baseline).toEqual({ dibuat: START, kedip_per_menit: 14, durasi_kedip_ms: 151, ear_terbuka: 0.312, ear_terpejam: 0.1 });
  });

  it("keeps only records inside the test window", () => {
    expect(sub.evaluasi.map((e) => e.t)).toEqual([START + MIN, START + 60 * MIN]);
    expect(sub.kss.map((k) => k.t)).toEqual([START + 15 * MIN]);
    expect(sub.koreksi_label).toHaveLength(1);
    expect(sub.jeda.map((j) => j.mulai)).toEqual([START + 30 * MIN]);
  });

  it("sends only whitelisted record fields (no id, day key, or anything unexpected)", () => {
    const allowed = (list: readonly string[], rows: readonly object[]) =>
      rows.every((r) => Object.keys(r).every((k) => list.includes(k)));
    expect(allowed(EVALUATION_KEYS, sub.evaluasi)).toBe(true);
    expect(allowed(KSS_KEYS, sub.kss)).toBe(true);
    expect(allowed(CORRECTION_KEYS, sub.koreksi_label)).toBe(true);
    expect(allowed(BREAK_KEYS, sub.jeda)).toBe(true);
    expect(JSON.stringify(sub)).not.toContain("must never be sent");
    expect(sub.evaluasi[0]).not.toHaveProperty("id");
    expect(sub.evaluasi[0]).not.toHaveProperty("hari");
  });

  it("refuses to build a submission before the test ended, or without an id", () => {
    expect(() => toSubmission(running(), feedback, records as never, { perangkat: sub.perangkat, baseline: null, now: START })).toThrow();
    const noId = finish(running(), START + 60 * MIN);
    expect(() => toSubmission(noId, feedback, records as never, { perangkat: sub.perangkat, baseline: null, now: START })).toThrow();
  });

  it("makes the submission id once and keeps it, also through storage", () => {
    const first = withSubmissionId(done, () => "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d");
    expect(first.id_kiriman).toBe(ID);
    const store = memoryStore();
    saveTestState(store, done);
    expect(loadTestState(store, "EQ-7K2M").id_kiriman).toBe(ID);
    store.setItem("equilibre-uji-EQ-7K2M", JSON.stringify({ ...done, id_kiriman: "not-an-id" }));
    expect(loadTestState(store, "EQ-7K2M").id_kiriman).toBeNull();
  });

  const reply = (status: number, body: unknown) =>
    (async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("reads the receiver's answer", async () => {
    expect(await postSubmission("u", sub, reply(200, { ok: true, id: "abc" }))).toEqual({ ok: true, id: "abc", duplikat: false });
    expect(await postSubmission("u", sub, reply(200, { ok: true, id: "abc", duplikat: true }))).toEqual({
      ok: true,
      id: "abc",
      duplikat: true,
    });
    expect(await postSubmission("u", sub, reply(200, { ok: false, error: "Kode tidak terdaftar." }))).toEqual({
      ok: false,
      error: "Kode tidak terdaftar.",
    });
    expect(await postSubmission("u", sub, reply(200, "<html>login</html>"))).toMatchObject({ ok: false });
    expect(await postSubmission("u", sub, reply(500, { ok: true, id: "abc" }))).toMatchObject({ ok: false });
    const offline = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await postSubmission("u", sub, offline)).toMatchObject({ ok: false });
  });

  it("posts a simple text/plain request (no CORS preflight)", async () => {
    let seen: RequestInit | undefined;
    const spy = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return new Response(JSON.stringify({ ok: true, id: "x" }));
    }) as unknown as typeof fetch;
    await postSubmission("u", sub, spy);
    expect(seen?.method).toBe("POST");
    expect(seen?.headers).toEqual({ "Content-Type": "text/plain;charset=utf-8" });
    expect(JSON.parse(String(seen?.body)).kode).toBe("EQ-7K2M");
  });
});

describe("sending with retries", () => {
  const sub = toSubmission(withSubmissionId(finish(running(), START + 60 * MIN), () => ID), feedback, {
    evaluasi: [],
    kss: [],
    koreksi_label: [],
    jeda: [],
  }, { perangkat: { browser: "x", os: "x", kamera: null, fps_rata: null }, baseline: null, now: START });
  const json = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  const scripted = (...answers: Response[]) => {
    const bodies: string[] = [];
    const fn = (async (_u: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return answers.shift() ?? json("<html>404</html>", 404);
    }) as unknown as typeof fetch;
    return { fn, bodies };
  };
  const noWait = { sleep: async () => {} };

  it("tries again when the answer is lost (404, doGet answer) and stops at the first confirmation", async () => {
    const { fn, bodies } = scripted(json("<html>404</html>", 404), json({ ok: true, layanan: "equilibre-uji" }), json({ ok: true, id: ID }));
    const attempts: number[] = [];
    const result = await sendWithRetry("u", sub, { ...noWait, fetchFn: fn, onAttempt: (n) => attempts.push(n) });
    expect(result).toEqual({ ok: true, id: ID, duplikat: false });
    expect(attempts).toEqual([1, 2, 3]);
    expect(new Set(bodies.map((b) => JSON.parse(b).id_kiriman))).toEqual(new Set([ID])); // the same id every time
  });

  it("does not resend what the receiver refused (negative control)", async () => {
    const { fn, bodies } = scripted(json({ ok: false, error: "Kode uji tidak terdaftar atau sudah tidak aktif." }));
    const result = await sendWithRetry("u", sub, { ...noWait, fetchFn: fn });
    expect(result).toMatchObject({ ok: false });
    expect(bodies).toHaveLength(1);
  });

  it("gives up after the last attempt with the last error", async () => {
    const { fn, bodies } = scripted();
    const result = await sendWithRetry("u", sub, { ...noWait, fetchFn: fn });
    expect(result).toEqual({ ok: false, error: "Penerima menjawab HTTP 404." });
    expect(bodies).toHaveLength(SEND_ATTEMPTS);
  });
});

describe("device", () => {
  it("names the browser and OS coarsely", () => {
    const chromeWin =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
    const edge = `${chromeWin} Edg/140.0.0.0`;
    const safariMac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
    expect([browserOf(chromeWin), osOf(chromeWin)]).toEqual(["Chrome 140", "Windows"]);
    expect(browserOf(edge)).toBe("Edge 140");
    expect([browserOf(safariMac), osOf(safariMac)]).toEqual(["Safari 18", "macOS"]);
  });
});
