import type { WindowFeatures } from "./features.ts";
import type { Evaluation, Label, Tanda } from "./rules.ts";

// The only data that leaves the device: a label, a few aggregate numbers and the names of
// the rules that fired (NOTES D-01, D-41). Must match the whitelist in server/src/features.ts
// exactly (payload.test.ts checks it).
export type AnalyzePayload = {
  label: Label;
  skor: number;
  tanda: Tanda[];
  perclos?: number;
  kedip_per_menit?: number;
  durasi_kedip_ms?: number;
  mata_tertutup_lama: number;
  menguap: number;
  pct_kepala_menunduk?: number;
  pct_wajah_hilang?: number;
  menit_sejak_jeda: number;
  menit_lelah_60: number; // minutes "lelah"/"tertidur" in the last hour: drives the long rest advice
};

const round = (x: number, digits: number) => Number(x.toFixed(digits));
const clamp = (x: number, max: number) => Math.min(max, Math.max(0, x));

export function toAnalyzePayload(
  evaluation: Evaluation,
  f: WindowFeatures,
  menitSejakJeda: number,
  menitLelah60: number,
): AnalyzePayload {
  // Missing values are left out rather than sent as null (the server rejects null).
  const optional = (key: keyof AnalyzePayload, value: number | null, digits: number, max = Infinity) =>
    value === null ? {} : { [key]: round(clamp(value, max), digits) };
  return {
    label: evaluation.label,
    skor: round(evaluation.skor, 2),
    tanda: [...evaluation.tanda],
    ...optional("perclos", f.perclos, 3),
    ...optional("kedip_per_menit", f.kedip_per_menit, 1, 200),
    ...optional("durasi_kedip_ms", f.durasi_kedip_ms, 0, 5000),
    mata_tertutup_lama: f.mata_tertutup_lama,
    menguap: f.menguap,
    ...optional("pct_kepala_menunduk", f.pct_kepala_menunduk, 3),
    ...optional("pct_wajah_hilang", f.pct_wajah_hilang, 3),
    menit_sejak_jeda: round(clamp(menitSejakJeda, 24 * 60), 0),
    menit_lelah_60: round(clamp(menitLelah60, 60), 1),
  };
}
