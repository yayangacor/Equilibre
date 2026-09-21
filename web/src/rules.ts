import type { Baseline } from "./calibration.ts";
import type { WindowFeatures } from "./features.ts";

// Same list as server/src/features.ts.
export const LABELS = ["normal", "lelah ringan", "lelah", "tertidur", "tidak di depan layar"] as const;
export type Label = (typeof LABELS)[number];

// ⚠️ Initial values (PLAN-2026-09-22), tuned on 23 Sep from recorded sessions.
// PERCLOS 0.15 is a common literature cut-off (range ±0.12–0.2), not yet checked
// against a primary source. Blink rate is deliberately unused: it drops when
// focusing on a screen and rises when drowsy, so its direction is ambiguous.
// Head down is not a point either (21 Sep: looking at a phone read as "lelah");
// the long eye closure that comes before a drowsy head drop is.
export const RULES = {
  awayFaceMissing: 0.5,
  bodyPresent: 0.5, // share of body samples: someone is still in view although the face is hidden
  perclosMild: 0.08,
  perclosTired: 0.15,
  slowBlinkFactor: 1.5,
  yawns: 1,
  longClosures: 1,
  headDownNote: 0.3, // explained in catatan, not scored
  tiredPoints: 3,
  confirmEvaluations: 2, // hysteresis: a new label must show up this many times in a row
} as const;

// "tertidur" is deliberately rare (user decision, 21 Sep): it needs a long stretch of
// heavy fatigue before it, not just a hidden face or closed eyes. ⚠️ Initial values.
export const SLEEP = {
  maxEyesOpen: 0.1, // eyes seen open in at most 10% of the window
  minBodyPresent: 0.8, // someone is in view in at least 80% of the body samples…
  maxMotion: 0.015, // …and barely moves (median mask change). ⚠️ Scale unknown until the first sleep recording.
  fatigueMinutes: 15, // the shown label was "lelah" at least this long…
  historyMinutes: 60, // …within this many minutes
} as const;

export type SleepContext = {
  menitLelah: number; // minutes the shown label was "lelah" within SLEEP.historyMinutes
  minMenitLelah: number; // SLEEP.fatigueMinutes, shorter for demos (?lelah=N)
};

export const NO_HISTORY: SleepContext = { menitLelah: 0, minMenitLelah: SLEEP.fatigueMinutes };

export type Evaluation = {
  label: Label;
  skor: number; // 0–1, temporary until the RLDD classifier gives probabilities (24–26 Sep)
  poin: number;
  alasan: string[]; // one Indonesian sentence per triggered rule: the explainability part
  catatan: string[]; // context that did not count toward the label (e.g. head down)
};

const number = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 });
const number3 = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 3 });
const pct = (x: number) => `${number.format(x * 100)}%`;
const ms = (x: number) => `${Math.round(x)} ms`;
const spanOf = (f: WindowFeatures) => `${Math.round(f.durasi_jendela_detik)} detik terakhir`;

function sleepReasons(f: WindowFeatures, sleep: SleepContext): string[] | null {
  if (f.pct_mata_terbuka === null || f.pct_mata_terbuka > SLEEP.maxEyesOpen) return null;
  if (f.pct_tubuh_ada === null || f.pct_tubuh_ada < SLEEP.minBodyPresent) return null;
  if (f.gerak_tubuh === null || f.gerak_tubuh > SLEEP.maxMotion) return null;
  if (sleep.menitLelah < sleep.minMenitLelah) return null;
  const hidden = f.pct_wajah_hilang ?? 0;
  return [
    hidden >= RULES.awayFaceMissing
      ? `Wajah tidak terlihat ${pct(hidden)} dari ${spanOf(f)}, tapi tubuhmu masih terdeteksi di depan kamera.`
      : `Mata hanya terlihat terbuka ${pct(f.pct_mata_terbuka)} dari ${spanOf(f)}.`,
    `Tubuh hampir tidak bergerak (gerak ${number3.format(f.gerak_tubuh)}, batas ${number3.format(SLEEP.maxMotion)}).`,
    `Sebelumnya status "lelah" sudah ${Math.round(sleep.menitLelah)} menit dalam ${SLEEP.historyMinutes} menit terakhir ` +
      `(syarat ${sleep.minMenitLelah} menit).`,
  ];
}

// Face mostly hidden while someone is still in view: head down over a phone or
// paper, or resting on the desk without the fatigue history "tertidur" needs.
// The eyes cannot be judged, so the shown label stays (evaluate() → hold).
// Without body detection this looks like leaving, and "tidak di depan layar" applies.
export function hiddenFaceNote(f: WindowFeatures): string | null {
  if (f.pct_wajah_hilang === null || f.pct_wajah_hilang < RULES.awayFaceMissing) return null;
  if (f.pct_tubuh_ada === null || f.pct_tubuh_ada < RULES.bodyPresent) return null;
  return (
    `Wajah tidak terlihat ${pct(f.pct_wajah_hilang)} dari ${spanOf(f)}, tapi tubuhmu masih terdeteksi ` +
    "(mungkin sedang menunduk atau melihat HP). Mata tidak bisa dinilai, jadi label terakhir dipertahankan."
  );
}

// Rules → label. null = not calibrated yet, no frames, or face hidden at the desk (hiddenFaceNote).
export function classify(f: WindowFeatures, baseline: Baseline | null, sleep: SleepContext = NO_HISTORY): Evaluation | null {
  if (!baseline || f.n_frame === 0) return null;
  const span = spanOf(f);

  const asleep = sleepReasons(f, sleep);
  if (asleep) return { label: "tertidur", skor: 1, poin: 0, alasan: asleep, catatan: [] };
  if (hiddenFaceNote(f)) return null;

  if (f.pct_wajah_hilang !== null && f.pct_wajah_hilang >= RULES.awayFaceMissing) {
    return {
      label: "tidak di depan layar",
      skor: 0,
      poin: 0,
      alasan: [`Wajah tidak terdeteksi ${pct(f.pct_wajah_hilang)} dari ${span} (batas ${pct(RULES.awayFaceMissing)}).`],
      catatan: [],
    };
  }

  const alasan: string[] = [];
  const catatan: string[] = [];
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
  if (f.mata_tertutup_lama >= RULES.longClosures) {
    poin++;
    alasan.push(`Mata terpejam 1 detik atau lebih sebanyak ${f.mata_tertutup_lama}× dalam ${span}.`);
  }
  if (f.pct_kepala_menunduk !== null && f.pct_kepala_menunduk >= RULES.headDownNote) {
    catatan.push(
      `Kepala menunduk ${pct(f.pct_kepala_menunduk)} dari ${span}, mungkin sedang melihat HP atau dokumen. ` +
        "Menunduk saja tidak dihitung sebagai tanda lelah, dan mata tidak dinilai selama menunduk.",
    );
  }

  const label: Label = perclosTired || poin >= RULES.tiredPoints ? "lelah" : poin >= 1 ? "lelah ringan" : "normal";
  const skor = Math.max(Math.min(1, poin / 4), perclosTired ? 0.75 : 0);
  return { label, skor, poin, alasan, catatan };
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

// hold: the face is hidden but the person is still there, so the shown label stays
// and the UI explains why.
export function evaluate(
  features: WindowFeatures,
  baseline: Baseline | null,
  prev: LabelState,
  sleep: SleepContext = NO_HISTORY,
): { state: LabelState; latest: Evaluation | null; hold: string | null } {
  const latest = classify(features, baseline, sleep);
  const hold = latest === null && baseline !== null && features.n_frame > 0 ? hiddenFaceNote(features) : null;
  return { state: latest ? applyHysteresis(prev, latest) : prev, latest, hold };
}
