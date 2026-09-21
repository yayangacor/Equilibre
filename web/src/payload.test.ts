import { describe, expect, it } from "vitest";
import { parseFeatures } from "../../server/src/features.ts";
import type { WindowFeatures } from "./features.ts";
import { toAnalyzePayload } from "./payload.ts";
import type { Evaluation } from "./rules.ts";

const evaluation: Evaluation = { label: "lelah", skor: 0.754321, poin: 2, alasan: ["Mata tertutup 18% …"], catatan: [] };
const features: WindowFeatures = {
  perclos: 0.18234,
  kedip_per_menit: 9.87,
  durasi_kedip_ms: 312.4,
  mata_tertutup_lama: 1,
  menguap: 2,
  pct_kepala_menunduk: 0.3333,
  pct_wajah_hilang: 0.05,
  pct_mata_terbuka: 0.81,
  pct_mata_tertutup: 0.14,
  pct_tubuh_ada: 1,
  pct_tubuh_utuh: 1,
  pct_tubuh_diam: 0.4,
  gerak_tubuh: 0.02,
  n_frame: 598,
  durasi_jendela_detik: 59.9,
};

describe("toAnalyzePayload", () => {
  it("passes the server whitelist (field names must match exactly)", () => {
    const payload = toAnalyzePayload(evaluation, features, 95.4);
    expect(parseFeatures(payload)).toEqual({ ok: true, value: payload });
    expect(payload).toEqual({
      label: "lelah",
      skor: 0.75,
      perclos: 0.182,
      kedip_per_menit: 9.9,
      durasi_kedip_ms: 312,
      mata_tertutup_lama: 1,
      menguap: 2,
      pct_kepala_menunduk: 0.333,
      pct_wajah_hilang: 0.05,
      menit_sejak_jeda: 95,
    });
  });

  it("never sends reasons, frame counts or raw signals", () => {
    const payload = toAnalyzePayload(evaluation, features, 1);
    expect(Object.keys(payload)).not.toContain("alasan");
    expect(Object.keys(payload)).not.toContain("n_frame");
    // Body numbers only steer the label locally.
    expect(Object.keys(payload)).not.toContain("pct_tubuh_ada");
    expect(Object.keys(payload)).not.toContain("gerak_tubuh");
  });

  it("omits missing values and clamps to the server ranges", () => {
    const payload = toAnalyzePayload(
      evaluation,
      { ...features, perclos: null, durasi_kedip_ms: null, kedip_per_menit: 250 },
      5000,
    );
    expect(payload).not.toHaveProperty("perclos");
    expect(payload).not.toHaveProperty("durasi_kedip_ms");
    expect(payload.kedip_per_menit).toBe(200);
    expect(payload.menit_sejak_jeda).toBe(1440);
    expect(parseFeatures(payload).ok).toBe(true);
  });
});
