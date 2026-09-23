import { describe, expect, it } from "vitest";
import type { WindowFeatures } from "./features.ts";
import { dayKey, oldestKeptDay, toBreakRecord, toEvaluationRecord } from "./history.ts";
import type { Evaluation } from "./rules.ts";

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

describe("toBreakRecord", () => {
  it("files the break under the day it started, in minutes", () => {
    const b = toBreakRecord({ mulai: local(2026, 9, 23, 23, 58), selesai: local(2026, 9, 24, 0, 5) }, 1);
    expect(b).toEqual({ hari: "2026-09-23", sesi: 1, mulai: b.mulai, selesai: b.selesai, menit: 7 });
    expect(toBreakRecord({ mulai: 0, selesai: 150_000 }, 1).menit).toBe(2.5);
  });
});
