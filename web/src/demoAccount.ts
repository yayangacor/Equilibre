import type { Account } from "./auth.ts";
import {
  dayKey,
  type BreakRecord,
  type EvaluationRecord,
  type Feedback,
  type KssRecord,
  type LabelCorrectionRecord,
  type RecommendationRecord,
} from "./history.ts";
import type { Label, Tanda } from "./rules.ts";

// Demo account (?demo=rina, plans/P19): opens the app without signing in and fills a history of its own with two
// weeks of sample days for Rina, the composite persona of the pitch (27, finance admin in Jakarta, hybrid: office
// on Tuesday to Thursday). The days follow what the 7 testers and the research found: mornings mostly fine, a dip
// after lunch, the worst afternoon after back-to-back meetings, office days heavier than WFH days, one short-sleep
// day. Nothing here comes from a real person, and the app says so on every page (demoNote). Pure: no DOM, no
// IndexedDB; the same `now` always gives the same days.

export type DemoPersona = "rina";

export function parseDemo(value: string | null): DemoPersona | null {
  return value === "rina" ? "rina" : null;
}

export const DEMO_ACCOUNTS: Record<DemoPersona, Account> = {
  rina: { id: "demo-rina", name: "Rina Kartika", email: "Demo account · sample data" },
};

export const demoNote = (persona: DemoPersona) =>
  `Demo account. ${DEMO_ACCOUNTS[persona].name.split(" ")[0]} is a composite persona built from our 7 testers and ` +
  "the research; her history is sample data generated in this browser, not a real person's. Turn on the camera " +
  "to add your own readings on top.";

// Bump when the generator changes, so a browser that already holds an older seed gets the new days.
export const SEED_VERSION = 2;
export const seedKey = (persona: DemoPersona) => `equilibre-demo-seed@${persona}`;
// Reseeded once a day, so "today" and "the last 7 days" always have data.
export const seedStamp = (now: number) => `${SEED_VERSION}|${dayKey(now)}`;

export const DEMO_DAYS_BACK = 14;
const EACH_MS = 10_000; // EVAL_INTERVAL_MS in main.ts
const BLOCK_MIN = 5;
const BREAK_MIN = 2; // BREAK_MIN_MS in features.ts

export type DemoHistory = {
  evaluasi: EvaluationRecord[];
  jeda: BreakRecord[];
  rekomendasi: RecommendationRecord[];
  koreksi_label: LabelCorrectionRecord[];
  kss: KssRecord[];
};

// ── Random numbers that repeat for the same day ────────────────────────────────

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function random(seed: number) {
  let a = seed;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    between: (lo: number, hi: number) => lo + (hi - lo) * next(),
    int: (lo: number, hi: number) => Math.floor(lo + (hi - lo + 1) * next()),
    pick: <T>(items: readonly T[]) => items[Math.floor(next() * items.length)],
  };
}
type Random = ReturnType<typeof random>;

// ── One working day as a plan of 5-minute blocks ───────────────────────────────

const AWAY: Label = "tidak di depan layar";
type Span = [start: number, end: number]; // minutes since midnight

export type DayKind = { office: boolean; meetings: Span[]; shortSleep: boolean; isToday: boolean };

// Tuesday to Thursday at the office; Wednesday is the back-to-back meeting day. Today is always a working day, so
// the demo has something to show on any day of the week.
export function dayKind(date: Date, isToday: boolean, shortSleep: boolean): DayKind {
  const weekday = isToday && (date.getDay() === 0 || date.getDay() === 6) ? 2 : date.getDay();
  const meetings: Record<number, Span[]> = {
    2: [[600, 660]],
    3: [[600, 660], [810, 930]],
    4: [[900, 960]],
  };
  return { office: weekday >= 2 && weekday <= 4, meetings: meetings[weekday] ?? [], shortSleep, isToday };
}

// Chance of each fatigue label at a minute of the day: fine in the morning, a dip after lunch, worse after
// meetings, on office days and after a short night (Van Dongen 2003; WTI 2023: inefficient meetings).
function fatigueChance(kind: DayKind, minute: number, afterMeetings: boolean): { mild: number; tired: number } {
  let mild = minute < 720 ? 0.04 : minute < 930 ? 0.3 : 0.22;
  let tired = minute < 720 ? 0 : minute < 930 ? 0.06 : 0.05;
  const factor = (kind.office ? 1.15 : 0.85) * (kind.shortSleep ? 1.7 : 1) * (afterMeetings ? 1.6 : 1);
  if (kind.shortSleep && minute < 720) mild = 0.14;
  mild = Math.min(0.6, mild * factor);
  tired = Math.min(0.3, tired * factor);
  return { mild, tired };
}

type Block = { start: number; label: Label };

function planBlocks(kind: DayKind, start: number, end: number, rng: Random): Block[] {
  const away: Span[] = [[720, 780], ...kind.meetings.filter(() => kind.office)];
  // One or two short walks away from the desk (coffee, toilet).
  for (let i = rng.int(1, 2); i > 0; i--) {
    const at = rng.pick([625, 690, 805, 955, 985]);
    away.push([at, at + BLOCK_MIN]);
  }
  const lastMeetingEnd = Math.max(0, ...kind.meetings.filter(() => kind.office).map(([, e]) => e));
  const blocks: Block[] = [];
  let previous: Label = "normal";
  for (let m = start; m < end; m += BLOCK_MIN) {
    if (away.some(([s, e]) => m >= s && m < e)) {
      blocks.push({ start: m, label: AWAY });
      continue;
    }
    const afterMeetings = lastMeetingEnd > 0 && m >= lastMeetingEnd && m < lastMeetingEnd + 90;
    const { mild, tired } = fatigueChance(kind, m, afterMeetings);
    // Fatigue tends to last: a tired block makes the next one likelier to stay tired.
    const stay: number = previous === "lelah ringan" || previous === "lelah" ? 0.35 : 0;
    const roll = rng.next();
    const label: Label =
      roll < tired + stay * 0.3 ? "lelah" : roll < tired + mild + stay ? "lelah ringan" : "normal";
    blocks.push({ start: m, label });
    previous = label;
  }
  return blocks;
}

// ── From blocks to records ─────────────────────────────────────────────────────

const MILD_SIGNS: readonly Tanda[] = ["kedipan_lambat", "kedipan_lambat", "mata_sering_tertutup", "menguap"];
const TIRED_SIGNS: readonly Tanda[] = ["mata_sering_tertutup", "kedipan_lambat", "menguap", "mata_terpejam_lama"];

// Window numbers that match the rules (rules.ts): perclos ≥ 0.08 counts, ≥ 0.15 is "lelah" on its own; a blink of
// 2× the ±235 ms baseline counts as slow.
function windowNumbers(label: Label, rng: Random) {
  if (label === AWAY) {
    return { tanda: [] as Tanda[], skor: 0, poin: 0, nums: { mata_tertutup_lama: 0, menguap: 0, pct_wajah_hilang: 1 } };
  }
  const round = (x: number, d: number) => Number(x.toFixed(d));
  let tanda: Tanda[] = [];
  if (label === "lelah ringan") tanda = [rng.pick(MILD_SIGNS)];
  if (label === "lelah") {
    tanda = [...TIRED_SIGNS].sort(() => rng.next() - 0.5).slice(0, 3);
  }
  const has = (t: Tanda) => tanda.includes(t);
  const perclos = has("mata_sering_tertutup")
    ? rng.between(label === "lelah" ? 0.15 : 0.08, label === "lelah" ? 0.23 : 0.13)
    : rng.between(0.02, 0.07);
  const nums = {
    perclos: round(perclos, 3),
    kedip_per_menit: round(rng.between(11, label === "normal" ? 18 : 23), 1),
    durasi_kedip_ms: Math.round(has("kedipan_lambat") ? rng.between(480, 640) : rng.between(170, 260)),
    mata_tertutup_lama: has("mata_terpejam_lama") ? 1 : 0,
    menguap: has("menguap") ? 1 : 0,
    pct_kepala_menunduk: round(rng.between(0, 0.15), 3),
    pct_wajah_hilang: round(rng.between(0, 0.04), 3),
  };
  const poin = tanda.length;
  const skor = label === "lelah" ? 0.75 : poin / 4;
  return { tanda, skor, poin, nums };
}

const ADVICE = {
  "perlu jeda singkat": {
    minutes: 5,
    texts: [
      "Ayo jeda 5 menit. Kamu bisa mengistirahatkan mata dengan melihat benda jauh atau melakukan peregangan ringan.",
      "Ambil jeda 5 menit: lihat benda sejauh 6 meter selama 20 detik, lalu regangkan bahu dan leher.",
    ],
    sources: ["permenkes-48-2016-k3-perkantoran.md", "albulescu-2022-micro-break.md", "aao-20-20-20.md"],
  },
  "perlu jeda": {
    minutes: 10,
    texts: [
      "Jeda 10 menit dulu. Berdiri, berjalan sebentar, dan minum air sebelum lanjut bekerja.",
      "Kamu perlu jeda 10 menit. Tinggalkan layar, regangkan badan, lalu kembali dengan tugas yang lebih ringan.",
    ],
    sources: ["permenkes-48-2016-k3-perkantoran.md", "niosh-kewaspadaan-kerja.md", "albulescu-2022-micro-break.md"],
  },
} as const;

const REASON: Record<Tanda, string> = {
  mata_sering_tertutup: "Mata kamu lebih sering tertutup dari biasanya.",
  kedipan_lambat: "Kedipan matamu lebih lambat dari biasanya.",
  menguap: "Kamu beberapa kali menguap.",
  mata_terpejam_lama: "Mata kamu terpejam 1 detik atau lebih.",
  kedipan_sering: "Kamu berkedip lebih sering dari biasanya.",
  tertidur_mata_terpejam: "Mata kamu terpejam beberapa menit.",
  tertidur_mata_tak_terlihat: "Mata kamu tidak terlihat beberapa menit.",
  pola_kedip: "Pola kedipanmu mirip orang yang mengantuk.",
};

type DayResult = DemoHistory;

function oneDay(date: Date, kind: DayKind, now: number, rng: Random): DayResult {
  const out: DayResult = { evaluasi: [], jeda: [], rekomendasi: [], koreksi_label: [], kss: [] };
  const startMin = kind.office ? 520 : 495; // 08:40 at the office, 08:15 at home
  // Ends before 17:00: a 15-minute "evening" slice made Insights call the evening her worst time (seed v1).
  const endMin = kind.office ? 1015 : 1000;
  const at = (minute: number) => {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d.getTime() + minute * 60_000;
  };
  const sesi = at(startMin);
  const hari = dayKey(sesi);
  const blocks = planBlocks(kind, startMin, endMin, rng);

  // Advice after two fatigue blocks in a row in the afternoon, at most twice a day and 45 minutes apart. When Rina
  // took it, the next block(s) are away from the screen and she comes back fine.
  let lastAdvice = -Infinity;
  for (let i = 1; i < blocks.length - 2; i++) {
    const b = blocks[i];
    const tiredPair = [blocks[i - 1], b].every((x) => x.label === "lelah ringan" || x.label === "lelah");
    if (!tiredPair || b.start < 780 || b.start - lastAdvice < 45 || out.rekomendasi.length >= 2) continue;
    const t = at(b.start + BLOCK_MIN) - EACH_MS;
    if (t > now) break;
    const status = b.label === "lelah" ? "perlu jeda" : "perlu jeda singkat";
    const advice = ADVICE[status];
    const roll = rng.next();
    // Advice from the last 45 minutes of today is still waiting for Rina's answer.
    const fresh = kind.isToday && now - t < 45 * 60_000;
    const feedback: Feedback | null = fresh ? null : roll < 0.75 ? "sudah dilakukan" : roll < 0.9 ? "tidak relevan" : null;
    const hasil = {
      status,
      durasi_jeda_menit: advice.minutes,
      rekomendasi: rng.pick(advice.texts),
      alasan: REASON[windowNumbers(b.label, rng).tanda[0] ?? "kedipan_lambat"],
      sumber: [...advice.sources],
    };
    out.rekomendasi.push({
      t,
      hari,
      sesi,
      pemicu: "otomatis",
      label: b.label,
      status,
      hasil,
      teks: JSON.stringify(hasil),
      feedback,
      t_feedback: feedback ? t + rng.int(2, 8) * 60_000 : null,
    });
    lastAdvice = b.start;
    if (feedback === "sudah dilakukan") {
      const away = advice.minutes / BLOCK_MIN;
      for (let k = 1; k <= away; k++) if (blocks[i + k]) blocks[i + k].label = AWAY;
      if (blocks[i + away + 1] && blocks[i + away + 1].label !== AWAY) blocks[i + away + 1].label = "normal";
    }
  }

  // Records every 10 s. A new label shows after two windows in a row (RULES.confirmEvaluations); one or two hidden-tab
  // moments a day are not judged and carry the label over.
  const holds = Array.from({ length: rng.int(1, 2) }, () => at(rng.int(startMin + 30, endMin - 30)));
  let shown: Label = "normal";
  let pendingLabel: Label | null = null;
  let lastBreakEnd = sesi;
  let awayStart: number | null = null;
  const tiredTimes: number[] = [];
  for (const b of blocks) {
    for (let t = at(b.start) + EACH_MS; t <= at(b.start + BLOCK_MIN); t += EACH_MS) {
      if (t > now) break;
      const held = holds.some((h) => t >= h && t < h + 120_000);
      if (!held) {
        if (b.label === AWAY || shown === AWAY) shown = b.label;
        else if (b.label !== shown) {
          if (pendingLabel === b.label) {
            shown = b.label;
            pendingLabel = null;
          } else pendingLabel = b.label;
        }
      }
      // Breaks: away from the screen for 2 minutes or more.
      if (shown === AWAY && awayStart === null) awayStart = t - EACH_MS;
      if (shown !== AWAY && awayStart !== null) {
        if (t - EACH_MS - awayStart >= BREAK_MIN * 60_000) {
          out.jeda.push({
            hari,
            sesi,
            mulai: awayStart,
            selesai: t - EACH_MS,
            menit: Math.round((t - EACH_MS - awayStart) / 6_000) / 10,
            pemicu: "kamera",
          });
          lastBreakEnd = t - EACH_MS;
        }
        awayStart = null;
      }
      if (shown === "lelah") tiredTimes.push(t);
      while (tiredTimes.length && tiredTimes[0] <= t - 3_600_000) tiredTimes.shift();
      const w = windowNumbers(shown, rng);
      out.evaluasi.push({
        label: shown,
        skor: w.skor,
        tanda: w.tanda,
        ...w.nums,
        menit_sejak_jeda: Math.round(Math.max(0, (t - lastBreakEnd) / 60_000)),
        menit_lelah_60: Math.round((tiredTimes.length * EACH_MS) / 6_000) / 10,
        t,
        hari,
        sesi,
        dinilai: !held,
        sebab_ditahan: held ? "fps" : null,
        label_mentah: held ? null : b.label,
        poin: w.poin,
        hemat_daya: false,
      });
    }
  }

  // Sleepiness check (KSS 1–9) three times a day, when she is at the screen.
  for (const minute of [570, 855, 990]) {
    const t = at(minute + rng.int(0, 10));
    const r = out.evaluasi.find((e) => e.t >= t);
    if (!r || r.label === AWAY) continue;
    const base = r.label === "lelah" ? 7 : r.label === "lelah ringan" ? 6 : minute < 720 ? 3 : 4;
    out.kss.push({ t, hari, sesi, kss: Math.min(9, base + (kind.shortSleep ? 1 : 0) - rng.int(0, 1)), label_tampil: r.label, pengingat: false });
  }
  return out;
}

// The demo history at `now`: today (until now) and the working days of the DEMO_DAYS_BACK days before it.
export function demoHistory(persona: DemoPersona, now: number): DemoHistory {
  const all: DemoHistory = { evaluasi: [], jeda: [], rekomendasi: [], koreksi_label: [], kss: [] };
  const today = new Date(now);
  today.setHours(12, 0, 0, 0);
  // The short-sleep day: the working day closest to a week ago.
  let shortSleepDay: string | null = null;
  for (let back = DEMO_DAYS_BACK; back >= 0; back--) {
    const date = new Date(today);
    date.setDate(date.getDate() - back);
    const isToday = back === 0;
    if (!isToday && (date.getDay() === 0 || date.getDay() === 6)) continue;
    const key = dayKey(date.getTime());
    if (shortSleepDay === null && back <= 7) shortSleepDay = key;
    const rng = random(hash(`${persona}|${key}`));
    const day = oneDay(date, dayKind(date, isToday, key === shortSleepDay), now, rng);
    for (const store of Object.keys(all) as (keyof DemoHistory)[]) (all[store] as unknown[]).push(...day[store]);
  }
  // One correction: a "lelah ringan" morning window while reading a printed report, head down, which Rina marked as
  // normal (the false alarm the testers reported most).
  const morning = all.evaluasi.find((r) => r.label === "lelah ringan" && new Date(r.t).getHours() < 12 && r.dinilai);
  if (morning) {
    all.koreksi_label.push({
      t: morning.t + 30_000,
      hari: morning.hari,
      sesi: morning.sesi,
      label_tampil: "lelah ringan",
      label_koreksi: "normal",
      skor: morning.skor,
      alasan: ["Blinks average 520 ms, slower than usual (235 ms; limit 470 ms)."],
    });
  }
  return all;
}
