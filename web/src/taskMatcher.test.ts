import { describe, expect, it } from "vitest";
import fixturesRaw from "./taskMatcher.fixtures.json?raw";
import { PHASES } from "./phase.ts";
import {
  FIT,
  FIT_ROWS,
  matchTasks,
  PLAN,
  REASON_CODES,
  STEP_KINDS,
  URGENCY,
  WEIGHT,
  type MatchInput,
  type MatchResult,
} from "./taskMatcher.ts";
import type { AbstractTask } from "./taskTagger.ts";

type Fixture = { nama: string; masukan: MatchInput; keluaran: MatchResult };
const FIXTURES = (JSON.parse(fixturesRaw) as { kasus: Fixture[] }).kasus;

const task = (id: number, sifat: AbstractTask["sifat"], beban: AbstractTask["beban"], hari: number | null = null): AbstractTask => ({
  id: `t${id}`,
  sifat,
  beban,
  hari_ke_tenggat: hari,
  posisi: id - 1,
});

describe("Task Matcher fixtures (the reference for the Langflow component)", () => {
  it.each(FIXTURES.map((f) => [f.nama, f] as const))("%s", (_name, f) => {
    expect(matchTasks(f.masukan)).toEqual(f.keluaran);
  });

  it("cover every phase, row, step kind and reason code, so a port tested on them meets every rule", () => {
    expect(new Set(FIXTURES.map((f) => f.masukan.fase))).toEqual(new Set(PHASES));
    expect(new Set(FIXTURES.map((f) => f.keluaran.baris))).toEqual(new Set([...FIT_ROWS, null]));
    expect(new Set(FIXTURES.flatMap((f) => f.keluaran.langkah.map((s) => s.jenis)))).toEqual(new Set(STEP_KINDS));
    expect(new Set(FIXTURES.flatMap((f) => f.keluaran.kode))).toEqual(new Set(REASON_CODES));
    // The tie case is there: two equal scores, the user's order decides.
    expect(FIXTURES.some((f) => f.keluaran.skor.length > 1 && f.keluaran.skor[0].skor === f.keluaran.skor[1].skor)).toBe(true);
  });

  it("show score parts that add up as in the report: 3·cocok + 2·urgensi + urutan", () => {
    for (const f of FIXTURES) {
      for (const s of f.keluaran.skor) expect(s.skor).toBeCloseTo(3 * s.cocok + 2 * s.urgensi + s.urutan, 9);
    }
  });
});

describe("matchTasks rules", () => {
  const tasks = [task(1, "monoton", "ringan", 0), task(2, "aktif", "berat", 2), task(3, "aktif", "ringan")];

  it("never names a task when energy is very low, whatever the tasks and the hour (NOTES D-84)", () => {
    for (const f of FIXTURES) {
      for (const jam_rawan of [false, true]) {
        const out = matchTasks({ ...f.masukan, fase: "rendah berat", jam_rawan });
        expect(out.tugas_id).toBeNull();
        expect(out.langkah).toEqual([{ jenis: "jeda", menit: PLAN.breakMinutes, tugas_id: null, kode: ["JEDA_DULU"] }]);
      }
    }
  });

  it("puts an active task above a monotone one in the slump row, and not in the flat row (negative control)", () => {
    const pair = [task(1, "monoton", "berat"), task(2, "aktif", "ringan")];
    expect(matchTasks({ fase: "rendah ringan", jam_rawan: false, menit_sejak_jeda: 40, tugas: pair }).tugas_id).toBe("t2");
    expect(matchTasks({ fase: "biasa", jam_rawan: false, menit_sejak_jeda: 40, tugas: pair }).tugas_id).toBe("t1");
  });

  it("ranks by posisi, not by the order of the array", () => {
    const input: MatchInput = { fase: "siap fokus", jam_rawan: false, menit_sejak_jeda: 20, tugas: tasks };
    const reversed: MatchInput = { ...input, tugas: [...tasks].reverse() };
    expect(matchTasks(reversed)).toEqual(matchTasks(input));
  });

  it("keeps a true tie a tie and gives it to the user's order, where summed decimals would not", () => {
    // Slump row: t1 monotone-heavy due today, first: 3·0.1 + 2·1 + 1 = 3.3; t2 active-light due in 2 days, second:
    // 3·0.9 + 2·0.3 + 0 = 3.3. Summed in floating point the second comes out larger.
    expect(3 * 0.9 + 2 * 0.3 + 0).toBeGreaterThan(3 * 0.1 + 2 * 1 + 1);
    const pair = [task(1, "monoton", "berat", 0), task(2, "aktif", "ringan", 2)];
    const out = matchTasks({ fase: "rendah ringan", jam_rawan: false, menit_sejak_jeda: 40, tugas: pair });
    expect(out.skor.map((s) => [s.id, s.skor])).toEqual([
      ["t1", 3.3],
      ["t2", 3.3],
    ]);
    expect(out.tugas_id).toBe("t1");
  });

  it("carries nothing but the abstract fields into its result", () => {
    const titled = tasks.map((t) => ({ ...t, title: "Reply to Dina about Project Falcon", listTitle: "Clients" }));
    const out = matchTasks({ fase: "biasa", jam_rawan: true, menit_sejak_jeda: 40, tugas: titled });
    expect(out).toEqual(matchTasks({ fase: "biasa", jam_rawan: true, menit_sejak_jeda: 40, tugas: tasks }));
    // Positive control: the titled input does hold the strings searched for.
    expect(JSON.stringify(titled)).toContain("Project Falcon");
    expect(JSON.stringify(out)).not.toContain("Falcon");
    expect(JSON.stringify(out)).not.toContain("Clients");
  });

  it("uses the weights and tables of the research report §3.4 and the minutes of §3.3 / D-84", () => {
    expect(WEIGHT).toEqual({ cocok: 3, urgensi: 2, urutan: 1 });
    expect(URGENCY).toEqual({ hariIni: 10, besok: 6, dekat: 3, lainnya: 0 });
    expect(FIT["siap fokus"]).toEqual({ "aktif berat": 10, "aktif ringan": 6, "monoton berat": 5, "monoton ringan": 2 });
    expect(FIT.rawan).toEqual({ "aktif berat": 10, "aktif ringan": 9, "monoton berat": 1, "monoton ringan": 2 });
    expect(new Set(Object.values(FIT.biasa))).toEqual(new Set([5]));
    expect(PLAN).toEqual({ walkMinutes: 5, breakMinutes: 10, lowBlockMinutes: 25, walkDueMinutes: 30 });
  });
});
