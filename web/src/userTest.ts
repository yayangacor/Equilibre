import type { KeyValueStore } from "./calibration.ts";
import type { Baseline } from "./calibration.ts";
import type { BreakRecord, EvaluationRecord, KssRecord, LabelCorrectionRecord } from "./history.ts";

// Remote user test (plans/P08, NOTES D-57): a tester opens the hosted demo on their own laptop with a
// personal link (?kode=EQ-XXXX), agrees to the test, calibrates, works for TEST_MINUTES with a KSS
// rating every 15 minutes, answers a short feedback form and sends one submission to the Google
// Sheet behind UJI_URL (Apps Script, equilibre/uji-pengguna/). Only what SUBMISSION_KEYS and the
// *_KEYS lists name is sent: labels and numbers, never video, images or face landmarks. Pure
// functions here; the card on the page is userTestPanel.ts.

// Apps Script web app (/exec) that receives submissions. Empty until it is deployed (P08 step 5):
// the card then offers the file download only.
export const UJI_URL = "https://script.google.com/macros/s/AKfycbyTHyKflpJSsveMM9bgHNPKSn_mWzCYehdCSF0dg8QbC-k8nkr6JcgQ3Ivpq4iF8KaL/exec";

export const TEST_MINUTES = 60;
export const EARLY_FINISH_MINUTES = 30;
export const COMMENT_MAX = 500;
export const DELETE_BY = "31 Oktober 2026";

// The test code stands in for an account: no name, no email, no password.
const CODE_PATTERN = /^EQ-[A-Z0-9]{4,8}$/;

export function parseCode(raw: string | null): string | null {
  const code = raw?.trim().toUpperCase() ?? "";
  return CODE_PATTERN.test(code) ? code : null;
}

// Each code keeps its own history database, away from any earlier use of the app in this browser.
export const testDbSuffix = (code: string) => `uji-${code.toLowerCase()}`;

// ── Questions ───────────────────────────────────────────────────────────────────

type Choice<V extends string | number> = { nilai: V; teks: string };
type Question<K extends string, V extends string | number> = { key: K; teks: string; pilihan: readonly Choice<V>[] };

const yesNo = [
  { nilai: "ya", teks: "Ya" },
  { nilai: "tidak", teks: "Tidak" },
] as const;

// Asked before the test, all optional: what can change how the camera reads the eyes.
export const INTAKE_QUESTIONS = [
  { key: "kacamata", teks: "Memakai kacamata selama uji?", pilihan: yesNo },
  {
    key: "kamera",
    teks: "Kamera yang dipakai",
    pilihan: [
      { nilai: "bawaan", teks: "Bawaan laptop" },
      { nilai: "eksternal", teks: "Webcam eksternal" },
    ],
  },
  {
    key: "cahaya",
    teks: "Cahaya di wajah",
    pilihan: [
      { nilai: "terang", teks: "Terang" },
      { nilai: "sedang", teks: "Sedang" },
      { nilai: "redup", teks: "Redup" },
    ],
  },
  { key: "dahi_tertutup", teks: "Ada yang menutupi alis atau dahi (poni, penutup kepala)?", pilihan: yesNo },
] as const satisfies readonly Question<string, string>[];

export type IntakeKey = (typeof INTAKE_QUESTIONS)[number]["key"];
export type Intake = Record<IntakeKey, string | null> & { jam_tidur: number | null };
export const SLEEP_HOURS = { min: 0, max: 16 } as const;

const scale5 = (low: string, high: string): readonly Choice<number>[] =>
  [1, 2, 3, 4, 5].map((n) => ({ nilai: n, teks: n === 1 ? `1 ${low}` : n === 5 ? `5 ${high}` : String(n) }));

const often = [
  { nilai: "tidak pernah", teks: "Tidak pernah" },
  { nilai: "1-2 kali", teks: "1–2 kali" },
  { nilai: "sering", teks: "Sering" },
] as const;

// Asked after the test. The comment is separate (free text, COMMENT_MAX).
export const FEEDBACK_QUESTIONS = [
  {
    key: "label_sesuai",
    teks: "Seberapa sering label Equilibre sesuai dengan yang kamu rasakan?",
    pilihan: scale5("hampir tidak pernah", "hampir selalu"),
  },
  {
    key: "alarm_palsu",
    teks: "Pernahkah Equilibre bilang kamu lelah padahal kamu merasa segar?",
    pilihan: often,
  },
  {
    key: "kantuk_terlewat",
    teks: "Pernahkah kamu merasa mengantuk tapi Equilibre tetap bilang normal?",
    pilihan: [...often, { nilai: "tidak mengantuk", teks: "Aku tidak mengantuk sama sekali" }],
  },
  {
    key: "mengganggu",
    teks: "Seberapa mengganggu Equilibre selama kamu bekerja?",
    pilihan: scale5("tidak mengganggu", "sangat mengganggu"),
  },
  {
    key: "mau_pakai",
    teks: "Seberapa mungkin kamu memakai Equilibre saat bekerja?",
    pilihan: scale5("tidak mungkin", "sangat mungkin"),
  },
] as const;

export type FeedbackKey = (typeof FEEDBACK_QUESTIONS)[number]["key"];
export type TestFeedback = Record<FeedbackKey, string | number> & { komentar: string };

// null: an answer is missing or not one of the choices.
export function checkFeedback(answers: Partial<Record<FeedbackKey, string | number>>, komentar: string): TestFeedback | null {
  const out: Partial<TestFeedback> = {};
  for (const q of FEEDBACK_QUESTIONS) {
    const value = answers[q.key];
    if (!q.pilihan.some((c) => c.nilai === value)) return null;
    out[q.key] = value;
  }
  return { ...(out as Record<FeedbackKey, string | number>), komentar: komentar.trim().slice(0, COMMENT_MAX) };
}

// Unknown or out-of-range answers become null rather than blocking the test.
export function checkIntake(answers: Partial<Record<IntakeKey, string>>, jamTidur: string): Intake {
  const out = {} as Intake;
  for (const q of INTAKE_QUESTIONS) {
    const value = answers[q.key] ?? null;
    out[q.key] = q.pilihan.some((c) => c.nilai === value) ? value : null;
  }
  const hours = jamTidur.trim() === "" ? NaN : Number(jamTidur.replace(",", "."));
  out.jam_tidur = Number.isFinite(hours) && hours >= SLEEP_HOURS.min && hours <= SLEEP_HOURS.max ? Math.round(hours * 2) / 2 : null;
  return out;
}

// ── Test state ──────────────────────────────────────────────────────────────────

export type TestState = {
  kode: string;
  setuju: number | null; // consent given (wall clock)
  isian: Intake | null;
  mulai: number | null; // first calibration after consent finished: the test clock starts
  selesai: number | null; // finished early, or when the feedback form was first shown after TEST_MINUTES
  selesai_awal: boolean;
  // Made once, at the first send, and kept across retries and reloads: the receiver stores one row per id,
  // so a retry after a lost answer never writes the submission twice.
  id_kiriman: string | null;
  terkirim: { id: string; t: number; duplikat: boolean } | null;
};

export type Phase = "persetujuan" | "kalibrasi" | "berjalan" | "feedback" | "terkirim";

export const freshState = (kode: string): TestState => ({
  kode,
  setuju: null,
  isian: null,
  mulai: null,
  selesai: null,
  selesai_awal: false,
  id_kiriman: null,
  terkirim: null,
});

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const withSubmissionId = (s: TestState, makeId: () => string): TestState =>
  s.id_kiriman !== null ? s : { ...s, id_kiriman: makeId() };

const MINUTE = 60_000;

export function phase(s: TestState, now: number): Phase {
  if (s.terkirim) return "terkirim";
  if (s.setuju === null) return "persetujuan";
  if (s.mulai === null) return "kalibrasi";
  if (s.selesai !== null || now - s.mulai >= TEST_MINUTES * MINUTE) return "feedback";
  return "berjalan";
}

// Minutes since the test clock started, capped at the end of the test.
export function elapsedMinutes(s: TestState, now: number): number {
  if (s.mulai === null) return 0;
  const end = Math.min(now, s.selesai ?? Infinity, s.mulai + TEST_MINUTES * MINUTE);
  return Math.max(0, (end - s.mulai) / MINUTE);
}

export const canFinishEarly = (s: TestState, now: number) =>
  phase(s, now) === "berjalan" && elapsedMinutes(s, now) >= EARLY_FINISH_MINUTES;

export const consent = (s: TestState, isian: Intake, t: number): TestState =>
  s.setuju === null ? { ...s, setuju: t, isian } : s;

// Only a calibration finished after consent starts the clock, so every tester calibrates under test conditions.
export const calibrated = (s: TestState, t: number): TestState =>
  s.setuju !== null && s.mulai === null && t >= s.setuju ? { ...s, mulai: t } : s;

// The end of the window that is sent: an early finish, or the full TEST_MINUTES.
export function finish(s: TestState, t: number): TestState {
  if (s.mulai === null || s.selesai !== null) return s;
  const full = s.mulai + TEST_MINUTES * MINUTE;
  return t >= full ? { ...s, selesai: full } : canFinishEarly(s, t) ? { ...s, selesai: t, selesai_awal: true } : s;
}

export const markSent = (s: TestState, id: string, t: number, duplikat: boolean): TestState => ({
  ...s,
  terkirim: { id, t, duplikat },
});

const stateKey = (kode: string) => `equilibre-uji-${kode}`;

export function saveTestState(store: KeyValueStore, s: TestState): boolean {
  try {
    store.setItem(stateKey(s.kode), JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}

// A missing, unreadable or foreign record starts the test over.
export function loadTestState(store: KeyValueStore, kode: string): TestState {
  try {
    const raw = store.getItem(stateKey(kode));
    const v = raw ? (JSON.parse(raw) as Partial<TestState>) : null;
    const time = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
    if (!v || v.kode !== kode) return freshState(kode);
    const sent = v.terkirim;
    return {
      kode,
      setuju: time(v.setuju),
      isian: v.isian && typeof v.isian === "object" ? v.isian : null,
      mulai: time(v.mulai),
      selesai: time(v.selesai),
      selesai_awal: v.selesai_awal === true,
      id_kiriman: typeof v.id_kiriman === "string" && ID_PATTERN.test(v.id_kiriman) ? v.id_kiriman : null,
      terkirim:
        sent && typeof sent.id === "string" && time(sent.t) !== null
          ? { id: sent.id, t: sent.t as number, duplikat: sent.duplikat === true }
          : null,
    };
  } catch {
    return freshState(kode);
  }
}

// ── Submission ──────────────────────────────────────────────────────────────────

// The record fields that are sent; anything else in a stored record (id, hari, future fields) stays.
export const EVALUATION_KEYS = [
  "sesi",
  "t",
  "label",
  "label_mentah",
  "dinilai",
  "sebab_ditahan",
  "skor",
  "poin",
  "tanda",
  "perclos",
  "kedip_per_menit",
  "durasi_kedip_ms",
  "mata_tertutup_lama",
  "menguap",
  "pct_kepala_menunduk",
  "pct_wajah_hilang",
  "menit_sejak_jeda",
  "menit_lelah_60",
  "hemat_daya",
] as const satisfies readonly (keyof EvaluationRecord)[];
export const KSS_KEYS = ["sesi", "t", "kss", "label_tampil", "pengingat"] as const satisfies readonly (keyof KssRecord)[];
export const CORRECTION_KEYS = [
  "sesi",
  "t",
  "label_tampil",
  "label_koreksi",
  "skor",
  "alasan",
] as const satisfies readonly (keyof LabelCorrectionRecord)[];
export const BREAK_KEYS = ["sesi", "mulai", "selesai", "menit", "pemicu"] as const satisfies readonly (keyof BreakRecord)[];

export const SUBMISSION_KEYS = [
  "format",
  "versi",
  "id_kiriman",
  "kode",
  "app",
  "dikirim",
  "mulai",
  "selesai",
  "durasi_menit",
  "selesai_awal",
  "isian",
  "feedback",
  "perangkat",
  "baseline",
  "evaluasi",
  "kss",
  "koreksi_label",
  "jeda",
] as const;

function pick<T extends object, K extends keyof T>(record: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) if (record[key] !== undefined) out[key] = record[key];
  return out;
}

export type Device = {
  browser: string;
  os: string;
  kamera: string | null; // "640x480"
  fps_rata: number | null; // frames per second over the test, hidden-tab gaps included
};

export function browserOf(ua: string): string {
  const match = (re: RegExp) => re.exec(ua)?.[1];
  const edge = match(/Edg\/(\d+)/);
  if (edge) return `Edge ${edge}`;
  const opera = match(/OPR\/(\d+)/);
  if (opera) return `Opera ${opera}`;
  const firefox = match(/Firefox\/(\d+)/);
  if (firefox) return `Firefox ${firefox}`;
  const chrome = match(/Chrome\/(\d+)/);
  if (chrome) return `Chrome ${chrome}`;
  const safari = match(/Version\/(\d+)[\d.]* Safari/);
  return safari ? `Safari ${safari}` : "lainnya";
}

export function osOf(ua: string): string {
  if (/Windows/.test(ua)) return "Windows";
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Android/.test(ua)) return "Android";
  if (/iPhone|iPad/.test(ua)) return "iOS";
  if (/Mac OS X/.test(ua)) return "macOS";
  if (/Linux/.test(ua)) return "Linux";
  return "lainnya";
}

export type BaselineSummary = {
  dibuat: number;
  kedip_per_menit: number;
  durasi_kedip_ms: number | null;
  ear_terbuka: number;
  ear_terpejam: number;
};

const round = (x: number, digits: number) => Number(x.toFixed(digits));

export const summarizeBaseline = (b: Baseline): BaselineSummary => ({
  dibuat: b.createdAt,
  kedip_per_menit: round(b.blinkPerMin, 1),
  durasi_kedip_ms: b.blinkDurationMs === null ? null : Math.round(b.blinkDurationMs),
  ear_terbuka: round(b.earOpen, 3),
  ear_terpejam: round(b.earClosed, 3),
});

export type TestRecords = {
  evaluasi: readonly EvaluationRecord[];
  kss: readonly KssRecord[];
  koreksi_label: readonly LabelCorrectionRecord[];
  jeda: readonly BreakRecord[];
};

export const APP_VERSION = "uji-1";

// One submission per tester: the records inside the test window only, each cut down to its *_KEYS.
export function toSubmission(
  s: TestState,
  feedback: TestFeedback,
  records: TestRecords,
  context: { perangkat: Device; baseline: Baseline | null; now: number },
) {
  if (s.mulai === null || s.selesai === null) throw new Error("Uji belum selesai.");
  if (s.id_kiriman === null) throw new Error("Kiriman belum punya id.");
  const from = s.mulai;
  const to = s.selesai;
  const inside = (t: number) => t >= from && t <= to;
  return {
    format: "equilibre-uji",
    versi: 1,
    id_kiriman: s.id_kiriman,
    kode: s.kode,
    app: APP_VERSION,
    dikirim: new Date(context.now).toISOString(),
    mulai: from,
    selesai: to,
    durasi_menit: round((to - from) / MINUTE, 1),
    selesai_awal: s.selesai_awal,
    isian: s.isian,
    feedback,
    perangkat: context.perangkat,
    baseline: context.baseline ? summarizeBaseline(context.baseline) : null,
    evaluasi: records.evaluasi.filter((r) => inside(r.t)).map((r) => pick(r, EVALUATION_KEYS)),
    kss: records.kss.filter((r) => inside(r.t)).map((r) => pick(r, KSS_KEYS)),
    koreksi_label: records.koreksi_label.filter((r) => inside(r.t)).map((r) => pick(r, CORRECTION_KEYS)),
    jeda: records.jeda.filter((r) => r.selesai >= from && r.mulai <= to).map((r) => pick(r, BREAK_KEYS)),
  } satisfies Record<(typeof SUBMISSION_KEYS)[number], unknown>;
}

export type Submission = ReturnType<typeof toSubmission>;

export type SendResult = { ok: true; id: string; duplikat: boolean } | { ok: false; error: string };

// Apps Script answers 200 with {ok, id, duplikat} or {ok: false, error}. text/plain keeps the request
// "simple", so the browser sends no CORS preflight that Apps Script could not answer.
export async function postSubmission(url: string, sub: Submission, fetchFn: typeof fetch = fetch): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(sub),
    });
  } catch {
    return { ok: false, error: "Tidak bisa terhubung. Cek internet, lalu coba lagi." };
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok || body === null || typeof body !== "object") return { ok: false, error: `Penerima menjawab HTTP ${res.status}.` };
  const b = body as Record<string, unknown>;
  if (b.ok === true && typeof b.id === "string") return { ok: true, id: b.id, duplikat: b.duplikat === true };
  return { ok: false, error: typeof b.error === "string" ? b.error : "Jawaban penerima tidak dikenal." };
}

// Apps Script answers through a redirect to googleusercontent.com, and that hop is flaky: in 9 browser
// trials on 5 Oct the answer was right 5 times, the doGet answer twice and a 404 twice (plans/P08). The
// submission itself is stored by doPost before the redirect, and its id makes a resend harmless, so an
// unconfirmed send is simply tried again. A refusal the receiver did give (unknown code) is not retried.
export const SEND_ATTEMPTS = 3;
export const RETRY_WAIT_MS = 2_000;

export async function sendWithRetry(
  url: string,
  sub: Submission,
  options: {
    fetchFn?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    onAttempt?: (attempt: number) => void;
  } = {},
): Promise<SendResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let result: SendResult = { ok: false, error: "Belum dikirim." };
  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
    options.onAttempt?.(attempt);
    result = await postSubmission(url, sub, options.fetchFn);
    if (result.ok || isRefusal(result.error)) return result;
    if (attempt < SEND_ATTEMPTS) await sleep(RETRY_WAIT_MS * attempt);
  }
  return result;
}

// Errors written by Code.gs itself: the receiver read the submission and said no, so resending changes nothing.
const REFUSALS = ["Kode uji tidak terdaftar", "Format kiriman tidak dikenal", "Kiriman bukan JSON", "Kiriman kosong atau terlalu besar", "Bagian "];
const isRefusal = (error: string) => REFUSALS.some((r) => error.startsWith(r));
