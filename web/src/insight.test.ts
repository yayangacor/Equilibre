import { describe, expect, it } from "vitest";
import { dayKey, summarizeDay, type BreakRecord, type DayData, type EvaluationRecord } from "./history.ts";
import {
  bucketFor,
  dayTiles,
  formatDuration,
  insightSentences,
  levelSeries,
  normalShare,
  peakFatigueHour,
} from "./insight.ts";
import type { Label } from "./rules.ts";

const at = (h: number, min: number, s = 0) => new Date(2026, 9, 1, h, min, s).getTime();
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
// n evaluations 10 s apart from t
const run = (t: number, label: Label, n: number, extra: Partial<EvaluationRecord> = {}) =>
  Array.from({ length: n }, (_, i) => ev(t + i * 10_000, label, extra));
const empty: DayData = { evaluasi: [], jeda: [], rekomendasi: [], koreksi_label: [], kss: [] };
const summary = (data: Partial<DayData>) => summarizeDay({ ...empty, ...data }, 10_000);
const pause = (mulai: number, menit: number): BreakRecord => ({
  hari: dayKey(mulai),
  sesi: 1,
  mulai,
  selesai: mulai + menit * 60_000,
  menit,
  pemicu: "kamera",
});

describe("levelSeries", () => {
  it("averages the labels at the screen per bucket, normal 0 to tertidur 3", () => {
    const points = levelSeries([...run(at(9, 0), "normal", 3), ...run(at(9, 0, 30), "lelah", 3), ...run(at(9, 1), "tertidur", 6)], 60_000);
    expect(points).toHaveLength(2);
    expect(points[0]).toMatchObject({ t: at(9, 0), level: 1, n: 6 });
    expect(points[1]).toMatchObject({ t: at(9, 1), level: 3, label: "tertidur" });
  });

  it("breaks the line where nothing was judged or the user was away", () => {
    const points = levelSeries(
      [
        ...run(at(9, 0), "normal", 6),
        ...run(at(9, 1), "lelah", 6, { dinilai: false, sebab_ditahan: "fps", label_mentah: null }), // not judged
        ...run(at(9, 2), "tidak di depan layar", 6),
        ...run(at(9, 4), "lelah ringan", 6),
      ],
      60_000,
    );
    expect(points.map((p) => p.level)).toEqual([0, null, null, null, 1]);
    expect(points[2].label).toBe("tidak di depan layar");
    expect(points[3]).toMatchObject({ label: null, n: 0 }); // 09:03: no evaluation at all
  });

  it("names the bucket after the label shown most, the heavier one on a tie", () => {
    const [tie] = levelSeries([...run(at(9, 0), "normal", 3), ...run(at(9, 0, 30), "lelah ringan", 3)], 60_000);
    expect(tie.label).toBe("lelah ringan");
    const [most] = levelSeries([...run(at(9, 0), "normal", 4), ...run(at(9, 0, 40), "lelah", 2)], 60_000);
    expect(most.label).toBe("normal");
  });

  it("is empty without a judged evaluation (control: one judged record gives a point)", () => {
    expect(levelSeries(run(at(9, 0), "normal", 3, { dinilai: false, sebab_ditahan: "mata", label_mentah: null }), 60_000)).toEqual([]);
    expect(levelSeries(run(at(9, 0), "normal", 1), 60_000)).toHaveLength(1);
  });
});

describe("bucketFor", () => {
  it("widens the bucket for longer days", () => {
    expect(bucketFor(2 * 3_600_000)).toBe(60_000);
    expect(bucketFor(2 * 3_600_000 + 1)).toBe(300_000);
    expect(bucketFor(9 * 3_600_000)).toBe(600_000);
  });
});

describe("formatDuration", () => {
  it("reads in hours and minutes", () => {
    expect(formatDuration(0)).toBe("0 mnt");
    expect(formatDuration(0.2)).toBe("< 1 mnt");
    expect(formatDuration(44.6)).toBe("45 mnt");
    expect(formatDuration(65)).toBe("1 jam 5 mnt");
    expect(formatDuration(180)).toBe("3 jam");
  });
});

describe("day sentences and tiles", () => {
  it("states the normal share of the time at the screen, the peak fatigue hour and the breaks", () => {
    const s = summary({
      evaluasi: [
        ...run(at(9, 0), "normal", 6 * 30), // 30 min normal at 09
        ...run(at(14, 0), "lelah ringan", 6 * 6), // 6 min at 14
        ...run(at(14, 10), "lelah", 6 * 4), // 4 min at 14
        ...run(at(15, 0), "lelah ringan", 6 * 2), // 2 min at 15
        ...run(at(15, 30), "tidak di depan layar", 6 * 8), // away: not part of the share
      ],
      jeda: [pause(at(12, 0), 20), pause(at(15, 30), 8)],
    });
    expect(normalShare(s)).toBeCloseTo(30 / 42);
    expect(peakFatigueHour(s)).toEqual({ jam: 14, menit: expect.closeTo(10) });
    expect(insightSentences(s)).toEqual([
      "Dari 42 mnt di depan layar, kamu dalam kondisi normal 71% dari waktu itu.",
      "Tanda lelah tampil 12 mnt, paling banyak pukul 14.00–15.00.",
      "Kamu jeda 2× dengan total 28 mnt.",
    ]);
  });

  it("says so when there is nothing to judge or no fatigue", () => {
    expect(insightSentences(summary({}))).toEqual([
      "Belum ada waktu di depan layar yang dinilai.",
      "Belum ada jeda 2 menit atau lebih yang tercatat.",
    ]);
    const calm = summary({ evaluasi: run(at(9, 0), "normal", 12) });
    expect(insightSentences(calm)[1]).toBe("Tidak ada tanda lelah yang tercatat.");
    expect(peakFatigueHour(calm)).toBeNull();
  });

  it("fills four tiles, with a dash for what is missing", () => {
    const tiles = dayTiles(
      summary({
        evaluasi: [...run(at(9, 0), "normal", 6 * 10), ...run(at(9, 10), "normal", 6, { dinilai: false, sebab_ditahan: "fps", label_mentah: null })],
      }),
    );
    expect(tiles.map((t) => t.value)).toEqual(["11 mnt", "100%", "0×", "–"]);
    expect(tiles[0].sub).toBe("1 sesi · 1 mnt tidak dinilai");
    expect(tiles[3].sub).toBe("belum diisi");
  });
});
