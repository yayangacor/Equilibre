import { describe, expect, it } from "vitest";
import { dayKey, type BreakRecord, type DayData, type EvaluationRecord } from "../history.ts";
import type { Label, Tanda } from "../rules.ts";
import {
  blockSizeFor,
  buildBlocks,
  buildDaily,
  buildHeatmap,
  clusterCells,
  dayLabel,
  dominantState,
  essayFacts,
  essaySteps,
  formatDuration,
  formatShare,
  groupBlocks,
  heatBin,
  noMinutes,
  partOf,
  sliceRange,
  stepText,
  summaryLine,
  totalsOf,
} from "./model.ts";

const EVAL_MS = 10_000;
const EACH = EVAL_MS / 60_000;
// Thursday 29 Oct 2026, 18:00 local: "now" in every test.
const NOW = new Date(2026, 9, 29, 18, 0).getTime();
const at = (daysAgo: number, hour: number, minute = 0, second = 0) =>
  new Date(2026, 9, 29 - daysAgo, hour, minute, second).getTime();

function rec(t: number, label: Label, opts: { dinilai?: boolean; tanda?: Tanda[]; sesi?: number } = {}): EvaluationRecord {
  return {
    hari: dayKey(t),
    sesi: opts.sesi ?? 1,
    t,
    label,
    skor: 0,
    tanda: opts.tanda ?? [],
    mata_tertutup_lama: 0,
    menguap: 0,
    menit_sejak_jeda: 0,
    menit_lelah_60: 0,
    dinilai: opts.dinilai ?? true,
    sebab_ditahan: opts.dinilai === false ? "mata" : null,
    label_mentah: opts.dinilai === false ? null : label,
    poin: 0,
    hemat_daya: false,
  };
}

// `minutes` of one label from `start`, one evaluation every 10 s.
function run(start: number, minutes: number, label: Label, opts: Parameters<typeof rec>[2] = {}): EvaluationRecord[] {
  return Array.from({ length: Math.round(minutes * 6) }, (_, i) => rec(start + i * EVAL_MS, label, opts));
}

function brk(start: number, minutes: number, sesi = 1): BreakRecord {
  return { hari: dayKey(start), sesi, mulai: start, selesai: start + minutes * 60_000, menit: minutes, pemicu: "kamera" };
}

const data = (evaluasi: EvaluationRecord[], jeda: BreakRecord[] = []): DayData => ({
  evaluasi,
  jeda,
  rekomendasi: [],
  koreksi_label: [],
  kss: [],
});

describe("formatting", () => {
  it("writes durations as h and zero-padded min", () => {
    expect(formatDuration(0)).toBe("0 min");
    expect(formatDuration(0.2)).toBe("< 1 min");
    expect(formatDuration(45)).toBe("45 min");
    expect(formatDuration(60)).toBe("1 h 00 min");
    expect(formatDuration(185)).toBe("3 h 05 min");
    expect(formatDuration(1880)).toBe("31 h 20 min");
  });

  it("rounds shares and never shows a tiny share as 0%", () => {
    expect(formatShare(0.744)).toBe("74%");
    expect(formatShare(0.001)).toBe("<1%");
    expect(formatShare(0)).toBe("0%");
  });

  it("names days in English", () => {
    expect(dayLabel("2026-10-27", "short")).toBe("Tue 27");
    expect(dayLabel("2026-10-27", "medium")).toBe("Tue 27 Oct");
    expect(dayLabel("2026-10-27", "long")).toBe("Tuesday 27 Oct");
  });

  it("splits the day at 11, 14 and 17", () => {
    expect([10, 11, 13, 14, 16, 17, 23].map(partOf)).toEqual([
      "morning",
      "midday",
      "midday",
      "afternoon",
      "afternoon",
      "evening",
      "evening",
    ]);
  });
});

describe("sliceRange", () => {
  const all = data([
    ...run(at(0, 9), 10, "normal"),
    ...run(at(8, 9), 10, "normal"),
    ...run(at(0, 10), 10, "lelah", { dinilai: false }),
  ]);

  it("keeps the judged records of the range only", () => {
    const today = sliceRange(all, "today", NOW, EVAL_MS);
    expect(today.days).toEqual(["2026-10-29"]);
    expect(today.judged).toHaveLength(60);
    expect(sliceRange(all, "7d", NOW, EVAL_MS).judged).toHaveLength(60);
    expect(sliceRange(all, "7d", NOW, EVAL_MS).days).toHaveLength(7);
    expect(sliceRange(all, "30d", NOW, EVAL_MS).judged).toHaveLength(120);
  });

  it("copes with no history at all", () => {
    const slice = sliceRange(null, "7d", NOW, EVAL_MS);
    expect(slice.judged).toEqual([]);
    expect(essaySteps(essayFacts(slice, 15))).toEqual([]);
    expect(buildHeatmap(slice)).toEqual({ hours: [], rows: [] });
    expect(buildDaily(slice)).toEqual([]);
  });
});

describe("blocks", () => {
  it("cuts judged time into 15-minute blocks with the dominant state", () => {
    const judged = [...run(at(0, 9, 0), 9, "normal"), ...run(at(0, 9, 9), 5, "lelah", { tanda: ["kedipan_lambat"] })];
    const blocks = buildBlocks(judged, EACH, 15);
    expect(blocks.map((b) => b.key)).toEqual(["2026-10-29|540"]); // 09:00, the 14 minutes fit one block
    const b = blocks[0];
    expect(b.total).toBeCloseTo(14);
    expect(b.minutes.lelah).toBeCloseTo(5);
    expect(b.state).toBe("normal");
    expect(b.part).toBe("morning");
    expect(b.signs).toEqual([{ tanda: "kedipan_lambat", count: 30 }]);
  });

  it("gives a tie to the heavier state", () => {
    const m = noMinutes();
    m.normal = 5;
    m.lelah = 5;
    expect(dominantState(m)).toBe("lelah");
    expect(dominantState(noMinutes())).toBeNull();
  });

  it("widens the blocks when there would be too many bubbles", () => {
    const judged = run(at(0, 8), 120, "normal"); // 8 blocks of 15 min, 4 of 30, 2 of 60
    expect(blockSizeFor(judged, 700)).toBe(15);
    expect(blockSizeFor(judged, 4)).toBe(30);
    expect(blockSizeFor(judged, 2)).toBe(60);
    expect(buildBlocks(judged, EACH, 30)).toHaveLength(4);
  });

  it("groups the same bubbles by state, time of day and day without losing minutes", () => {
    const judged = [
      ...run(at(1, 10, 45), 30, "normal"), // 10:45–11:15 crosses into midday
      ...run(at(1, 14), 30, "lelah"),
      ...run(at(0, 17), 15, "tidak di depan layar"),
    ];
    const blocks = buildBlocks(judged, EACH, 15);
    for (const mode of ["all", "state", "time", "day"] as const) {
      const total = groupBlocks(blocks, mode).reduce((s, c) => s + c.total, 0);
      expect(total).toBeCloseTo(75);
    }
    expect(groupBlocks(blocks, "state").map((c) => c.label)).toEqual(["Normal", "Tired", "Away"]);
    expect(groupBlocks(blocks, "time").map((c) => c.key)).toEqual(["morning", "midday", "afternoon", "evening"]);
    expect(groupBlocks(blocks, "day").map((c) => c.label)).toEqual(["Wed 28", "Thu 29"]);
  });
});

describe("clusterCells", () => {
  it("lays clusters out in a grid inside the area", () => {
    const cells = clusterCells(4, 400, 400);
    expect(cells.map((c) => [c.x, c.y])).toEqual([
      [0, 0],
      [200, 0],
      [0, 200],
      [200, 200],
    ]);
    for (const c of clusterCells(7, 600, 400)) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w).toBeLessThanOrEqual(600 + 1e-6);
      expect(c.y + c.h).toBeLessThanOrEqual(400 + 1e-6);
    }
  });
});

describe("heatmap and daily totals", () => {
  const slice = sliceRange(
    data(
      [
        ...run(at(2, 14), 30, "normal"),
        ...run(at(2, 14, 30), 10, "lelah"),
        ...run(at(2, 14, 40), 20, "tidak di depan layar"),
        ...run(at(0, 9), 6, "normal"),
      ],
      [brk(at(0, 9, 30), 5)],
    ),
    "7d",
    NOW,
    EVAL_MS,
  );

  it("shares the tired minutes of the time at the screen, hours contiguous", () => {
    const hm = buildHeatmap(slice);
    expect(hm.hours).toEqual([9, 10, 11, 12, 13, 14]);
    expect(hm.rows.map((r) => r.day)).toEqual(["2026-10-27", "2026-10-28", "2026-10-29"]);
    const cell = hm.rows[0].cells[5];
    expect(cell.share).toBeCloseTo(0.25); // 10 tired of 40 at the screen; the 20 away are left out
    expect(cell.away).toBeCloseTo(20);
    expect(cell.bin).toBe(3);
    expect(hm.rows[1].cells.every((c) => c.share === null)).toBe(true); // a day with no data is empty, not 0%
    expect(hm.rows[2].cells[0].bin).toBe(0);
  });

  it("bins shares into the legend steps", () => {
    expect([0, 0.05, 0.1, 0.24, 0.25, 0.49, 0.5, 1].map(heatBin)).toEqual([0, 1, 2, 2, 3, 3, 4, 4]);
  });

  it("sums minutes and breaks per day", () => {
    const daily = buildDaily(slice);
    expect(daily.map((d) => d.day)).toEqual(["2026-10-27", "2026-10-28", "2026-10-29"]);
    expect(daily[0].minutes.normal).toBeCloseTo(30);
    expect(daily[0].atScreen).toBeCloseTo(40);
    expect(daily[0].judged).toBeCloseTo(60);
    expect(daily[1].judged).toBe(0);
    expect(daily[2].breaks).toBe(1);
  });
});

// B3 negative control: time away from the screen and evaluations that were not judged (the label carried
// over) must never read as tiredness anywhere on the page.
describe("negative control: Away and not-judged time never count as tired", () => {
  const slice = sliceRange(
    data([
      ...run(at(1, 9), 60, "normal"),
      ...run(at(1, 14), 120, "tidak di depan layar"),
      ...run(at(1, 16), 90, "lelah", { dinilai: false }),
      ...run(at(0, 9), 60, "normal"),
      ...run(at(0, 15), 60, "tertidur", { dinilai: false }),
    ]),
    "7d",
    NOW,
    EVAL_MS,
  );

  it("keeps the tired minutes at zero", () => {
    const t = totalsOf(slice);
    expect(t.minutes.lelah + t.minutes["lelah ringan"] + t.minutes.tertidur).toBe(0);
    expect(t.judged).toBeCloseTo(240);
    expect(t.atScreen).toBeCloseTo(120);
    expect(summaryLine(t)).toBe("4 h 00 min watched · 0 breaks · 100% Normal");
  });

  it("draws no tired cell, bar or bubble", () => {
    const hm = buildHeatmap(slice);
    const cells = hm.rows.flatMap((r) => r.cells);
    expect(cells.every((c) => c.share === null || c.share === 0)).toBe(true);
    expect(cells.find((c) => c.day === "2026-10-28" && c.hour === 14)?.share).toBeNull(); // only Away: no share
    for (const d of buildDaily(slice)) expect(d.minutes.lelah + d.minutes.tertidur + d.minutes["lelah ringan"]).toBe(0);
    const blocks = buildBlocks(slice.judged, slice.each, 15);
    expect(blocks.some((b) => b.state === "lelah" || b.state === "tertidur" || b.state === "lelah ringan")).toBe(false);
  });

  it("tells no story about tired moments", () => {
    const steps = essaySteps(essayFacts(slice, 15));
    const ids = steps.map((s) => s.id);
    expect(ids).not.toContain("timeOfDay");
    expect(ids).not.toContain("heaviestDay");
    expect(stepText(steps.find((s) => s.id === "share")!)).toBe(
      "Most of your screen time — 100% — was Normal. Another 2 h 00 min was time away from the screen.",
    );
  });
});

describe("essay", () => {
  // Four working days: tired in the afternoon, Tuesday the heaviest, breaks in one session 90 min apart.
  const evaluasi: EvaluationRecord[] = [];
  const jeda: BreakRecord[] = [];
  for (const daysAgo of [0, 1, 2, 3]) {
    evaluasi.push(...run(at(daysAgo, 9), 90, "normal", { sesi: daysAgo }));
    evaluasi.push(...run(at(daysAgo, 12), 60, "normal", { sesi: daysAgo }));
    evaluasi.push(...run(at(daysAgo, 14), 40, "normal", { sesi: daysAgo }));
    evaluasi.push(...run(at(daysAgo, 14, 40), 20, "lelah ringan", { sesi: daysAgo }));
    evaluasi.push(...run(at(daysAgo, 15), daysAgo === 2 ? 30 : 6, "lelah", { sesi: daysAgo, tanda: ["menguap"] }));
    jeda.push(brk(at(daysAgo, 10, 30), 10, daysAgo), brk(at(daysAgo, 12, 10), 5, daysAgo));
  }
  const slice = sliceRange(data(evaluasi, jeda), "7d", NOW, EVAL_MS);
  const steps = essaySteps(essayFacts(slice, 15));
  const text = (id: string) => stepText(steps.find((s) => s.id === id)!);

  it("tells all six steps in order, each with its chart state", () => {
    expect(steps.map((s) => [s.id, s.mode, s.highlight])).toEqual([
      ["watched", "all", null],
      ["share", "state", "normal"],
      ["timeOfDay", "time", "afternoon"],
      ["heaviestDay", "day", "2026-10-27"],
      ["breaks", "all", null],
      ["closing", "state", null],
    ]);
  });

  it("writes the numbers from the data", () => {
    // 4 days × (90 + 60 + 40 + 20) min + 6+6+6+30 min tired = 888 min at the screen
    expect(text("watched")).toBe(
      "In the last 7 days, Equilibre watched 14 h 48 min of your time, on 4 days. " +
        "Each bubble is a 15-minute stretch; the more of it was read, the bigger the bubble.",
    );
    expect(text("share")).toBe("Most of your screen time — 86% — was Normal. Mildly tired 9% and Tired 5% made up the rest.");
    expect(text("timeOfDay")).toBe(
      "Tired moments show up most in the afternoon (14:00–17:00): 44% of your screen time then, 2 h 08 min in all. " +
        "In the morning there were none.",
    );
    expect(text("heaviestDay")).toBe("Your heaviest day was Tuesday 27 Oct, with 30 min Tired or Asleep. The other days averaged 6 min.");
    expect(text("breaks")).toBe("You took 8 breaks, about 1 h 30 min apart on average.");
    expect(text("closing")).toBe("This is a pattern, not a diagnosis. It was computed on this device from 4 days of your own readings.");
  });

  it("marks numbers in the color of their state", () => {
    const share = steps.find((s) => s.id === "share")!;
    expect(share.spans.filter((s) => typeof s !== "string")).toEqual([
      { text: "86%", mark: "normal" },
      { text: "9%", mark: "lelah ringan" },
      { text: "5%", mark: "lelah" },
    ]);
  });

  it("skips the steps thin data cannot carry", () => {
    const thin = sliceRange(data([...run(at(0, 9), 15, "normal"), ...run(at(0, 9, 15), 5, "lelah")]), "today", NOW, EVAL_MS);
    const few = essaySteps(essayFacts(thin, 15));
    expect(few.map((s) => s.id)).toEqual(["watched", "share", "closing"]);
    expect(stepText(few[0])).toBe(
      "Today, Equilibre has watched 20 min of your time so far. Each bubble is a 15-minute stretch; the more of it was read, the bigger the bubble.",
    );
    expect(stepText(few[1])).toBe("Most of your screen time — 75% — was Normal. Tired 25% was the rest.");
  });

  it("says plainly when no break was seen after an hour at the screen", () => {
    const noBreak = sliceRange(data(run(at(0, 9), 70, "normal")), "today", NOW, EVAL_MS);
    expect(stepText(essaySteps(essayFacts(noBreak, 15)).find((s) => s.id === "breaks")!)).toBe(
      "No break was recorded in 1 h 10 min at the screen.",
    );
  });
});
