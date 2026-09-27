import { toSource, type Source } from "./answer.ts";
import type { DaySummary } from "./history.ts";
import type { Label } from "./rules.ts";

// "Tanya Equilibre" (plan P07): what the app sends with a question, and how the answer is shown.
// No DOM (tanyaPanel.ts renders). What may leave the device is NOTES D-44: the question, the
// latest label with menit_lelah_60, and today's aggregate numbers. Field names and limits are
// identical to server/src/tanya.ts (tanya.test.ts checks).

export const PERTANYAAN_MIN = 3;
export const PERTANYAAN_MAX = 300;

export type HariIni = {
  menit_normal: number;
  menit_lelah_ringan: number;
  menit_lelah: number;
  menit_tertidur: number;
  menit_tidak_di_depan_layar: number;
  jumlah_jeda: number;
  kss_rata_rata: number | null;
};

export type TanyaBody = { pertanyaan: string; label?: Label; menit_lelah_60?: number; hari_ini?: HariIni };

const oneDecimal = (x: number) => Math.round(x * 10) / 10;

// null when nothing was monitored today, so Bob is told there is no history rather than zeros.
export function toHariIni(s: DaySummary | null): HariIni | null {
  if (!s) return null;
  const monitored = Object.values(s.menit).reduce((a, b) => a + b, 0) + s.ditahan.fps + s.ditahan.mata + s.ditahan.lain;
  if (monitored === 0) return null;
  return {
    menit_normal: oneDecimal(s.menit.normal),
    menit_lelah_ringan: oneDecimal(s.menit["lelah ringan"]),
    menit_lelah: oneDecimal(s.menit.lelah),
    menit_tertidur: oneDecimal(s.menit.tertidur),
    menit_tidak_di_depan_layar: oneDecimal(s.menit["tidak di depan layar"]),
    jumlah_jeda: s.jeda.jumlah,
    kss_rata_rata: s.kss.rataRata === null ? null : oneDecimal(s.kss.rataRata),
  };
}

export function toTanyaBody(pertanyaan: string, label: Label | null, menitLelah60: number | null, today: DaySummary | null): TanyaBody {
  const hariIni = toHariIni(today);
  return {
    pertanyaan: pertanyaan.trim(),
    ...(label ? { label } : {}),
    ...(label && menitLelah60 !== null ? { menit_lelah_60: oneDecimal(Math.min(60, Math.max(0, menitLelah60))) } : {}),
    ...(hariIni ? { hari_ini: hariIni } : {}),
  };
}

export type TanyaResponse = {
  jawaban: string;
  sumber: string[];
  format_bebas: boolean;
  tool_calls: number | null;
  biaya: number | null;
  detik: number;
};

export type TanyaView = { jawaban: string; sumber: Source[]; catatan: string[] };

const number = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 });

export function toTanyaView(r: TanyaResponse): TanyaView {
  const calls = r.tool_calls === null ? "" : `, ${r.tool_calls} panggilan flow Langflow`;
  const catatan = [`Dijawab IBM Bob dalam ${number.format(r.detik)} detik${calls}.`];
  if (r.format_bebas) catatan.push("Bob tidak menjawab dalam format yang diminta, jadi teksnya ditampilkan apa adanya.");
  return { jawaban: r.jawaban, sumber: r.sumber.map(toSource), catatan };
}
