import type { Baseline } from "./calibration.ts";
import type { WindowFeatures } from "./features.ts";

// Same list as server/src/features.ts.
export const LABELS = ["normal", "lelah ringan", "lelah", "tertidur", "tidak di depan layar"] as const;
export type Label = (typeof LABELS)[number];

// ⚠️ Initial values (PLAN-2026-09-22), tuned on 23 Sep from recorded sessions.
// PERCLOS 0.15 is a common literature cut-off (range ±0.12–0.2), not yet checked
// against a primary source. Blink rate alone is ambiguous (it drops when focusing
// on a screen and rises when drowsy), so a rate well above the personal baseline,
// which was also measured at the screen, only supports other signs (fastBlinkFactor).
// Head down is not a point either (21 Sep: looking at a phone read as "lelah");
// the long eye closure that comes before a drowsy head drop is.
export const RULES = {
  awayFaceMissing: 0.5,
  eyesUnseen: 0.5, // share of frames with the eyes not seen (face hidden, or head down with low lids)…
  bodyPresent: 0.5, // …while someone is still in view in this share of body samples: the label is held
  perclosMild: 0.08,
  perclosTired: 0.15,
  slowBlinkFactor: 1.5,
  yawns: 1,
  longClosures: 1,
  // Supporting only: counts when another sign is already there. Alone it misfires,
  // since the 21 Sep tester blinked up to 1.9× the baseline while working normally
  // (up to 2.6× when acting drowsy).
  fastBlinkFactor: 2,
  headDownNote: 0.3, // explained in catatan, not scored
  tiredPoints: 3,
  confirmEvaluations: 2, // hysteresis: a new label must show up this many times in a row
} as const;

// "tertidur" follows from what the camera sees over minutes, not from a fatigue
// history (user decision, 21 Sep). How often it happens drives the advice instead.
// Both the lookback and the current window must look asleep, so waking up ends it
// within one window. ⚠️ Initial values.
export const SLEEP = {
  eyesClosedMinutes: 5, // eyes seen closed most of this long…
  eyesHiddenMinutes: 10, // …or not seen at all (face hidden, head dropped): only the body tells, so wait longer
  minEyesClosed: 0.5, // the 5-minute path: eyes seen closed in at least half of the frames
  maxEyesOpen: 0.1, // eyes seen open in at most 10% of the frames
  minBodyPresent: 0.8, // most of the calibrated body in view in 80% of the body samples…
  minStill: 0.9, // …and still in 90% of them (BODY.stillMotion)
  minCoverage: 0.9, // recorded data must span 90% of the lookback
} as const;

export type SleepLookback = {
  eyesClosed: WindowFeatures; // features over the last eyesClosedMinutes
  eyesHidden: WindowFeatures; // features over the last eyesHiddenMinutes
  eyesClosedMinutes: number; // SLEEP values, shorter for demos (?tidur=N)
  eyesHiddenMinutes: number;
};

export type Evaluation = {
  label: Label;
  skor: number; // 0–1, temporary until the RLDD classifier gives probabilities (24–26 Sep)
  poin: number;
  alasan: string[]; // one Indonesian sentence per triggered rule: the explainability part
  catatan: string[]; // context that did not count toward the label (e.g. head down)
};

const number = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 });
const pct = (x: number) => `${number.format(x * 100)}%`;
const ms = (x: number) => `${Math.round(x)} ms`;
const spanOf = (f: WindowFeatures) => `${Math.round(f.durasi_jendela_detik)} detik terakhir`;

// Eyes not seen open, most of the body in view, and still. minutes = the lookback
// length, whose data must be complete enough; undefined for the current window.
function looksAsleep(f: WindowFeatures, minutes?: number): boolean {
  if (minutes !== undefined && f.durasi_jendela_detik < SLEEP.minCoverage * minutes * 60) return false;
  return (
    f.pct_mata_terbuka !== null &&
    f.pct_mata_terbuka <= SLEEP.maxEyesOpen &&
    f.pct_tubuh_utuh !== null &&
    f.pct_tubuh_utuh >= SLEEP.minBodyPresent &&
    f.pct_tubuh_diam !== null &&
    f.pct_tubuh_diam >= SLEEP.minStill
  );
}

function sleepReasons(f: WindowFeatures, lookback: SleepLookback | null): string[] | null {
  if (!lookback || !looksAsleep(f)) return null;
  const reasons = (eyes: string, w: WindowFeatures, minutes: number) => [
    `${eyes} selama ${minutes} menit terakhir, dan hanya terlihat terbuka ${pct(w.pct_mata_terbuka ?? 0)} ` +
      `(batas ${pct(SLEEP.maxEyesOpen)}).`,
    `Tubuh tetap di depan kamera dan diam ${pct(w.pct_tubuh_diam ?? 0)} dari waktu itu (batas ${pct(SLEEP.minStill)}).`,
  ];
  const { eyesClosed: closed, eyesHidden: hidden } = lookback;
  const closedShare = closed.pct_mata_tertutup ?? 0;
  if (looksAsleep(closed, lookback.eyesClosedMinutes) && closedShare >= SLEEP.minEyesClosed) {
    return reasons(`Mata terlihat terpejam ${pct(closedShare)}`, closed, lookback.eyesClosedMinutes);
  }
  if (looksAsleep(hidden, lookback.eyesHiddenMinutes)) {
    return reasons("Mata tidak terlihat (wajah tersembunyi atau kepala tertunduk)", hidden, lookback.eyesHiddenMinutes);
  }
  return null;
}

const eyesUnseen = (f: WindowFeatures) =>
  f.pct_mata_terbuka === null || f.pct_mata_tertutup === null ? null : 1 - f.pct_mata_terbuka - f.pct_mata_tertutup;

// Eyes mostly not seen while someone is still in view: head down over a phone or
// paper, or resting on the desk for less time than "tertidur" needs. The eyes
// cannot be judged, so the shown label stays (evaluate() → hold). Without body
// detection a hidden face looks like leaving, and "tidak di depan layar" applies.
export function hiddenFaceNote(f: WindowFeatures, sleepMinutes: number = SLEEP.eyesHiddenMinutes): string | null {
  const unseen = eyesUnseen(f);
  if (unseen === null || unseen < RULES.eyesUnseen) return null;
  if (f.pct_tubuh_ada === null || f.pct_tubuh_ada < RULES.bodyPresent) return null;
  return (
    `Mata tidak terlihat ${pct(unseen)} dari ${spanOf(f)} (wajah tersembunyi atau menunduk), tapi tubuhmu masih ` +
    "terdeteksi, mungkin sedang melihat HP atau dokumen. Mata tidak bisa dinilai, jadi label terakhir dipertahankan. " +
    `Kalau tubuh tetap diam ${sleepMinutes} menit, statusnya menjadi "tertidur".`
  );
}

// Rules → label. null = not calibrated yet, no frames, or eyes hidden at the desk (hiddenFaceNote).
export function classify(f: WindowFeatures, baseline: Baseline | null, lookback: SleepLookback | null = null): Evaluation | null {
  if (!baseline || f.n_frame === 0) return null;
  const span = spanOf(f);

  const asleep = sleepReasons(f, lookback);
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
  const fastBlinkLimit = RULES.fastBlinkFactor * baseline.blinkPerMin;
  if (f.kedip_per_menit !== null && baseline.blinkPerMin > 0 && f.kedip_per_menit >= fastBlinkLimit) {
    const blinks =
      `Berkedip ${number.format(f.kedip_per_menit)}×/menit, lebih sering dari biasanya ` +
      `(${number.format(baseline.blinkPerMin)}; batas ${number.format(fastBlinkLimit)})`;
    if (poin > 0) {
      poin++;
      alasan.push(`${blinks}.`);
    } else {
      catatan.push(`${blinks}, tapi tidak dihitung karena tidak ada tanda lelah lain.`);
    }
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

// hold: the eyes are hidden but the person is still there, so the shown label stays
// and the UI explains why.
export function evaluate(
  features: WindowFeatures,
  baseline: Baseline | null,
  prev: LabelState,
  lookback: SleepLookback | null = null,
): { state: LabelState; latest: Evaluation | null; hold: string | null } {
  const latest = classify(features, baseline, lookback);
  const hold =
    latest === null && baseline !== null && features.n_frame > 0
      ? hiddenFaceNote(features, lookback?.eyesHiddenMinutes)
      : null;
  return { state: latest ? applyHysteresis(prev, latest) : prev, latest, hold };
}
