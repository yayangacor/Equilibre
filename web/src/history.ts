import type { WindowFeatures } from "./features.ts";
import { toAnalyzePayload, type AnalyzePayload } from "./payload.ts";
import { lowFpsNote, type Evaluation, type Label } from "./rules.ts";

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
