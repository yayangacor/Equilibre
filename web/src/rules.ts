import type { Baseline } from "./calibration.ts";
import type { WindowFeatures } from "./features.ts";

// Same list as server/src/features.ts.
export const LABELS = ["normal", "lelah ringan", "lelah", "tidak di depan layar"] as const;
export type Label = (typeof LABELS)[number];

// ⚠️ Initial values (PLAN-2026-09-22), tuned on 23 Sep from recorded sessions.
// PERCLOS 0.15 is a common literature cut-off (range ±0.12–0.2), not yet checked
// against a primary source. Blink rate is deliberately unused: it drops when
// focusing on a screen and rises when drowsy, so its direction is ambiguous.
export const RULES = {
  awayFaceMissing: 0.5,
  perclosMild: 0.08,
  perclosTired: 0.15,
  slowBlinkFactor: 1.5,
  yawns: 1,
  headDown: 0.3,
  tiredPoints: 3,
  confirmEvaluations: 2, // hysteresis: a new label must show up this many times in a row
} as const;

export type Evaluation = {
  label: Label;
  skor: number; // 0–1, temporary until the RLDD classifier gives probabilities (24–26 Sep)
  poin: number;
  alasan: string[]; // one Indonesian sentence per triggered rule: the explainability part
};

const number = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 });
const pct = (x: number) => `${number.format(x * 100)}%`;
const ms = (x: number) => `${Math.round(x)} ms`;

// Rules → label. null = not calibrated yet or no frames to judge.
export function classify(f: WindowFeatures, baseline: Baseline | null): Evaluation | null {
  if (!baseline || f.n_frame === 0) return null;
  const span = `${Math.round(f.durasi_jendela_detik)} detik terakhir`;

  if (f.pct_wajah_hilang !== null && f.pct_wajah_hilang >= RULES.awayFaceMissing) {
    return {
      label: "tidak di depan layar",
      skor: 0,
      poin: 0,
      alasan: [`Wajah tidak terdeteksi ${pct(f.pct_wajah_hilang)} dari ${span} (batas ${pct(RULES.awayFaceMissing)}).`],
    };
  }

  const alasan: string[] = [];
  let poin = 0;
  const perclosTired = f.perclos !== null && f.perclos >= RULES.perclosTired;

  if (f.perclos !== null && f.perclos >= RULES.perclosMild) {
    poin++;
    const limit = perclosTired ? RULES.perclosTired : RULES.perclosMild;
    alasan.push(`Mata tertutup ${pct(f.perclos)} dari ${span} (batas ${pct(limit)}).`);
  }
  if (
    f.durasi_kedip_ms !== null &&
    baseline.blinkDurationMs !== null &&
    f.durasi_kedip_ms >= RULES.slowBlinkFactor * baseline.blinkDurationMs
  ) {
    poin++;
    alasan.push(
      `Kedipan rata-rata ${ms(f.durasi_kedip_ms)}, lebih lambat dari biasanya ` +
        `(${ms(baseline.blinkDurationMs)}; batas ${ms(RULES.slowBlinkFactor * baseline.blinkDurationMs)}).`,
    );
  }
  if (f.menguap >= RULES.yawns) {
    poin++;
    alasan.push(`Menguap ${f.menguap}× dalam ${span}.`);
  }
  if (f.pct_kepala_menunduk !== null && f.pct_kepala_menunduk >= RULES.headDown) {
    poin++;
    alasan.push(`Kepala menunduk ${pct(f.pct_kepala_menunduk)} dari ${span} (batas ${pct(RULES.headDown)}).`);
  }

  const label: Label = perclosTired || poin >= RULES.tiredPoints ? "lelah" : poin >= 1 ? "lelah ringan" : "normal";
  const skor = Math.max(Math.min(1, poin / 4), perclosTired ? 0.75 : 0);
  return { label, skor, poin, alasan };
}

// ── Hysteresis ──────────────────────────────────────────────────────────────────

export type LabelState = {
  shown: Evaluation | null; // what the UI displays and what gets sent to Langflow
  candidate: Label | null; // a different label waiting for confirmation
  streak: number;
};

export const initialLabelState = (): LabelState => ({ shown: null, candidate: null, streak: 0 });

// The first label is shown right away (nothing to flicker from). After that a
// different label replaces it only after RULES.confirmEvaluations evaluations in a row.
export function applyHysteresis(
  state: LabelState,
  next: Evaluation,
  required: number = RULES.confirmEvaluations,
): LabelState {
  if (state.shown === null || state.shown.label === next.label) {
    return { shown: next, candidate: null, streak: 0 };
  }
  const streak = state.candidate === next.label ? state.streak + 1 : 1;
  return streak >= required ? { shown: next, candidate: null, streak: 0 } : { ...state, candidate: next.label, streak };
}

export function evaluate(
  features: WindowFeatures,
  baseline: Baseline | null,
  prev: LabelState,
): { state: LabelState; latest: Evaluation | null } {
  const latest = classify(features, baseline);
  return { state: latest ? applyHysteresis(prev, latest) : prev, latest };
}
