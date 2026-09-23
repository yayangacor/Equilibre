import { describe, expect, it } from "vitest";
import type { WindowFeatures } from "./features.ts";
import {
  dayKey,
  oldestKeptDay,
  summarizeDay,
  toBreakRecord,
  toEvaluationRecord,
  type DayData,
  type EvaluationRecord,
  type RecommendationRecord,
} from "./history.ts";
import type { Evaluation, Label } from "./rules.ts";

const local = (y: number, month: number, d: number, h = 0, min = 0) => new Date(y, month - 1, d, h, min).getTime();

const features = (n_frame: number, seconds: number): WindowFeatures => ({
  perclos: 0.0512,
  kedip_per_menit: 14.26,
  durasi_kedip_ms: 231.4,
  mata_tertutup_lama: 0,
  menguap: 0,
  pct_kepala_menunduk: 0.1,
  pct_wajah_hilang: 0,
  pct_mata_terbuka: 0.95,
  pct_mata_tertutup: 0.02,
  pct_tubuh_ada: 1,
  pct_tubuh_utuh: 1,
  pct_tubuh_diam: 0.5,
  gerak_tubuh: 0.02,
  n_frame,
  durasi_jendela_detik: seconds,
});
const shown: Evaluation = { label: "lelah ringan", skor: 0.25, poin: 1, alasan: ["Menguap 1× …"], catatan: [] };
const context = { t: local(2026, 9, 23, 14, 5), sesi: local(2026, 9, 23, 13, 0), menitSejakJeda: 42.4, hematDaya: true };

describe("dayKey / oldestKeptDay", () => {
  it("uses the local calendar day", () => {
    expect(dayKey(local(2026, 9, 23, 0, 0))).toBe("2026-09-23");
    expect(dayKey(local(2026, 9, 23, 23, 59))).toBe("2026-09-23");
    expect(dayKey(local(2026, 10, 1, 8))).toBe("2026-10-01");
  });

  it("keeps today and the 30 days before it, and nothing older", () => {
    const cutoff = oldestKeptDay(local(2026, 9, 23, 10));
    expect(cutoff).toBe("2026-08-24");
    // The database deletes hari < cutoff (IDBKeyRange.upperBound(cutoff, true)), a text comparison.
    const days = ["2026-08-23", "2026-08-24", "2026-08-25", "2026-09-23"];
    expect(days.filter((d) => d < cutoff)).toEqual(["2026-08-23"]); // 31 days old: deleted; 30 and 29: kept
  });
});

describe("toEvaluationRecord", () => {
  it("stores the payload of that moment with the local context", () => {
    const latest: Evaluation = { ...shown, label: "normal", skor: 0, poin: 0, alasan: [] };
    const record = toEvaluationRecord(shown, { features: features(200, 20), latest, hold: null, menitLelah: 3.14 }, context);
    expect(record).toEqual({
      label: "lelah ringan",
      skor: 0.25,
      perclos: 0.051,
      kedip_per_menit: 14.3,
      durasi_kedip_ms: 231,
      mata_tertutup_lama: 0,
      menguap: 0,
      pct_kepala_menunduk: 0.1,
      pct_wajah_hilang: 0,
      menit_sejak_jeda: 42,
      menit_lelah_60: 3.1,
      t: context.t,
      hari: "2026-09-23",
      sesi: context.sesi,
      dinilai: true,
      sebab_ditahan: null,
      label_mentah: "normal", // the raw label of this window; the shown one waits for confirmation
      poin: 1,
      hemat_daya: true,
    });
    expect(record).not.toHaveProperty("id"); // IndexedDB assigns it
  });

  it("marks windows that were not judged, and why", () => {
    const hidden = { features: features(20, 20), latest: null, hold: "Kamera hanya terbaca ±1 fps …", menitLelah: 0 };
    expect(toEvaluationRecord(shown, hidden, context)).toMatchObject({ dinilai: false, sebab_ditahan: "fps", label_mentah: null });

    const headDown = { features: features(200, 20), latest: null, hold: "Mata tidak terlihat 80% …", menitLelah: 0 };
    expect(toEvaluationRecord(shown, headDown, context)).toMatchObject({ dinilai: false, sebab_ditahan: "mata" });

    // Negative control: ±5 fps (power saving) is not a hidden tab, so a hold there is the eyes.
    const saving = { features: features(100, 20), latest: null, hold: "Mata tidak terlihat 80% …", menitLelah: 0 };
    expect(toEvaluationRecord(shown, saving, context)).toMatchObject({ dinilai: false, sebab_ditahan: "mata" });
  });
});

describe("summarizeDay", () => {
  const at = (h: number, min: number, s = 0) => local(2026, 9, 23, h, min) + s * 1000;
  const ev = (t: number, label: Label, extra: Partial<EvaluationRecord> = {}): EvaluationRecord => ({
    label,
    skor: 0,
    mata_tertutup_lama: 0,
    menguap: 0,
    menit_sejak_jeda: 0,
    menit_lelah_60: 0,
    t,
    hari: dayKey(t),
    sesi: 1,
    dinilai: true,
    sebab_ditahan: null,
    label_mentah: label,
    poin: 0,
    hemat_daya: false,
    ...extra,
  });
  const empty: DayData = { evaluasi: [], jeda: [], rekomendasi: [], koreksi_label: [], kss: [] };
  const held = (cause: "fps" | "mata") => ({ dinilai: false, sebab_ditahan: cause, label_mentah: null });

  it("counts each judged evaluation as 10 seconds of its shown label, hour by hour", () => {
    const evaluasi = [
      ...Array.from({ length: 6 }, (_, i) => ev(at(9, 0, i * 10), "normal")), // 1 minute at 09
      ...Array.from({ length: 3 }, (_, i) => ev(at(11, 30, i * 10), "lelah")), // 30 s at 11
      ev(at(11, 31), "lelah", held("fps")),
      ev(at(11, 32), "normal", held("mata")),
      ev(at(11, 33), "tidak di depan layar"),
    ];
    const s = summarizeDay({ ...empty, evaluasi }, 10_000);
    expect(s.menit.normal).toBeCloseTo(1);
    expect(s.menit.lelah).toBeCloseTo(0.5);
    expect(s.menit["tidak di depan layar"]).toBeCloseTo(1 / 6);
    // Negative control: held windows never count toward the label they carried over.
    expect(s.ditahan.fps).toBeCloseTo(1 / 6);
    expect(s.ditahan.mata).toBeCloseTo(1 / 6);
    expect(s.ditahan.lain).toBe(0);
    expect(s.perJam.map((h) => h.jam)).toEqual([9, 10, 11]); // the hour without data is there, as zeros
    expect(s.perJam[1].menit.normal).toBe(0);
    expect(s.perJam[2].menit.lelah).toBeCloseTo(0.5);
    expect(s.perJam[2].ditahan).toBeCloseTo(2 / 6);
  });

  it("does not count the time between evaluations (page closed) as monitored", () => {
    const s = summarizeDay({ ...empty, evaluasi: [ev(at(9, 0), "normal"), ev(at(13, 0), "normal")] }, 10_000);
    expect(s.menit.normal).toBeCloseTo(2 / 6); // 2 × 10 s, not 4 hours
    expect(s.perJam).toHaveLength(5);
  });

  it("sums breaks, recommendation feedback, corrections, KSS and sessions", () => {
    const rec = (feedback: RecommendationRecord["feedback"], pemicu: RecommendationRecord["pemicu"]): RecommendationRecord => ({
      hari: "2026-09-23",
      sesi: 1,
      t: at(10, 0),
      pemicu,
      label: "lelah",
      status: "perlu jeda",
      hasil: null,
      teks: "",
      feedback,
      t_feedback: null,
    });
    const s = summarizeDay(
      {
        evaluasi: [ev(at(9, 0), "normal"), ev(at(10, 0), "normal", { sesi: 2 })],
        jeda: [
          { hari: "2026-09-23", sesi: 1, mulai: 0, selesai: 150_000, menit: 2.5 },
          { hari: "2026-09-23", sesi: 1, mulai: 0, selesai: 600_000, menit: 10 },
        ],
        rekomendasi: [rec("sudah dilakukan", "otomatis"), rec("tidak relevan", "manual"), rec(null, "otomatis")],
        koreksi_label: [{ hari: "2026-09-23", sesi: 1, t: at(10, 0), label_tampil: "lelah", label_koreksi: "normal", skor: 0.75, alasan: [] }],
        kss: [3, 6, 9].map((kss) => ({ hari: "2026-09-23", sesi: 1, t: at(10, 0), kss, label_tampil: "normal" as Label, pengingat: false })),
      },
      10_000,
    );
    expect(s.sesi).toBe(2);
    expect(s.jeda).toEqual({ jumlah: 2, menit: 12.5 });
    expect(s.rekomendasi).toEqual({ jumlah: 3, otomatis: 2, sudahDilakukan: 1, tidakRelevan: 1, belum: 1 });
    expect(s.koreksi).toBe(1);
    expect(s.kss).toEqual({ jumlah: 3, rataRata: 6 });
  });

  it("returns an empty day without NaN or Infinity", () => {
    const s = summarizeDay(empty, 10_000);
    expect(s.perJam).toEqual([]);
    expect(s.sesi).toBe(0);
    expect(s.kss.rataRata).toBeNull();
    expect(s.menit.normal).toBe(0);
  });
});

describe("toBreakRecord", () => {
  it("files the break under the day it started, in minutes", () => {
    const b = toBreakRecord({ mulai: local(2026, 9, 23, 23, 58), selesai: local(2026, 9, 24, 0, 5) }, 1);
    expect(b).toEqual({ hari: "2026-09-23", sesi: 1, mulai: b.mulai, selesai: b.selesai, menit: 7 });
    expect(toBreakRecord({ mulai: 0, selesai: 150_000 }, 1).menit).toBe(2.5);
  });
});
