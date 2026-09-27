import { describe, expect, it } from "vitest";
import * as server from "../../server/src/tanya.ts";
import { summarizeDay, type DayData, type EvaluationRecord } from "./history.ts";
import type { Label } from "./rules.ts";
import { PERTANYAAN_MAX, PERTANYAAN_MIN, toHariIni, toTanyaBody, toTanyaView, type HariIni } from "./tanya.ts";

const HARI = "2026-09-27";
const ev = (label: Label, dinilai = true) =>
  ({ hari: HARI, sesi: 1, t: 0, label, dinilai, sebab_ditahan: dinilai ? null : "mata" }) as EvaluationRecord;

// 10 s per evaluation: 12 × normal = 2 min, 3 × lelah = 0.5 min, 1 held.
const day: DayData = {
  evaluasi: [...Array.from({ length: 12 }, () => ev("normal")), ev("lelah"), ev("lelah"), ev("lelah"), ev("normal", false)],
  jeda: [{ hari: HARI, sesi: 1, mulai: 0, selesai: 180_000, menit: 3, pemicu: "kamera" }],
  rekomendasi: [],
  koreksi_label: [],
  kss: [4, 5, 7].map((kss) => ({ hari: HARI, sesi: 1, t: 0, kss, label_tampil: null, pengingat: false })),
};
const summary = summarizeDay(day, 10_000);

describe("toHariIni: today's aggregate numbers only (D-44)", () => {
  it("maps the day summary, one decimal", () => {
    expect(toHariIni(summary)).toEqual({
      menit_normal: 2,
      menit_lelah_ringan: 0,
      menit_lelah: 0.5,
      menit_tertidur: 0,
      menit_tidak_di_depan_layar: 0,
      jumlah_jeda: 1,
      kss_rata_rata: 5.3,
    });
  });

  it("is null when nothing was monitored today, and has no KSS average without ratings", () => {
    expect(toHariIni(null)).toBeNull();
    expect(toHariIni(summarizeDay({ ...day, evaluasi: [] }, 10_000))).toBeNull();
    expect(toHariIni(summarizeDay({ ...day, kss: [] }, 10_000))?.kss_rata_rata).toBeNull();
  });

  it("uses the same field names and limits as the server whitelist", () => {
    const keys: (keyof HariIni)[] = Object.keys(toHariIni(summary)!) as (keyof HariIni)[];
    expect(keys.sort()).toEqual(Object.keys(server.HARI_INI_FIELDS).sort());
    expect([PERTANYAAN_MIN, PERTANYAAN_MAX]).toEqual([server.PERTANYAAN_MIN, server.PERTANYAAN_MAX]);
  });
});

describe("toTanyaBody", () => {
  it("builds a body the server accepts, with the status derived there", () => {
    const body = toTanyaBody("  Gimana kondisiku hari ini? ", "lelah", 17.26, summary);
    expect(body).toEqual({ pertanyaan: "Gimana kondisiku hari ini?", label: "lelah", menit_lelah_60: 17.3, hari_ini: toHariIni(summary) });
    const parsed = server.parseTanya(JSON.parse(JSON.stringify(body)));
    expect(parsed.ok && parsed.value.status).toBe("perlu istirahat panjang");
  });

  it("leaves out what is not known: no label before calibration, no history yet", () => {
    const body = toTanyaBody("Kenapa harus minum air?", null, 3, null);
    expect(body).toEqual({ pertanyaan: "Kenapa harus minum air?" });
    expect(server.parseTanya(body).ok).toBe(true);
  });
});

describe("toTanyaView", () => {
  it("titles the cited notes and says who answered", () => {
    const view = toTanyaView({
      jawaban: "Istirahatkan matamu tiap 20 menit.",
      sumber: ["aao-20-20-20.md", "karangan.md"],
      format_bebas: false,
      tool_calls: 1,
      biaya: 0.0139,
      detik: 21.4,
    });
    expect(view.sumber.map((s) => s.known)).toEqual([true, false]);
    expect(view.catatan).toEqual(["Dijawab IBM Bob dalam 21,4 detik, 1 panggilan flow Langflow."]);
  });

  it("marks an answer that was not in the asked-for format", () => {
    const view = toTanyaView({ jawaban: "**Halo**", sumber: [], format_bebas: true, tool_calls: null, biaya: null, detik: 3 });
    expect(view.catatan).toHaveLength(2);
    expect(view.catatan[0]).toBe("Dijawab IBM Bob dalam 3 detik.");
  });
});
