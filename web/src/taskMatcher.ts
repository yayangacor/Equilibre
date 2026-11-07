import type { Phase } from "./phase.ts";
import { DUE_SOON_DAYS, NOT_ASSESSED, type AbstractTask } from "./taskTagger.ts";

// Task Matcher (plan P20 W2.4, research report §3.4, NOTES D-83, D-84): rules and a transparent score pick what to do
// in the next hour for the energy phase. Pure and deterministic, and it only ever sees the abstract tasks t1..tn
// (NOTES D-90): no title, list or Google task id. The LLM does not choose; it explains this choice in words.
// Two jobs: the offline plan when the server cannot answer (rencana.ts), and the reference that the Langflow
// component "Task Matcher" (Python, W2.4 part b) must match. taskMatcher.fixtures.json holds input → expected
// output pairs that both are tested against.
//
//   skor(t) = 3·cocok(sifat, beban, row) + 2·urgensi(hari_ke_tenggat) + 1·urutan(posisi),  urutan = 1 − posisi/(n−1)
//
// Readings where the report is silent (the simpler one each time):
// - Which row of the cocok table: "rendah berat" has none (a break, no task, D-84). "rendah ringan", or any phase
//   during the personal slump hours (jam_rawan), takes the row "Rendah ringan / jam rawan" (D-84: "jam rawan atau
//   lelah ringan"). "siap fokus" takes its own row. "biasa" and "tidak tahu" take the flat row: when the camera cannot
//   judge, fit says nothing, and the plan is still given because the user asked for it (KAMERA_TIDAK_MENILAI says so).
// - Walk first: always in "rendah ringan" (§3.3); otherwise in the slump hours only when menit_sejak_jeda ≥ 30 or
//   unknown, the walk scheduler's own rule (§3.3); never outside them.
// - "belum dinilai" in sifat or beban: cocok 0.5, the flat value (nothing known about the fit). The tagger always
//   sets both or neither (taskTagger.ts tagTask), so a half-known task is scored as unknown too.
// - One task: urutan 1 (1 − 0/0 is undefined, and the only task is also the user's first).
// - Ranking uses an exact integer key, 10·d·skor with d = max(1, n−1), so a true tie stays a tie: summed decimals do
//   not (3·0.9 + 1 and 3·1 + 0.7 differ in the last bit). Ties go to the user's order (§3.4).
// - Minutes: walk 5 (D-84), break 10 (§3.3 "jalan 10 menit"), task block 25 in the low row (§3.3 "blok 25–40 menit",
//   the short end); no length (null) for the task outside it, since the report gives none.
// - Reason codes: the four of §3.4 (TENGGAT_HARI_INI also for overdue: both are urgensi 1) plus the codes below.
//   HINDARI_MONOTON is claimed only when the fit changed the choice: without the fit term, a monotone task would
//   have come first.

export const STEP_KINDS = ["jalan", "jeda", "tugas"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const REASON_CODES = [
  "JEDA_DULU", // rendah berat: an active break, no task (§3.4, D-84)
  "JALAN_DULU", // a 5-minute walk before the task (D-84)
  "KAMERA_TIDAK_MENILAI", // tidak tahu: the camera could not judge, so the energy fit was left out
  "AKTIF_SAAT_RAWAN", // low energy or slump hours, and the chosen task is active (§3.4)
  "HINDARI_MONOTON", // a monotone task would have come first without the energy fit (§3.4)
  "SIAP_FOKUS", // siap fokus, and the chosen task is active and heavy (§3.3)
  "TENGGAT_HARI_INI", // due today or overdue (§3.4)
  "TENGGAT_DEKAT", // due in 1–3 days
  "URUTAN_PENGGUNA", // the first task of the user's own list
  "BELUM_DINILAI", // the chosen task's kind is not assessed yet (taskTagger.ts NOT_ASSESSED)
  "TIDAK_ADA_TUGAS", // no open task to choose from
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

// "rawan" is the report's row "Rendah ringan / jam rawan".
export const FIT_ROWS = ["siap fokus", "biasa", "rawan"] as const;
export type FitRow = (typeof FIT_ROWS)[number];
type Kind = "aktif berat" | "aktif ringan" | "monoton berat" | "monoton ringan";

// ⚠️ Research report §3.4, not tuned with users yet. In tenths, so the ranking key stays an integer.
export const FIT: Readonly<Record<FitRow, Readonly<Record<Kind, number>>>> = {
  "siap fokus": { "aktif berat": 10, "aktif ringan": 6, "monoton berat": 5, "monoton ringan": 2 },
  biasa: { "aktif berat": 5, "aktif ringan": 5, "monoton berat": 5, "monoton ringan": 5 },
  rawan: { "aktif berat": 10, "aktif ringan": 9, "monoton berat": 1, "monoton ringan": 2 },
};
export const FIT_UNASSESSED = 5; // ⚠️ tenths: "belum dinilai"

// ⚠️ §3.4, in tenths: due today or overdue 1, tomorrow 0.6, in ≤ 3 days 0.3, later or no date 0.
export const URGENCY = { hariIni: 10, besok: 6, dekat: 3, lainnya: 0 } as const;
export const WEIGHT = { cocok: 3, urgensi: 2, urutan: 1 } as const; // ⚠️ §3.4

// ⚠️ Minutes (see the readings above).
export const PLAN = { walkMinutes: 5, breakMinutes: 10, lowBlockMinutes: 25, walkDueMinutes: 30 } as const;

// What the server receives too (rencana.ts): the phase, the slump flag, minutes since the last break, and the
// abstract tasks with posisi 0..n−1 (toAbstractTasks gives exactly that; the server checks it).
export type MatchInput = {
  fase: Phase;
  jam_rawan: boolean;
  menit_sejak_jeda: number | null;
  tugas: readonly AbstractTask[];
};

export type MatchStep = { jenis: StepKind; menit: number | null; tugas_id: string | null; kode: ReasonCode[] };
// The score parts as shown: cocok and urgensi in 0..1, urutan in 0..1, skor = 3·cocok + 2·urgensi + urutan.
export type TaskScore = { id: string; cocok: number; urgensi: number; urutan: number; skor: number };
export type MatchResult = {
  baris: FitRow | null; // the cocok row used; null for a break
  langkah: MatchStep[];
  tugas_id: string | null;
  kode: ReasonCode[]; // every reason, in step order
  skor: TaskScore[]; // best first; empty for a break
};

export function fitRow(fase: Phase, jamRawan: boolean): FitRow | null {
  if (fase === "rendah berat") return null;
  if (fase === "rendah ringan" || jamRawan) return "rawan";
  return fase === "siap fokus" ? "siap fokus" : "biasa";
}

export function fitTenths(row: FitRow, task: Pick<AbstractTask, "sifat" | "beban">): number {
  if (task.sifat === NOT_ASSESSED || task.beban === NOT_ASSESSED) return FIT_UNASSESSED;
  const kind: Kind = `${task.sifat} ${task.beban}` as const;
  return FIT[row][kind];
}

export function urgencyTenths(hariKeTenggat: number | null): number {
  if (hariKeTenggat === null) return URGENCY.lainnya;
  if (hariKeTenggat <= 0) return URGENCY.hariIni;
  if (hariKeTenggat <= 1) return URGENCY.besok;
  return hariKeTenggat <= DUE_SOON_DAYS ? URGENCY.dekat : URGENCY.lainnya;
}

type Ranked = { task: AbstractTask; fit: number; urgency: number; key: number; base: number };

// Best first: the larger key, then the user's order.
const byRank = (keyOf: (r: Ranked) => number) => (a: Ranked, b: Ranked) => keyOf(b) - keyOf(a) || a.task.posisi - b.task.posisi;

export function matchTasks(input: MatchInput): MatchResult {
  const row = fitRow(input.fase, input.jam_rawan);
  if (row === null) {
    const jeda: MatchStep = { jenis: "jeda", menit: PLAN.breakMinutes, tugas_id: null, kode: ["JEDA_DULU"] };
    return { baris: null, langkah: [jeda], tugas_id: null, kode: ["JEDA_DULU"], skor: [] };
  }

  const d = Math.max(1, input.tugas.length - 1);
  const ranked = input.tugas.map((task): Ranked => {
    const fit = fitTenths(row, task);
    const urgency = urgencyTenths(task.hari_ke_tenggat);
    const order = WEIGHT.urutan * 10 * (d - task.posisi);
    return {
      task,
      fit,
      urgency,
      key: d * (WEIGHT.cocok * fit + WEIGHT.urgensi * urgency) + order,
      base: d * WEIGHT.urgensi * urgency + order, // the same key without the fit term
    };
  });
  const best = [...ranked].sort(byRank((r) => r.key));
  const chosen = best[0]?.task ?? null;
  const withoutFit = [...ranked].sort(byRank((r) => r.base))[0]?.task ?? null;

  const langkah: MatchStep[] = [];
  const walkDue = input.menit_sejak_jeda === null || input.menit_sejak_jeda >= PLAN.walkDueMinutes;
  if (input.fase === "rendah ringan" || (row === "rawan" && walkDue)) {
    langkah.push({ jenis: "jalan", menit: PLAN.walkMinutes, tugas_id: null, kode: ["JALAN_DULU"] });
  }
  if (chosen) {
    const hari = chosen.hari_ke_tenggat;
    const kode: ReasonCode[] = [];
    if (row === "rawan" && chosen.sifat === "aktif") kode.push("AKTIF_SAAT_RAWAN");
    if (row === "rawan" && withoutFit && withoutFit.sifat === "monoton" && withoutFit.id !== chosen.id) kode.push("HINDARI_MONOTON");
    if (row === "siap fokus" && chosen.sifat === "aktif" && chosen.beban === "berat") kode.push("SIAP_FOKUS");
    if (hari !== null && hari <= 0) kode.push("TENGGAT_HARI_INI");
    if (hari !== null && hari >= 1 && hari <= DUE_SOON_DAYS) kode.push("TENGGAT_DEKAT");
    if (chosen.posisi === 0) kode.push("URUTAN_PENGGUNA");
    if (chosen.sifat === NOT_ASSESSED || chosen.beban === NOT_ASSESSED) kode.push("BELUM_DINILAI");
    langkah.push({ jenis: "tugas", menit: row === "rawan" ? PLAN.lowBlockMinutes : null, tugas_id: chosen.id, kode });
  }

  const kode: ReasonCode[] = [
    ...(input.fase === "tidak tahu" ? (["KAMERA_TIDAK_MENILAI"] as const) : []),
    ...langkah.flatMap((s) => s.kode),
    ...(chosen ? [] : (["TIDAK_ADA_TUGAS"] as const)),
  ];
  const skor = best.map(({ task, fit, urgency, key }): TaskScore => ({
    id: task.id,
    cocok: fit / 10,
    urgensi: urgency / 10,
    urutan: (d - task.posisi) / d,
    skor: key / (10 * d),
  }));
  return { baris: row, langkah, tugas_id: chosen?.id ?? null, kode, skor };
}
