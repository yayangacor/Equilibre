import { describe, expect, it } from "vitest";
import {
  INTERVENTIONS,
  KNOWLEDGE_NODE_ID,
  LONG_REST,
  LONG_REST_MINUTES,
  panduanTweaks,
  PANDUAN_QUERIES,
  parseFeatures,
  TANDA as SERVER_TANDA,
  toFlowInput,
} from "../../server/src/features.ts";
import type { WindowFeatures } from "./features.ts";
import { toAnalyzePayload } from "./payload.ts";
import { ADVICE, TANDA as WEB_TANDA, type Evaluation } from "./rules.ts";

const evaluation: Evaluation = {
  label: "lelah",
  skor: 0.754321,
  poin: 2,
  alasan: ["Mata tertutup 18% …", "Menguap 2× …"],
  tanda: ["mata_sering_tertutup", "menguap"],
  catatan: [],
};
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
    const payload = toAnalyzePayload(evaluation, features, 95.4, 12.345);
    expect(parseFeatures(payload)).toEqual({ ok: true, value: payload });
    expect(payload).toEqual({
      label: "lelah",
      skor: 0.75,
      tanda: ["mata_sering_tertutup", "menguap"],
      perclos: 0.182,
      kedip_per_menit: 9.9,
      durasi_kedip_ms: 312,
      mata_tertutup_lama: 1,
      menguap: 2,
      pct_kepala_menunduk: 0.333,
      pct_wajah_hilang: 0.05,
      menit_sejak_jeda: 95,
      menit_lelah_60: 12.3,
    });
  });

  it("never sends reasons, frame counts or raw signals", () => {
    const payload = toAnalyzePayload(evaluation, features, 1, 0);
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
      75,
    );
    expect(payload).not.toHaveProperty("perclos");
    expect(payload).not.toHaveProperty("durasi_kedip_ms");
    expect(payload.kedip_per_menit).toBe(200);
    expect(payload.menit_sejak_jeda).toBe(1440);
    expect(payload.menit_lelah_60).toBe(60);
    expect(parseFeatures(payload).ok).toBe(true);
  });
});

describe("tanda: names of the rules that fired (D-41)", () => {
  it("uses the same names on the app and the server", () => {
    expect([...WEB_TANDA]).toEqual([...SERVER_TANDA]);
  });

  it("sends a copy of the evaluation's tanda", () => {
    const payload = toAnalyzePayload(evaluation, features, 1, 0);
    expect(payload.tanda).toEqual(evaluation.tanda);
    expect(payload.tanda).not.toBe(evaluation.tanda);
    expect(parseFeatures({ label: "normal", tanda: [] })).toEqual({ ok: true, value: { label: "normal", tanda: [] } });
  });

  it("rejects anything but known names without duplicates (negative control)", () => {
    for (const tanda of [["wajah pucat"], ["menguap", "menguap"], "menguap", [1], null, { 0: "menguap" }]) {
      expect(parseFeatures({ label: "lelah ringan", tanda }).ok).toBe(false);
    }
  });

  it("passes tanda on to Langflow", () => {
    expect(toFlowInput({ label: "lelah ringan", tanda: ["kedipan_lambat", "menguap"] })).toMatchObject({
      tanda: ["kedipan_lambat", "menguap"],
      status: "perlu jeda singkat",
    });
  });
});

describe("long rest advice on the server", () => {
  it("uses the same threshold as the app", () => {
    expect(LONG_REST_MINUTES).toBe(ADVICE.longRestMinutes);
  });

  it("derives the flag for Langflow from menit_lelah_60 alone", () => {
    const at = (menit: number) => toFlowInput({ label: "lelah", menit_lelah_60: menit });
    expect(at(14.9)?.saran_istirahat_panjang).toBe(false);
    expect(at(15)?.saran_istirahat_panjang).toBe(true);
    expect(toFlowInput({ label: "normal" })).not.toHaveProperty("saran_istirahat_panjang");
  });
});

describe("knowledge base query (RAG, D-39)", () => {
  it("has one fixed query for every status the server can decide", () => {
    const statuses = [...Object.values(INTERVENTIONS).map((i) => i.status), LONG_REST.status];
    expect(Object.keys(PANDUAN_QUERIES).sort()).toEqual([...statuses].sort());
    for (const q of Object.values(PANDUAN_QUERIES)) expect(q.trim().length).toBeGreaterThan(10);
  });

  it("sends only the status-derived query, never payload values", () => {
    const input = toFlowInput({ label: "tertidur", perclos: 0.42, menit_sejak_jeda: 77 })!;
    const tweaks = panduanTweaks(input.status);
    expect(tweaks).toEqual({ [KNOWLEDGE_NODE_ID]: { search_query: PANDUAN_QUERIES["perlu jeda aktif"], top_k: 3 } });
    // Negative control: no number from the payload ends up in the search query.
    expect(JSON.stringify(tweaks)).not.toMatch(/0\.42|77/);
  });
});

describe("status decided on the server", () => {
  it("maps each label to a fixed status and break length", () => {
    expect(toFlowInput({ label: "normal" })).toMatchObject({ status: "baik", durasi_jeda_menit: 0 });
    expect(toFlowInput({ label: "lelah ringan" })).toMatchObject({ status: "perlu jeda singkat", durasi_jeda_menit: 5 });
    expect(toFlowInput({ label: "lelah", menit_lelah_60: 3 })).toMatchObject({ status: "perlu jeda", durasi_jeda_menit: 10 });
    expect(toFlowInput({ label: "tertidur" })).toMatchObject({ status: "perlu jeda aktif", durasi_jeda_menit: 10 });
  });

  it("lets the long rest advice win over any label, as the app does", () => {
    for (const label of ["normal", "lelah ringan", "lelah", "tertidur"] as const) {
      expect(toFlowInput({ label, menit_lelah_60: 15 })).toMatchObject({
        status: "perlu istirahat panjang",
        durasi_jeda_menit: null,
        saran_istirahat_panjang: true,
      });
    }
    // Negative control: below the threshold nobody is told to stop working.
    expect(toFlowInput({ label: "tertidur", menit_lelah_60: 14.9 })?.status).toBe("perlu jeda aktif");
  });

  it("does not send 'tidak di depan layar' to Langflow", () => {
    expect(parseFeatures({ label: "tidak di depan layar" }).ok).toBe(true); // still a valid payload
    expect(toFlowInput({ label: "tidak di depan layar", menit_lelah_60: 30 })).toBeNull();
  });

  it("rejects menit_lelah_60 outside the hour", () => {
    expect(parseFeatures({ label: "lelah", menit_lelah_60: 61 }).ok).toBe(false);
    expect(parseFeatures({ label: "lelah", saran_istirahat_panjang: true }).ok).toBe(false); // server-side only
  });
});
