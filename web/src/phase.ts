import type { EvaluationRecord, KssRecord } from "./history.ts";
import { AT_SCREEN, FATIGUE } from "./insight.ts";
import type { QualityLevel } from "./quality.ts";
import type { Label } from "./rules.ts";

// Energy phase (plan P20 W2.3, research report §3.3): what the Task Matcher and the walk scheduler get instead of
// the raw label. Pure; the caller passes the local history in. Of all this only `fase` and `jam_rawan` are meant
// to leave the device, with the abstract tasks (research §3.6); the reasons stay in the UI.
//
//   siap fokus     no fatigue label in the last 15 min, ≥ 70% of those 15 min judged, last break < 90 min ago
//   biasa          not tired, the evidence for siap fokus falls short
//   rendah ringan  "lelah ringan", or a KSS answer ≥ 7 in the last 15 min
//   rendah berat   "lelah" or "tertidur": a break first, no task (NOTES D-84)
//   tidak tahu     the camera cannot judge now, or judged < 50% of the last 15 min's evaluations: stay quiet
//
// Readings where the report leaves room (the simpler one each time):
// - "bertahan 2 evaluasi" (persists for 2 evaluations) is the shown label itself: rules.ts applyHysteresis shows a
//   fatigue label only after RULES.enterEvaluations (3) windows in a row, so a shown label has already persisted.
// - The personal slump hours do not change the phase; they come out as jam_rawan beside it, as research §3.6 sends
//   them ("jam rawan (ya/tidak)"). The Task Matcher's row "Rendah ringan / jam rawan" combines the two (W2.4).
// - Away from the screen ("tidak di depan layar") is "tidak tahu": nobody is there to judge.
// - Siap fokus needs the eyes judged: quality "terbatas-mata" (eyes unreadable) gives "biasa". "terbatas-fps"
//   (power saving) still qualifies, since eye closure is still measured there.
// - The judged share for siap fokus counts against the evaluations 15 minutes should have had (no evidence for
//   minutes not watched); for tidak tahu against the evaluations that actually ran (a fresh start is "biasa").
// - A KSS answer counts only while it is recent, within the same 15 minutes (the reminder comes every 15, kss.ts).

export const PHASES = ["siap fokus", "biasa", "rendah ringan", "rendah berat", "tidak tahu"] as const;
export type Phase = (typeof PHASES)[number];

// ⚠️ Proposals from the research report §3.3, not yet tested with users.
export const PHASE = {
  recentMinutes: 15, // the look-back for fatigue labels, the judged share and a KSS answer
  readyMinJudged: 0.7, // siap fokus: judged evaluations ÷ the evaluations recentMinutes should have
  readyMaxMinutesSinceBreak: 90, // siap fokus: last break less than this long ago
  knownMinJudged: 0.5, // below this judged ÷ evaluations run in recentMinutes: tidak tahu
  kssLow: 7, // KSS 7 = "sleepy, but no effort to keep awake"
} as const;

// Quality levels at which a calm label counts as evidence for siap fokus (quality.ts).
const READY_QUALITY: readonly QualityLevel[] = ["nilai", "terbatas-fps"];

// ── Personal slump hours ────────────────────────────────────────────────────────

// Local hours [startHour, endHour). personal: false = the default window.
export type SlumpWindow = { startHour: number; endHour: number; personal: boolean };

// ⚠️ Research report §3.3: the hour with the highest share of fatigue labels in the last 7 days, the default
// 13:00–16:00 with less than 3 days of data. The minimums keep one stray evaluation from moving the window.
export const SLUMP = {
  defaultStartHour: 13,
  defaultEndHour: 16,
  historyDays: 7,
  minDays: 3, // days with any evaluation in historyDays
  minHourMinutes: 30, // judged minutes at the screen in that hour, summed over the days, to be a candidate
  minTiredMinutes: 5, // fatigue minutes in the winning hour; less and the default stays
} as const;

export const DEFAULT_SLUMP: SlumpWindow = { startHour: SLUMP.defaultStartHour, endHour: SLUMP.defaultEndHour, personal: false };

export type SlumpRecord = Pick<EvaluationRecord, "t" | "hari" | "label" | "dinilai">;

const DAY_MS = 86_400_000;
const isOf = (labels: readonly Label[], label: Label) => labels.includes(label);

// The report names one hour, so the personal window is that hour; ties go to the earlier hour. A share, not a
// count, so an hour worked every day does not win just by being worked more. Hours of the local clock, like the
// history (history.ts dayKey). evalIntervalMs: how long one evaluation stands for (main.ts EVAL_INTERVAL_MS).
export function slumpWindow(records: readonly SlumpRecord[], now: number, evalIntervalMs: number): SlumpWindow {
  const kept = records.filter((r) => r.t > now - SLUMP.historyDays * DAY_MS && r.t <= now);
  if (new Set(kept.map((r) => r.hari)).size < SLUMP.minDays) return DEFAULT_SLUMP;
  const each = evalIntervalMs / 60_000;
  const atScreen = new Array<number>(24).fill(0);
  const tired = new Array<number>(24).fill(0);
  for (const r of kept) {
    if (!r.dinilai || !isOf(AT_SCREEN, r.label)) continue;
    const hour = new Date(r.t).getHours();
    atScreen[hour] += each;
    if (isOf(FATIGUE, r.label)) tired[hour] += each;
  }
  let best: { hour: number; share: number } | null = null;
  for (let hour = 0; hour < 24; hour++) {
    if (atScreen[hour] < SLUMP.minHourMinutes) continue;
    const share = tired[hour] / atScreen[hour];
    if (best === null || share > best.share) best = { hour, share };
  }
  if (best === null || tired[best.hour] < SLUMP.minTiredMinutes) return DEFAULT_SLUMP;
  return { startHour: best.hour, endHour: best.hour + 1, personal: true };
}

export const inSlump = (now: number, window: SlumpWindow) => {
  const hour = new Date(now).getHours();
  return hour >= window.startHour && hour < window.endHour;
};

// ── Phase ───────────────────────────────────────────────────────────────────────

export type PhaseReason =
  | "no-label" // nothing judged yet in this session
  | "not-assessed" // the quality gate says the camera cannot judge now
  | "away"
  | "mostly-not-assessed" // < knownMinJudged of the recent evaluations judged
  | "asleep"
  | "tired"
  | "mildly-tired"
  | "kss"
  | "ready"
  | "not-enough-evidence";

export type PhaseResult = { fase: Phase; jam_rawan: boolean; reason: PhaseReason };

export type PhaseInput = {
  now: number; // wall clock ms
  label: Label | null; // the label shown now (after hysteresis); null before the first one
  quality: QualityLevel | null; // the quality level shown now (quality.ts stepQuality); null before the first one
  recent: readonly Pick<EvaluationRecord, "t" | "label" | "dinilai">[]; // local history; the last recentMinutes are used
  menitSejakJeda: number | null;
  kss: Pick<KssRecord, "kss" | "t"> | null; // the latest answer
  slump: SlumpWindow;
  evalIntervalMs: number;
};

export function energyPhase(input: PhaseInput): PhaseResult {
  const jam_rawan = inSlump(input.now, input.slump);
  const result = (fase: Phase, reason: PhaseReason): PhaseResult => ({ fase, jam_rawan, reason });
  const { label, quality, now } = input;
  const lookbackMs = PHASE.recentMinutes * 60_000;
  const isRecent = (t: number) => t > now - lookbackMs && t <= now;

  if (label === null || quality === null) return result("tidak tahu", "no-label");
  if (quality === "tidak-dinilai") return result("tidak tahu", "not-assessed");
  if (label === "tidak di depan layar") return result("tidak tahu", "away");
  const recent = input.recent.filter((r) => isRecent(r.t));
  const judged = recent.filter((r) => r.dinilai).length;
  if (recent.length > 0 && judged / recent.length < PHASE.knownMinJudged) return result("tidak tahu", "mostly-not-assessed");

  if (label === "tertidur") return result("rendah berat", "asleep");
  if (label === "lelah") return result("rendah berat", "tired");
  if (label === "lelah ringan") return result("rendah ringan", "mildly-tired");
  if (input.kss !== null && input.kss.kss >= PHASE.kssLow && isRecent(input.kss.t)) return result("rendah ringan", "kss");

  const expected = lookbackMs / input.evalIntervalMs;
  const ready =
    READY_QUALITY.includes(quality) &&
    !recent.some((r) => isOf(FATIGUE, r.label)) &&
    judged / expected >= PHASE.readyMinJudged &&
    input.menitSejakJeda !== null &&
    input.menitSejakJeda < PHASE.readyMaxMinutesSinceBreak;
  return ready ? result("siap fokus", "ready") : result("biasa", "not-enough-evidence");
}
