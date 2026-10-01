import type { DaySummary, EvaluationRecord } from "./history.ts";
import type { Label } from "./rules.ts";

// What the "Insight" and "Sekarang" pages say about a day (plan P14): the fatigue level over time,
// plain sentences and stat tiles. Pure, no DOM (insightCharts.ts and dashboard.ts draw). Everything
// comes from the local history; nothing here leaves the device.

// The labels at the screen as an ordered scale, normal → tertidur ("Alert → Drowsy" in the
// UTA-RLDD demo). Time away from the screen has no level: the trend line breaks there.
export const LEVEL: Readonly<Record<Label, number | null>> = {
  normal: 0,
  "lelah ringan": 1,
  lelah: 2,
  tertidur: 3,
  "tidak di depan layar": null,
};
export const LEVEL_LABELS: readonly Label[] = ["normal", "lelah ringan", "lelah", "tertidur"];
export const AT_SCREEN: readonly Label[] = LEVEL_LABELS;
export const FATIGUE: readonly Label[] = ["lelah ringan", "lelah", "tertidur"];

export type LevelPoint = {
  t: number; // bucket start, wall clock ms
  level: number | null; // mean level of the judged evaluations at the screen; null = no line here
  label: Label | null; // the label shown most in the bucket (ties go to the heavier one)
  n: number; // judged evaluations in the bucket
};

// Wider buckets for longer days, so a line stays readable: ≤ 2 h by the minute, ≤ 6 h by 5 minutes.
export function bucketFor(spanMs: number): number {
  if (spanMs <= 2 * 3_600_000) return 60_000;
  if (spanMs <= 6 * 3_600_000) return 5 * 60_000;
  return 10 * 60_000;
}

// Every bucket from the first to the last judged evaluation, gaps included (level null).
export function levelSeries(evaluasi: readonly EvaluationRecord[], bucket: number): LevelPoint[] {
  const judged = evaluasi.filter((r) => r.dinilai);
  if (judged.length === 0) return [];
  const groups = new Map<number, EvaluationRecord[]>();
  for (const r of judged) {
    const key = Math.floor(r.t / bucket) * bucket;
    const group = groups.get(key);
    if (group) group.push(r);
    else groups.set(key, [r]);
  }
  const keys = [...groups.keys()];
  const first = Math.min(...keys);
  const last = Math.max(...keys);
  const points: LevelPoint[] = [];
  for (let t = first; t <= last; t += bucket) {
    const group = groups.get(t) ?? [];
    const levels = group.map((r) => LEVEL[r.label]).filter((l): l is number => l !== null);
    points.push({
      t,
      level: levels.length > 0 ? levels.reduce((a, b) => a + b, 0) / levels.length : null,
      label: mostShown(group),
      n: group.length,
    });
  }
  return points;
}

function mostShown(group: readonly EvaluationRecord[]): Label | null {
  const counts = new Map<Label, number>();
  for (const r of group) counts.set(r.label, (counts.get(r.label) ?? 0) + 1);
  let best: Label | null = null;
  for (const [label, count] of counts) {
    const current = best === null ? -1 : (counts.get(best) ?? 0);
    const heavier = best !== null && (LEVEL[label] ?? -1) > (LEVEL[best] ?? -1);
    if (count > current || (count === current && heavier)) best = label;
  }
  return best;
}

// ── Numbers of a day ────────────────────────────────────────────────────────────

const sum = (s: DaySummary, labels: readonly Label[]) => labels.reduce((total, l) => total + s.menit[l], 0);
export const atScreenMinutes = (s: DaySummary) => sum(s, AT_SCREEN);
export const fatigueMinutes = (s: DaySummary) => sum(s, FATIGUE);
export const judgedMinutes = (s: DaySummary) => atScreenMinutes(s) + s.menit["tidak di depan layar"];
export const notJudgedMinutes = (s: DaySummary) => s.ditahan.fps + s.ditahan.mata + s.ditahan.lain;
export const monitoredMinutes = (s: DaySummary) => judgedMinutes(s) + notJudgedMinutes(s);

// Share of the time at the screen spent "normal", 0–1; null with no time at the screen.
export function normalShare(s: DaySummary): number | null {
  const atScreen = atScreenMinutes(s);
  return atScreen > 0 ? s.menit.normal / atScreen : null;
}

// The hour with the most minutes of any fatigue label; null when there were none.
export function peakFatigueHour(s: DaySummary): { jam: number; menit: number } | null {
  let best: { jam: number; menit: number } | null = null;
  for (const h of s.perJam) {
    const menit = FATIGUE.reduce((total, l) => total + h.menit[l], 0);
    if (menit > 0 && (best === null || menit > best.menit)) best = { jam: h.jam, menit };
  }
  return best;
}

// "45 mnt", "1 jam 5 mnt", "3 jam". What would round to 0 but is not 0 reads "< 1 mnt".
export function formatDuration(minutes: number): string {
  if (minutes > 0 && minutes < 0.5) return "< 1 mnt";
  const total = Math.round(minutes);
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest} mnt`;
  return rest === 0 ? `${hours} jam` : `${hours} jam ${rest} mnt`;
}

const two = (n: number) => String(n).padStart(2, "0");
export const hourSpan = (jam: number) => `${two(jam)}.00–${two((jam + 1) % 24)}.00`;
const percent = (x: number) => `${Math.round(x * 100)}%`;
const decimal = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 });

// Up to three plain sentences that lead the Insight page: the day in words before the charts.
export function insightSentences(s: DaySummary): string[] {
  const sentences: string[] = [];
  const atScreen = atScreenMinutes(s);
  const share = normalShare(s);
  if (share === null) {
    sentences.push("Belum ada waktu di depan layar yang dinilai.");
  } else {
    sentences.push(`Dari ${formatDuration(atScreen)} di depan layar, kamu dalam kondisi normal ${percent(share)} dari waktu itu.`);
    const fatigue = fatigueMinutes(s);
    const peak = peakFatigueHour(s);
    sentences.push(
      fatigue === 0 || peak === null
        ? "Tidak ada tanda lelah yang tercatat."
        : `Tanda lelah tampil ${formatDuration(fatigue)}, paling banyak pukul ${hourSpan(peak.jam)}.`,
    );
  }
  sentences.push(
    s.jeda.jumlah === 0
      ? "Belum ada jeda 2 menit atau lebih yang tercatat."
      : `Kamu jeda ${s.jeda.jumlah}× dengan total ${formatDuration(s.jeda.menit)}.`,
  );
  return sentences;
}

export type Tile = { label: string; value: string; sub: string };

export function dayTiles(s: DaySummary): Tile[] {
  const share = normalShare(s);
  const notJudged = notJudgedMinutes(s);
  return [
    {
      label: "Dipantau",
      value: formatDuration(monitoredMinutes(s)),
      sub: `${s.sesi} sesi${notJudged > 0 ? ` · ${formatDuration(notJudged)} tidak dinilai` : ""}`,
    },
    { label: "Kondisi normal", value: share === null ? "–" : percent(share), sub: "dari waktu di depan layar" },
    {
      label: "Jeda",
      value: `${s.jeda.jumlah}×`,
      sub: s.jeda.jumlah === 0 ? "belum ada" : `total ${formatDuration(s.jeda.menit)}`,
    },
    {
      label: "Cek kantuk (KSS)",
      value: s.kss.rataRata === null ? "–" : decimal.format(s.kss.rataRata),
      sub: s.kss.jumlah === 0 ? "belum diisi" : `${s.kss.jumlah} isian · skala 1–9`,
    },
  ];
}
