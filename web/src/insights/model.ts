import { dayKey, type BreakRecord, type DayData, type EvaluationRecord } from "../history.ts";
import { LABELS, type Label, type Tanda } from "../rules.ts";
import { STATE_NAME } from "../stateCopy.ts";

// The Insights page as numbers (NOTES D-78): pure, no DOM. Everything comes from the local history
// (history.ts, IndexedDB) and is computed on this device. Only judged evaluations (dinilai) count, and each
// one stands for evalIntervalMs, so time with no evaluation never counts as watched. Labels stay the
// Indonesian keys of the data; the English names come from stateCopy.ts.

// ── Ranges ─────────────────────────────────────────────────────────────────────

export type RangeKey = "today" | "7d" | "30d";

export const RANGES: readonly { key: RangeKey; label: string; days: number }[] = [
  { key: "today", label: "Today", days: 1 },
  { key: "7d", label: "7 days", days: 7 },
  { key: "30d", label: "30 days", days: 30 },
];

const rangeLength = (range: RangeKey) => RANGES.find((r) => r.key === range)?.days ?? 7;

// Every calendar day of the range, oldest first, ending today.
export function rangeDays(now: number, days: number): string[] {
  const noon = new Date(now);
  noon.setHours(12, 0, 0, 0); // a day boundary moved by DST never skips or repeats a day
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(noon);
    d.setDate(noon.getDate() - (days - 1 - i));
    return dayKey(d.getTime());
  });
}

// ── States ─────────────────────────────────────────────────────────────────────

export type StateMinutes = Record<Label, number>;

export const noMinutes = (): StateMinutes => ({
  normal: 0,
  "lelah ringan": 0,
  lelah: 0,
  tertidur: 0,
  "tidak di depan layar": 0,
});

// At the screen = every state but Away. Fatigue = the three tired states. Heavy = Tired and Asleep.
export const AT_SCREEN: readonly Label[] = ["normal", "lelah ringan", "lelah", "tertidur"];
export const FATIGUE: readonly Label[] = ["lelah ringan", "lelah", "tertidur"];
export const HEAVY: readonly Label[] = ["lelah", "tertidur"];

export const sumOf = (m: StateMinutes, labels: readonly Label[]) => labels.reduce((s, l) => s + m[l], 0);

// Ties go to the heavier state, as in insight.ts mostShown; Away is the lightest.
const WEIGHT: Readonly<Record<Label, number>> = {
  "tidak di depan layar": 0,
  normal: 1,
  "lelah ringan": 2,
  lelah: 3,
  tertidur: 4,
};
const EPS = 1e-9;

export function dominantState(m: StateMinutes): Label | null {
  let best: Label | null = null;
  for (const l of LABELS) {
    if (m[l] <= EPS) continue;
    if (best === null || m[l] > m[best] + EPS || (Math.abs(m[l] - m[best]) <= EPS && WEIGHT[l] > WEIGHT[best])) best = l;
  }
  return best;
}

// The rules behind a label (rules.ts TANDA), as the tooltip names them.
export const TANDA_NAME: Readonly<Record<Tanda, string>> = {
  mata_sering_tertutup: "Eyes often closed",
  kedipan_lambat: "Slow blinks",
  menguap: "Yawning",
  mata_terpejam_lama: "Long eye closures",
  kedipan_sering: "Frequent blinks",
  tertidur_mata_terpejam: "Eyes shut for minutes",
  tertidur_mata_tak_terlihat: "Eyes out of view for minutes",
  pola_kedip: "Blink pattern",
};

// ── Formatting ─────────────────────────────────────────────────────────────────

const two = (n: number) => String(n).padStart(2, "0");

// "45 min", "3 h 05 min". What would round to 0 but is not 0 reads "< 1 min".
export function formatDuration(minutes: number): string {
  if (minutes > 0 && minutes < 0.5) return "< 1 min";
  const total = Math.round(minutes);
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return hours === 0 ? `${rest} min` : `${hours} h ${two(rest)} min`;
}

export function formatShare(x: number): string {
  if (x > 0 && x < 0.005) return "<1%";
  return `${Math.round(x * 100)}%`;
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const clock = (minuteOfDay: number) => `${two(Math.floor(minuteOfDay / 60) % 24)}:${two(minuteOfDay % 60)}`;

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseDay(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, 12);
}

// short "Tue 27" · medium "Tue 27 Oct" · long "Tuesday 27 Oct"
export function dayLabel(day: string, form: "short" | "medium" | "long" = "medium"): string {
  const d = parseDay(day);
  const weekday = WEEKDAY[d.getDay()];
  if (form === "long") return `${weekday} ${d.getDate()} ${MONTH[d.getMonth()]}`;
  const short = `${weekday.slice(0, 3)} ${d.getDate()}`;
  return form === "short" ? short : `${short} ${MONTH[d.getMonth()]}`;
}

export const weekdayOf = (day: string) => WEEKDAY[parseDay(day).getDay()].slice(0, 3);
export const dateOf = (day: string) => parseDay(day).getDate();

// ── The records of a range ─────────────────────────────────────────────────────

export type RangeSlice = {
  range: RangeKey;
  days: readonly string[]; // every calendar day of the range, oldest first
  judged: readonly EvaluationRecord[]; // dinilai only, sorted by time
  breaks: readonly BreakRecord[]; // sorted by start
  each: number; // minutes one evaluation stands for
};

export function sliceRange(data: DayData | null, range: RangeKey, now: number, evalIntervalMs: number): RangeSlice {
  const days = rangeDays(now, rangeLength(range));
  const inRange = new Set(days);
  return {
    range,
    days,
    judged: (data?.evaluasi ?? []).filter((r) => r.dinilai && inRange.has(r.hari)).sort((a, b) => a.t - b.t),
    breaks: (data?.jeda ?? []).filter((b) => inRange.has(b.hari)).sort((a, b) => a.mulai - b.mulai),
    each: evalIntervalMs / 60_000,
  };
}

export type Totals = {
  judged: number; // minutes, every state including Away
  atScreen: number; // minutes, Away left out
  minutes: StateMinutes;
  breaks: number;
  daysWithData: number;
};

export function totalsOf(slice: RangeSlice): Totals {
  const minutes = noMinutes();
  for (const r of slice.judged) minutes[r.label] += slice.each;
  return {
    judged: sumOf(minutes, LABELS),
    atScreen: sumOf(minutes, AT_SCREEN),
    minutes,
    breaks: slice.breaks.length,
    daysWithData: new Set(slice.judged.map((r) => r.hari)).size,
  };
}

// "31 h 20 min watched · 9 breaks · 74% Normal"; the share is of the time at the screen.
export function summaryLine(t: Totals): string {
  const parts = [`${formatDuration(t.judged)} watched`, plural(t.breaks, "break", "breaks")];
  if (t.atScreen > 0) parts.push(`${formatShare(t.minutes.normal / t.atScreen)} Normal`);
  return parts.join(" · ");
}

// ── Blocks: one bubble each ────────────────────────────────────────────────────

// ⚠️ 15-minute blocks, wider when a range would need more than MAX_BUBBLES of them (the detector shares the tab).
export const BLOCK_MINUTES = [15, 30, 60, 120] as const;
export const MAX_BUBBLES = 700;

export type DayPart = "morning" | "midday" | "afternoon" | "evening";

export const DAY_PARTS: readonly { key: DayPart; name: string; phrase: string; span: string }[] = [
  { key: "morning", name: "Morning", phrase: "in the morning", span: "before 11:00" },
  { key: "midday", name: "Midday", phrase: "around midday", span: "11:00–14:00" },
  { key: "afternoon", name: "Afternoon", phrase: "in the afternoon", span: "14:00–17:00" },
  { key: "evening", name: "Evening", phrase: "in the evening", span: "from 17:00" },
];

export const partOf = (hour: number): DayPart =>
  hour < 11 ? "morning" : hour < 14 ? "midday" : hour < 17 ? "afternoon" : "evening";

const minuteOfDay = (t: number) => {
  const d = new Date(t);
  return d.getHours() * 60 + d.getMinutes();
};

export type Sign = { tanda: Tanda; count: number };

export type Block = {
  key: string; // day|startMin
  day: string;
  startMin: number; // minute of the day the block starts
  size: number; // block length in minutes
  start: number; // wall clock ms
  minutes: StateMinutes; // judged minutes by shown state
  total: number; // judged minutes in the block (area of the bubble)
  state: Label; // the state shown most (ties: the heavier)
  part: DayPart;
  signs: Sign[]; // the rules that fired most in the block, at most 3
};

export function blockSizeFor(judged: readonly EvaluationRecord[], max: number = MAX_BUBBLES): number {
  for (const size of BLOCK_MINUTES) {
    const keys = new Set<string>();
    for (const r of judged) {
      keys.add(`${r.hari}|${Math.floor(minuteOfDay(r.t) / size)}`);
      if (keys.size > max) break;
    }
    if (keys.size <= max) return size;
  }
  return BLOCK_MINUTES[BLOCK_MINUTES.length - 1];
}

export function buildBlocks(judged: readonly EvaluationRecord[], each: number, size: number): Block[] {
  const groups = new Map<string, { day: string; startMin: number; minutes: StateMinutes; signs: Map<Tanda, number> }>();
  for (const r of judged) {
    if (!r.dinilai) continue;
    const startMin = Math.floor(minuteOfDay(r.t) / size) * size;
    const key = `${r.hari}|${startMin}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { day: r.hari, startMin, minutes: noMinutes(), signs: new Map() }));
    g.minutes[r.label] += each;
    for (const t of r.tanda ?? []) g.signs.set(t, (g.signs.get(t) ?? 0) + 1);
  }
  const blocks: Block[] = [];
  for (const [key, g] of groups) {
    const state = dominantState(g.minutes);
    if (state === null) continue;
    const d = parseDay(g.day);
    blocks.push({
      key,
      day: g.day,
      startMin: g.startMin,
      size,
      start: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, g.startMin).getTime(),
      minutes: g.minutes,
      total: sumOf(g.minutes, LABELS),
      state,
      part: partOf(Math.floor(g.startMin / 60)),
      signs: [...g.signs]
        .map(([tanda, count]) => ({ tanda, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 3),
    });
  }
  return blocks.sort((a, b) => a.start - b.start);
}

// ── Groupings of the bubbles ───────────────────────────────────────────────────

export type GroupMode = "all" | "state" | "time" | "day";

export const GROUP_MODES: readonly { key: GroupMode; label: string }[] = [
  { key: "all", label: "All" },
  { key: "state", label: "By state" },
  { key: "time", label: "By time of day" },
  { key: "day", label: "By day" },
];

export type Cluster = { key: string; label: string; minutes: StateMinutes; total: number; count: number };

export function clusterKey(b: Block, mode: GroupMode): string {
  if (mode === "state") return b.state;
  if (mode === "time") return b.part;
  if (mode === "day") return b.day;
  return "all";
}

export function clusterLabel(key: string, mode: GroupMode): string {
  if (mode === "state") return STATE_NAME[key as Label] ?? key;
  if (mode === "time") return DAY_PARTS.find((p) => p.key === key)?.name ?? key;
  if (mode === "day") return dayLabel(key, "short");
  return "All";
}

// Non-empty clusters in reading order: states lightest to heaviest then Away, parts of the day, days.
export function groupBlocks(blocks: readonly Block[], mode: GroupMode): Cluster[] {
  const map = new Map<string, Cluster>();
  for (const b of blocks) {
    const key = clusterKey(b, mode);
    let c = map.get(key);
    if (!c) map.set(key, (c = { key, label: clusterLabel(key, mode), minutes: noMinutes(), total: 0, count: 0 }));
    for (const l of LABELS) c.minutes[l] += b.minutes[l];
    c.total += b.total;
    c.count += 1;
  }
  const order: readonly string[] =
    mode === "state" ? LABELS : mode === "time" ? DAY_PARTS.map((p) => p.key) : [...map.keys()].sort();
  return order.filter((k) => map.has(k)).map((k) => map.get(k)!);
}

// A grid of cells for n clusters, as square as the area allows; an incomplete last row is centered.
export type Cell = { x: number; y: number; w: number; h: number };

export function clusterCells(n: number, width: number, height: number): Cell[] {
  if (n <= 0) return [];
  let cols = 1;
  let best = -1;
  for (let c = 1; c <= n; c++) {
    const rows = Math.ceil(n / c);
    const side = Math.min(width / c, height / rows);
    if (side > best + EPS) {
      best = side;
      cols = c;
    }
  }
  const rows = Math.ceil(n / cols);
  const w = width / cols;
  const h = height / rows;
  return Array.from({ length: n }, (_, i) => {
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? n - row * cols : cols;
    const offset = ((cols - inRow) * w) / 2;
    return { x: offset + (i % cols) * w, y: row * h, w, h };
  });
}

// ── Heatmap: hour × day ────────────────────────────────────────────────────────

// ⚠️ Display steps of the tired share (Mildly tired, Tired or Asleep / time at the screen).
export const HEAT_STEPS = [0.1, 0.25, 0.5] as const;
export const HEAT_LEGEND = ["0%", "< 10%", "10–25%", "25–50%", "≥ 50%"] as const;

export function heatBin(share: number): number {
  if (share <= 0) return 0;
  const i = HEAT_STEPS.findIndex((s) => share < s);
  return i === -1 ? HEAT_STEPS.length + 1 : i + 1;
}

export type HeatCell = {
  day: string;
  hour: number;
  atScreen: number; // judged minutes at the screen
  fatigue: number; // of which Mildly tired, Tired or Asleep
  away: number; // judged minutes Away (never in the share)
  share: number | null; // null: no time at the screen in this hour
  bin: number | null;
};

export type Heatmap = { hours: number[]; rows: { day: string; cells: HeatCell[] }[] };

// The days the charts show: from the first day with data to the last day of the range.
export function chartDays(slice: RangeSlice): string[] {
  const withData = new Set([...slice.judged.map((r) => r.hari), ...slice.breaks.map((b) => b.hari)]);
  const first = slice.days.findIndex((d) => withData.has(d));
  return first === -1 ? [] : slice.days.slice(first);
}

export function buildHeatmap(slice: RangeSlice): Heatmap {
  if (slice.judged.length === 0) return { hours: [], rows: [] };
  const cells = new Map<string, HeatCell>();
  let lo = 23;
  let hi = 0;
  for (const r of slice.judged) {
    const hour = new Date(r.t).getHours();
    lo = Math.min(lo, hour);
    hi = Math.max(hi, hour);
    const key = `${r.hari}|${hour}`;
    let c = cells.get(key);
    if (!c) cells.set(key, (c = { day: r.hari, hour, atScreen: 0, fatigue: 0, away: 0, share: null, bin: null }));
    if (r.label === "tidak di depan layar") c.away += slice.each;
    else {
      c.atScreen += slice.each;
      if (FATIGUE.includes(r.label)) c.fatigue += slice.each;
    }
  }
  const hours = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  return {
    hours,
    rows: chartDays(slice).map((day) => ({
      day,
      cells: hours.map((hour) => {
        const c = cells.get(`${day}|${hour}`) ?? { day, hour, atScreen: 0, fatigue: 0, away: 0, share: null, bin: null };
        if (c.atScreen > EPS) {
          c.share = c.fatigue / c.atScreen;
          c.bin = heatBin(c.share);
        }
        return c;
      }),
    })),
  };
}

// ── Day by day ─────────────────────────────────────────────────────────────────

export type DayTotal = {
  day: string;
  minutes: StateMinutes;
  atScreen: number;
  judged: number;
  breaks: number;
  breakMinutes: number;
};

export function buildDaily(slice: RangeSlice): DayTotal[] {
  return chartDays(slice).map((day) => {
    const minutes = noMinutes();
    for (const r of slice.judged) if (r.hari === day) minutes[r.label] += slice.each;
    const breaks = slice.breaks.filter((b) => b.hari === day);
    return {
      day,
      minutes,
      atScreen: sumOf(minutes, AT_SCREEN),
      judged: sumOf(minutes, LABELS),
      breaks: breaks.length,
      breakMinutes: breaks.reduce((s, b) => s + b.menit, 0),
    };
  });
}

// ── The essay ──────────────────────────────────────────────────────────────────

// ⚠️ Below these a step is left out rather than said on thin data (minutes).
export const ESSAY_MIN = {
  shareAtScreen: 10, // step "share": time at the screen
  partAtScreen: 15, // step "timeOfDay": a part of the day counts when it has this much screen time
  fatigue: 5, // step "timeOfDay": tired minutes in the range
  heavyDay: 1, // step "heaviestDay": Tired + Asleep minutes on the heaviest day
  breaksScreen: 60, // step "breaks" with no break: only said after this much screen time
} as const;

export type EssayFacts = {
  range: RangeKey;
  rangeDays: number;
  daysWithData: number;
  blockSize: number;
  totals: Totals;
  parts: { part: DayPart; atScreen: number; fatigue: number }[];
  days: { day: string; heavy: number }[]; // days with judged data
  breaks: { count: number; gaps: number[] }; // gaps: minutes between breaks of one session
};

export function essayFacts(slice: RangeSlice, blockSize: number): EssayFacts {
  const totals = totalsOf(slice);
  const parts = DAY_PARTS.map((p) => ({ part: p.key, atScreen: 0, fatigue: 0 }));
  const heavy = new Map<string, number>();
  for (const r of slice.judged) {
    if (!heavy.has(r.hari)) heavy.set(r.hari, 0);
    if (r.label === "tidak di depan layar") continue;
    const p = parts.find((x) => x.part === partOf(new Date(r.t).getHours()))!;
    p.atScreen += slice.each;
    if (FATIGUE.includes(r.label)) p.fatigue += slice.each;
    if (HEAVY.includes(r.label)) heavy.set(r.hari, heavy.get(r.hari)! + slice.each);
  }
  const sessions = new Map<string, BreakRecord[]>();
  for (const b of slice.breaks) {
    const key = `${b.hari}|${b.sesi}`;
    sessions.set(key, [...(sessions.get(key) ?? []), b]);
  }
  const gaps: number[] = [];
  for (const list of sessions.values()) {
    for (let i = 1; i < list.length; i++) {
      const gap = (list[i].mulai - list[i - 1].selesai) / 60_000;
      if (gap > 0) gaps.push(gap);
    }
  }
  return {
    range: slice.range,
    rangeDays: slice.days.length,
    daysWithData: totals.daysWithData,
    blockSize,
    totals,
    parts,
    days: [...heavy].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, h]) => ({ day, heavy: h })),
    breaks: { count: slice.breaks.length, gaps },
  };
}

// A number in the text: set in mono and underlined in a state's color ("ink": not a state).
export type Mark = "ink" | Label;
export type Span = string | { text: string; mark: Mark };
export type StepId = "watched" | "share" | "timeOfDay" | "heaviestDay" | "breaks" | "closing";
export type EssayStep = {
  id: StepId;
  mode: GroupMode; // how the bubbles group while this step is read
  highlight: string | null; // the cluster key that stays bright
  spans: Span[];
};

const n = (text: string, mark: Mark = "ink"): Span => ({ text, mark });
export const stepText = (step: EssayStep) => step.spans.map((s) => (typeof s === "string" ? s : s.text)).join("");

function listJoin(items: Span[][]): Span[] {
  const out: Span[] = [];
  items.forEach((item, i) => {
    if (i > 0) out.push(i === items.length - 1 ? " and " : ", ");
    out.push(...item);
  });
  return out;
}

export function essaySteps(f: EssayFacts): EssayStep[] {
  const t = f.totals;
  if (t.judged <= EPS) return [];
  const steps: EssayStep[] = [];

  // (a) How much was watched.
  const watched: Span[] =
    f.range === "today"
      ? ["Today, Equilibre has watched ", n(formatDuration(t.judged)), " of your time so far."]
      : [
          `In the last ${f.rangeDays} days, Equilibre watched `,
          n(formatDuration(t.judged)),
          " of your time, on ",
          n(plural(f.daysWithData, "day", "days")),
          ".",
        ];
  watched.push(" Each bubble is a ", n(`${f.blockSize}-minute`), " stretch; the more of it was read, the bigger the bubble.");
  steps.push({ id: "watched", mode: "all", highlight: null, spans: watched });

  // (b) Share by state, of the time at the screen.
  if (t.atScreen >= ESSAY_MIN.shareAtScreen) {
    const shares = AT_SCREEN.map((l) => ({ l, share: t.minutes[l] / t.atScreen })).filter((s) => s.share > 0);
    shares.sort((a, b) => b.share - a.share || WEIGHT[b.l] - WEIGHT[a.l]);
    const [top, ...rest] = shares;
    const spans: Span[] =
      top.share >= 0.5
        ? ["Most of your screen time — ", n(formatShare(top.share), top.l), ` — was ${STATE_NAME[top.l]}.`]
        : ["The biggest share of your screen time, ", n(formatShare(top.share), top.l), `, was ${STATE_NAME[top.l]}.`];
    if (rest.length > 0) {
      const items = rest.map((s) => [`${STATE_NAME[s.l]} `, n(formatShare(s.share), s.l)]);
      spans.push(" ", ...listJoin(items), rest.length === 1 ? " was the rest." : " made up the rest.");
    }
    const away = t.minutes["tidak di depan layar"];
    if (away >= 0.5) spans.push(" Another ", n(formatDuration(away), "tidak di depan layar"), " was time away from the screen.");
    steps.push({ id: "share", mode: "state", highlight: top.l, spans });
  }

  // (c) When tired moments happen, by part of the day.
  const fatigue = sumOf(t.minutes, FATIGUE);
  const parts = f.parts.filter((p) => p.atScreen >= ESSAY_MIN.partAtScreen).map((p) => ({ ...p, share: p.fatigue / p.atScreen }));
  if (fatigue >= ESSAY_MIN.fatigue && parts.length >= 2) {
    const heaviest = parts.reduce((a, b) => (b.share > a.share ? b : a));
    const lightest = parts.reduce((a, b) => (b.share < a.share ? b : a));
    const part = DAY_PARTS.find((p) => p.key === heaviest.part)!;
    const spans: Span[] = [
      `Tired moments show up most ${part.phrase} (${part.span}): `,
      n(formatShare(heaviest.share), "lelah"),
      " of your screen time then, ",
      n(formatDuration(heaviest.fatigue), "lelah"),
      " in all.",
    ];
    if (lightest.part !== heaviest.part) {
      const calm = DAY_PARTS.find((p) => p.key === lightest.part)!;
      spans.push(
        ...(lightest.fatigue < 0.5
          ? [` ${calm.phrase.charAt(0).toUpperCase()}${calm.phrase.slice(1)} there were none.`]
          : [` ${calm.name} was the calmest, at `, n(formatShare(lightest.share), "lelah ringan"), "."]),
      );
    }
    steps.push({ id: "timeOfDay", mode: "time", highlight: heaviest.part, spans });
  }

  // (d) The heaviest day, by Tired and Asleep minutes.
  if (f.days.length >= 2) {
    const heaviest = f.days.reduce((a, b) => (b.heavy > a.heavy ? b : a));
    if (heaviest.heavy >= ESSAY_MIN.heavyDay) {
      const others = f.days.filter((d) => d.day !== heaviest.day);
      const mean = others.reduce((s, d) => s + d.heavy, 0) / others.length;
      const spans: Span[] = [
        "Your heaviest day was ",
        n(dayLabel(heaviest.day, "long")),
        ", with ",
        n(formatDuration(heaviest.heavy), "lelah"),
        " Tired or Asleep.",
      ];
      spans.push(
        ...(mean < 0.5
          ? [others.length === 1 ? " The other day had none." : " The other days had none."]
          : [others.length === 1 ? " The other day had " : " The other days averaged ", n(formatDuration(mean), "lelah"), "."]),
      );
      steps.push({ id: "heaviestDay", mode: "day", highlight: heaviest.day, spans });
    }
  }

  // (e) Breaks: counted and spaced, nothing more claimed.
  if (f.breaks.count > 0) {
    const spans: Span[] = ["You took ", n(plural(f.breaks.count, "break", "breaks"))];
    if (f.breaks.gaps.length > 0) {
      const mean = f.breaks.gaps.reduce((a, b) => a + b, 0) / f.breaks.gaps.length;
      spans.push(", about ", n(formatDuration(mean)), " apart on average.");
    } else spans.push(".");
    steps.push({ id: "breaks", mode: "all", highlight: null, spans });
  } else if (t.atScreen >= ESSAY_MIN.breaksScreen) {
    steps.push({
      id: "breaks",
      mode: "all",
      highlight: null,
      spans: ["No break was recorded in ", n(formatDuration(t.atScreen)), " at the screen."],
    });
  }

  // (f) Closing.
  steps.push({
    id: "closing",
    mode: "state",
    highlight: null,
    spans: [
      "This is a pattern, not a diagnosis. It was computed on this device from ",
      n(plural(f.daysWithData, "day", "days")),
      " of your own readings.",
    ],
  });
  return steps;
}
