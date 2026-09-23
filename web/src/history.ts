import type { WindowFeatures } from "./features.ts";
import { toAnalyzePayload, type AnalyzePayload } from "./payload.ts";
import { LABELS, lowFpsNote, type Evaluation, type Label } from "./rules.ts";

// The local history (IndexedDB, historyDb.ts): what Equilibre saw, what it advised and
// what the user answered. None of it leaves the device (NOTES D-01); it is kept
// HISTORY_DAYS days (D-38). Field names follow the payload (Indonesian snake_case), so
// an export reads like what would have been sent, plus the local context around it.
// Times are wall clock (ms since epoch), not the performance.now() clock of the pipeline.

export const HISTORY_DAYS = 30;

type Stamp = {
  id?: number; // set by IndexedDB (autoIncrement)
  hari: string; // local calendar day, YYYY-MM-DD: the index every query goes through
  sesi: number; // wall clock of page load: one page load = one session
};

// "fps": hidden tab (lowFpsNote) · "mata": eyes hidden while still at the desk (hiddenFaceNote).
export type HoldCause = "fps" | "mata";

// One per evaluation (every EVAL_INTERVAL_MS) while a label is shown: the payload of
// that moment plus whether the window was judged at all.
export type EvaluationRecord = Stamp &
  AnalyzePayload & {
    t: number; // end of the evaluated window
    dinilai: boolean; // false: not judged, the shown label was carried over
    sebab_ditahan: HoldCause | null;
    label_mentah: Label | null; // this window's own label before hysteresis; null when not judged
    poin: number;
    hemat_daya: boolean;
  };

// Face gone for BREAK_MIN_MS or more (features.ts), the definition behind menit_sejak_jeda.
export type BreakRecord = Stamp & { mulai: number; selesai: number; menit: number };

export type Feedback = "sudah dilakukan" | "tidak relevan";

export type RecommendationRecord = Stamp & {
  t: number;
  pemicu: "manual" | "otomatis";
  label: Label;
  status: string | null; // decided by the server (NOTES D-28)
  hasil: Record<string, unknown> | null; // the parsed reply; null when it was not JSON
  teks: string; // the raw reply
  feedback: Feedback | null;
  t_feedback: number | null;
};

export type LabelCorrectionRecord = Stamp & {
  t: number;
  label_tampil: Label;
  label_koreksi: Label; // what the user says it should have been
  skor: number;
  alasan: string[];
};

export type KssRecord = Stamp & {
  t: number;
  kss: number; // Karolinska Sleepiness Scale, 1 (very alert) to 9 (fighting sleep)
  label_tampil: Label | null;
  pengingat: boolean; // entered after the 15-minute reminder (?uji=1)
};

const two = (n: number) => String(n).padStart(2, "0");

export function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

// Days before this one are deleted: today and the HISTORY_DAYS calendar days before it stay.
export function oldestKeptDay(now: number, days: number = HISTORY_DAYS): string {
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  return dayKey(d.getTime());
}

export function toEvaluationRecord(
  shown: Evaluation,
  step: { features: WindowFeatures; latest: Evaluation | null; hold: string | null; menitLelah: number },
  context: { t: number; sesi: number; menitSejakJeda: number; hematDaya: boolean },
): EvaluationRecord {
  const judged = step.latest !== null;
  return {
    ...toAnalyzePayload(shown, step.features, context.menitSejakJeda, step.menitLelah),
    t: context.t,
    hari: dayKey(context.t),
    sesi: context.sesi,
    dinilai: judged,
    sebab_ditahan: judged ? null : lowFpsNote(step.features) !== null ? "fps" : step.hold !== null ? "mata" : null,
    label_mentah: step.latest?.label ?? null,
    poin: shown.poin,
    hemat_daya: context.hematDaya,
  };
}

export function toBreakRecord(b: { mulai: number; selesai: number }, sesi: number): BreakRecord {
  return {
    hari: dayKey(b.mulai),
    sesi,
    mulai: b.mulai,
    selesai: b.selesai,
    menit: Math.round((b.selesai - b.mulai) / 6_000) / 10,
  };
}

type Context = { t: number; sesi: number };

// What /api/analyze answered, as the app received it (main.ts AnalyzeResponse).
export function toRecommendationRecord(
  reply: { text: string; result: unknown },
  context: Context & { pemicu: RecommendationRecord["pemicu"]; label: Label },
): RecommendationRecord {
  const { result } = reply;
  const hasil = result !== null && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : null;
  return {
    t: context.t,
    hari: dayKey(context.t),
    sesi: context.sesi,
    pemicu: context.pemicu,
    label: context.label,
    status: typeof hasil?.status === "string" ? hasil.status : null,
    hasil,
    teks: reply.text,
    feedback: null,
    t_feedback: null,
  };
}

// A correction names a state at the screen: someone clicking is awake and present, so
// "tertidur" and "tidak di depan layar" are never the answer.
export const correctionChoices = (shown: Label): Label[] =>
  (["normal", "lelah ringan", "lelah"] as const).filter((l) => l !== shown);

export function toLabelCorrection(shown: Evaluation, koreksi: Label, context: Context): LabelCorrectionRecord {
  return {
    t: context.t,
    hari: dayKey(context.t),
    sesi: context.sesi,
    label_tampil: shown.label,
    label_koreksi: koreksi,
    skor: shown.skor,
    alasan: [...shown.alasan],
  };
}

export function toKssRecord(kss: number, context: Context & { labelTampil: Label | null; pengingat: boolean }): KssRecord {
  return {
    t: context.t,
    hari: dayKey(context.t),
    sesi: context.sesi,
    kss,
    label_tampil: context.labelTampil,
    pengingat: context.pengingat,
  };
}

// The file behind "Unduh riwayat (JSON)": everything kept, plus what it is.
export function toExport(stores: DayData, now: number) {
  return {
    format: "equilibre-riwayat",
    versi: 1,
    dibuat: new Date(now).toISOString(),
    hari_disimpan: HISTORY_DAYS,
    catatan: "Label dan angka ringkasan dari perangkat ini saja, tanpa gambar. Waktu dalam milidetik sejak epoch.",
    ...stores,
  };
}

// ── One day, summed up (dashboard "Riwayat") ────────────────────────────────────

export type DayData = {
  evaluasi: readonly EvaluationRecord[];
  jeda: readonly BreakRecord[];
  rekomendasi: readonly RecommendationRecord[];
  koreksi_label: readonly LabelCorrectionRecord[];
  kss: readonly KssRecord[];
};

export type LabelMinutes = Record<Label, number>;

export type HourSummary = {
  jam: number; // local hour, 0–23
  menit: LabelMinutes; // judged minutes by shown label
  ditahan: number; // minutes not judged
};

export type DaySummary = {
  sesi: number;
  menit: LabelMinutes; // judged evaluations, by the label shown
  ditahan: Record<HoldCause | "lain", number>; // not judged, in minutes
  perJam: HourSummary[]; // every hour from the first to the last one with data, gaps as zeros
  jeda: { jumlah: number; menit: number };
  rekomendasi: { jumlah: number; otomatis: number; sudahDilakukan: number; tidakRelevan: number; belum: number };
  koreksi: number;
  kss: { jumlah: number; rataRata: number | null };
};

// Bottom to top in the hourly chart: the heaviest state sits on the baseline, so the
// minutes of fatigue per hour read as one block. "tidak di depan layar" is left out of
// the chart (it is time away, not a state at the screen) and stays in the numbers.
export const CHART_LABELS: readonly Label[] = ["tertidur", "lelah", "lelah ringan", "normal"];

const noMinutes = (): LabelMinutes => Object.fromEntries(LABELS.map((l) => [l, 0])) as LabelMinutes;

// Each evaluation stands for evalIntervalMs, as in Monitor.menitLelah, so time with no
// evaluation at all (page closed, camera stalled) never counts as monitored.
export function summarizeDay(data: DayData, evalIntervalMs: number): DaySummary {
  const each = evalIntervalMs / 60_000;
  const menit = noMinutes();
  const ditahan = { fps: 0, mata: 0, lain: 0 };
  const hours = new Map<number, HourSummary>();
  for (const r of data.evaluasi) {
    const jam = new Date(r.t).getHours();
    let hour = hours.get(jam);
    if (!hour) hours.set(jam, (hour = { jam, menit: noMinutes(), ditahan: 0 }));
    if (r.dinilai) {
      menit[r.label] += each;
      hour.menit[r.label] += each;
    } else {
      ditahan[r.sebab_ditahan ?? "lain"] += each;
      hour.ditahan += each;
    }
  }
  const jams = [...hours.keys()];
  const first = Math.min(...jams);
  const perJam =
    jams.length === 0
      ? []
      : Array.from({ length: Math.max(...jams) - first + 1 }, (_, i) => hours.get(first + i) ?? { jam: first + i, menit: noMinutes(), ditahan: 0 });

  const feedback = (f: Feedback | null) => data.rekomendasi.filter((r) => r.feedback === f).length;
  const kss = data.kss.map((k) => k.kss);
  return {
    sesi: new Set(data.evaluasi.map((r) => r.sesi)).size,
    menit,
    ditahan,
    perJam,
    jeda: { jumlah: data.jeda.length, menit: data.jeda.reduce((sum, b) => sum + b.menit, 0) },
    rekomendasi: {
      jumlah: data.rekomendasi.length,
      otomatis: data.rekomendasi.filter((r) => r.pemicu === "otomatis").length,
      sudahDilakukan: feedback("sudah dilakukan"),
      tidakRelevan: feedback("tidak relevan"),
      belum: feedback(null),
    },
    koreksi: data.koreksi_label.length,
    kss: { jumlah: kss.length, rataRata: kss.length > 0 ? kss.reduce((a, b) => a + b, 0) / kss.length : null },
  };
}
