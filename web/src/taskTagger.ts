import type { KeyValueStore } from "./calibration.ts";
import type { ImportedTask } from "./googleTasks.ts";

// The task rubric on the device (plan P20 W2.2, NOTES D-89). Four attributes per task:
//   sifat   aktif / monoton   proposed from the verb in the title (English or Indonesian), confirmed with one tap
//   beban   berat / ringan    likewise
//   tenggat lewat / hari ini / besok / ≤ 3 hari / lainnya, from the task's due date (the API keeps only the date)
//   urutan  the task's place in Google Tasks (ImportedTask.order)
// An unknown verb is "belum dinilai" (not assessed): the UI asks once and the answer is remembered as a personal
// dictionary entry, so the same verb is tagged the same next time. Server and HR take no part in it.
// Pure, like the pipeline modules: persistence sits behind TagMemoryStore at the bottom of this file.
//
// What may leave the laptop is only the abstract task of toAbstractTasks() (NOTES D-90): t1..tn plus the rubric,
// days to the due date and position. Titles, list names and Google's task ids stay here.

export const SIFAT = ["aktif", "monoton"] as const;
export type Sifat = (typeof SIFAT)[number];
export const BEBAN = ["berat", "ringan"] as const;
export type Beban = (typeof BEBAN)[number];
export const NOT_ASSESSED = "belum dinilai";
export type NotAssessed = typeof NOT_ASSESSED;
export type Rubric = { sifat: Sifat; beban: Beban };

export const TENGGAT = ["lewat", "hari ini", "besok", "≤ 3 hari", "lainnya"] as const;
export type Tenggat = (typeof TENGGAT)[number];
export const DUE_SOON_DAYS = 3; // "≤ 3 hari" in the rubric (D-89) and in urgensi() of the Task Matcher (research §3.4)

// ── Lexicon ─────────────────────────────────────────────────────────────────────
// ⚠️ A first proposal from the research report (§1.3, §3.1): the axis that matters when sleepy is engagement,
// active (problem solving, making, talking with people) vs monotone (routine, repetitive, passive); beban is how
// much sustained thinking the task takes. Not checked against real task lists yet: every value is only proposed,
// the employee confirms or corrects it with one tap (D-89).
// Base words only: Indonesian affixes (me-/mem-/men-/meng-/meny-/di-/ber-, -kan/-i) and English inflections
// (-s, -ed, -ing) are handled by stems(). Multi-word entries match word by word. Each word belongs to one group.
// Left out on purpose, because the verb alone does not tell (they stay "belum dinilai" until the user answers):
// read/baca, test/uji, calculate/hitung, do/kerjakan, finish/selesaikan, report/lapor, make.
export const TASK_LEXICON: Readonly<Record<"aktif berat" | "aktif ringan" | "monoton berat" | "monoton ringan", readonly string[]>> = {
  // Thinking, making, deciding.
  "aktif berat": [
    // English
    "write", "rewrite", "draft", "compose", "outline", "analyse", "analyze", "analysis", "design", "plan", "research",
    "investigate", "study", "learn", "develop", "code", "build", "implement", "refactor", "prototype", "debug", "fix",
    "solve", "troubleshoot", "optimise", "optimize", "prepare", "revise", "review", "evaluate", "assess", "forecast",
    "strategize", "brainstorm", "negotiate", "present", "presentation", "pitch", "interview", "create", "summarise",
    "summarize", "translate",
    // Indonesian
    "tulis", "draf", "susun", "rancang", "rencana", "analisis", "analisa", "desain", "riset", "teliti", "kaji",
    "pelajari", "belajar", "kembangkan", "bangun", "koding", "implementasi", "perbaiki", "pecahkan", "siapkan",
    "revisi", "tinjau", "evaluasi", "rumuskan", "buat", "bikin", "ringkas", "rangkum", "terjemahkan", "negosiasi",
    "presentasi", "wawancara", "optimasi", "optimalkan",
  ],
  // Talking and coordinating with people.
  "aktif ringan": [
    // English
    "call", "phone", "meet", "meeting", "discuss", "sync", "standup", "stand up", "follow up", "check in", "catch up",
    "coordinate", "ask", "visit", "brief", "briefing", "consult", "edit", "demo", "talk",
    // Indonesian
    "telepon", "telpon", "telp", "hubungi", "rapat", "diskusi", "bahas", "koordinasi", "temui", "ketemu", "tanya",
    "tanyakan", "kunjungi", "sunting", "konsultasi", "sosialisasi",
  ],
  // Long and repetitive, needs steady attention.
  "monoton berat": [
    // English
    "reconcile", "proofread", "proof read", "transcribe", "audit", "tabulate", "grade", "stocktake", "stock take",
    // Indonesian
    "rekonsiliasi", "transkrip", "transkripsi", "koreksi", "tabulasi", "stok opname", "stock opname", "inventarisasi",
  ],
  // Routine admin steps.
  "monoton ringan": [
    // English
    "reply", "respond", "answer", "email", "mail", "fwd", "forward", "send", "file", "archive", "enter", "input",
    "data entry", "type", "check", "verify", "fill", "update", "upload", "download", "print", "scan", "copy", "sort",
    "organise", "organize", "tidy", "clean", "schedule", "book", "pay", "sign", "approve", "submit", "confirm",
    "remind", "order", "log", "track", "rename", "backup", "invoice", "register", "transfer",
    // Indonesian
    "balas", "jawab", "kirim", "teruskan", "arsip", "arsipkan", "isi", "entri", "ketik", "cek", "periksa",
    "verifikasi", "perbarui", "unggah", "unduh", "cetak", "pindai", "salin", "fotokopi", "urutkan", "sortir",
    "rapikan", "bersihkan", "atur", "jadwal", "jadwalkan", "pesan", "bayar", "tanda tangan", "tandatangan",
    "tandatangani", "ttd", "setujui", "ajukan", "kumpulkan", "konfirmasi", "ingatkan", "catat", "rekap",
    "rekapitulasi", "tagih", "daftarkan", "wa", "whatsapp",
  ],
};

const RUBRIC_OF = {
  "aktif berat": { sifat: "aktif", beban: "berat" },
  "aktif ringan": { sifat: "aktif", beban: "ringan" },
  "monoton berat": { sifat: "monoton", beban: "berat" },
  "monoton ringan": { sifat: "monoton", beban: "ringan" },
} as const satisfies Record<keyof typeof TASK_LEXICON, Rubric>;

// Entry key ("follow up") → rubric. A Map, so a title word like "constructor" never finds Object.prototype.
const BASE_LEXICON: ReadonlyMap<string, Rubric> = new Map(
  (Object.keys(TASK_LEXICON) as (keyof typeof TASK_LEXICON)[]).flatMap((group) =>
    TASK_LEXICON[group].map((key) => [key, RUBRIC_OF[group]] as const),
  ),
);

// ── Words and stems ─────────────────────────────────────────────────────────────

// Lowercase words of a title, without accents, emoji, punctuation, [ProjectX] / {tag} labels, #tags and @mentions.
// "follow-up" becomes two words, matching the entry "follow up".
export function titleWords(title: string): string[] {
  const plain = title
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\[[^\]]*\]|\{[^}]*\}/g, " ")
    .replace(/(^|\s)[#@]\S+/g, " ")
    .replace(/\be-mail/g, "email");
  return plain.match(/[\p{L}\p{N}]+/gu) ?? [];
}

const MIN_STEM = 3; // a stripped form shorter than this is never looked up ("di" + "na" in "Dina" is not a verb)
const startsWithVowel = (s: string) => /^[aiueo]/.test(s);

function englishForms(w: string): string[] {
  const out: string[] = [];
  const undouble = (b: string) => (b.length > 2 && b.at(-1) === b.at(-2) ? b.slice(0, -1) : b);
  if (w.length > 4 && (w.endsWith("ies") || w.endsWith("ied"))) out.push(`${w.slice(0, -3)}y`); // replies, replied
  if (w.length > 5 && w.endsWith("ing")) {
    const b = w.slice(0, -3);
    out.push(b, `${b}e`, undouble(b)); // calling, writing, planning
  }
  if (w.length > 4 && w.endsWith("ed")) {
    const b = w.slice(0, -2);
    out.push(b, `${b}e`, undouble(b)); // emailed, filed, logged
  }
  if (w.length > 4 && w.endsWith("es")) out.push(w.slice(0, -2)); // fixes
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) out.push(w.slice(0, -1)); // calls
  return out;
}

// Suffixes: -kan, -i, and the particle -nya (kirimkan → kirim, perbaiki → perbaik, isinya → isi). A wrong cut
// is harmless: the uncut word is looked up too, and only lexicon entries count.
function indonesianSuffixForms(w: string): string[] {
  const out: string[] = [];
  for (const suffix of ["nya", "kan", "i"]) if (w.endsWith(suffix)) out.push(w.slice(0, -suffix.length));
  return out;
}

// Prefixes with their sound changes: menyusun → susun, mengirim → kirim, menganalisis → analisis, mengecek → cek,
// memeriksa → periksa, membalas → balas, memperbaiki → perbaiki, menulis → tulis, mendesain → desain,
// merevisi → revisi, ditulis → tulis, berdiskusi → diskusi; informal ngecek → cek, ngirim → kirim, nyusun → susun.
function indonesianPrefixForms(w: string): string[] {
  const out: string[] = [];
  const after = (prefix: string) => w.slice(prefix.length);
  if (w.startsWith("memper")) out.push(after("memper"), `per${after("memper")}`);
  if (w.startsWith("meny")) {
    if (startsWithVowel(after("meny"))) out.push(`s${after("meny")}`);
  } else if (w.startsWith("meng")) {
    const r = after("meng");
    out.push(r);
    if (startsWithVowel(r)) out.push(`k${r}`);
    if (r.startsWith("e")) out.push(r.slice(1));
  } else if (w.startsWith("mem")) {
    const r = after("mem");
    out.push(r);
    if (startsWithVowel(r)) out.push(`p${r}`);
  } else if (w.startsWith("men")) {
    const r = after("men");
    out.push(r);
    if (startsWithVowel(r)) out.push(`t${r}`);
  } else if (w.startsWith("me")) {
    out.push(after("me"));
  } else if (w.startsWith("ng")) {
    const r = after("ng");
    if (startsWithVowel(r)) out.push(r, `k${r}`); // ngedit → edit, ngirim → kirim
    if (r.startsWith("e")) out.push(r.slice(1)); // ngecek → cek
  } else if (w.startsWith("ny")) {
    if (startsWithVowel(after("ny"))) out.push(`s${after("ny")}`);
  }
  if (w.startsWith("di")) out.push(after("di"));
  if (w.startsWith("ber")) out.push(after("ber"));
  return out;
}

// The word itself first, so a lexicon word is never read as an affixed form of another ("diskusi" is not di + skusi,
// "meeting" not me + eting), then English forms, then Indonesian ones.
export function stems(word: string): string[] {
  const out = [word];
  const add = (s: string) => {
    if (s.length >= MIN_STEM && !out.includes(s)) out.push(s);
  };
  englishForms(word).forEach(add);
  indonesianSuffixForms(word).forEach(add);
  for (const base of [word, ...indonesianSuffixForms(word)]) {
    for (const p of indonesianPrefixForms(base)) {
      add(p);
      indonesianSuffixForms(p).forEach(add);
    }
  }
  return out;
}

// ── Finding the verb ────────────────────────────────────────────────────────────

export type VerbMatch = { key: string; rubric: Rubric; source: "personal" | "lexicon" };

type Phrase = { key: string; parts: string[]; rubric: Rubric };
type Lexicon = { phrases: Phrase[]; words: ReadonlyMap<string, Rubric> }; // phrases: longest first

function lexiconOf(map: ReadonlyMap<string, Rubric>): Lexicon {
  const phrases: Phrase[] = [];
  const words = new Map<string, Rubric>();
  for (const [key, rubric] of map) {
    const parts = key.split(" ");
    if (parts.length > 1) phrases.push({ key, parts, rubric });
    else words.set(key, rubric);
  }
  return { phrases: phrases.sort((a, b) => b.parts.length - a.parts.length), words };
}
const BASE = lexiconOf(BASE_LEXICON);

// A phrase starting at word i ("check in" before "check"), else the first of the word's stems, in stems() order.
function matchAt(stemsOf: string[][], i: number, lexicon: Lexicon): { key: string; rubric: Rubric } | null {
  for (const phrase of lexicon.phrases) {
    if (i + phrase.parts.length > stemsOf.length) continue;
    if (phrase.parts.every((part, k) => stemsOf[i + k].includes(part))) return phrase;
  }
  for (const stem of stemsOf[i]) {
    const rubric = lexicon.words.get(stem);
    if (rubric) return { key: stem, rubric };
  }
  return null;
}

// The first word of the title, left to right, that is in the personal dictionary or the lexicon: titles usually
// start with the verb ("Write report", "Balas email Dina"), and a later noun ("bahan presentasi") does not decide.
// At one position a personal entry wins over the lexicon.
export function findVerb(title: string, personal: ReadonlyMap<string, Rubric> = new Map()): VerbMatch | null {
  const stemsOf = titleWords(title).map(stems);
  const own = lexiconOf(personal);
  for (let i = 0; i < stemsOf.length; i++) {
    const mine = matchAt(stemsOf, i, own);
    if (mine) return { key: mine.key, rubric: mine.rubric, source: "personal" };
    const base = matchAt(stemsOf, i, BASE);
    if (base) return { key: base.key, rubric: base.rubric, source: "lexicon" };
  }
  return null;
}

// Words never learned as a verb: articles, prepositions, conjunctions, pronouns and fillers, English and Indonesian.
// Learned, "the" from "The quarterly numbers" would tag "The budget review" ahead of the lexicon's "review" (review B,
// 8 Nov). Lexicon words stay out of it ("buat" is a verb there).
export const STOP_WORDS: ReadonlySet<string> = new Set([
  // English
  "the", "an", "to", "for", "of", "in", "on", "at", "by", "with", "from", "about", "and", "or", "but", "my", "our",
  "your", "his", "her", "their", "its", "this", "that", "these", "those", "it", "we", "you", "they", "re", "fw",
  "please", "pls", "todo",
  // Indonesian
  "untuk", "utk", "dan", "atau", "tapi", "dengan", "dgn", "di", "ke", "dari", "pada", "yang", "yg", "ini", "itu",
  "saya", "aku", "kami", "kita", "kamu", "anda", "dia", "mereka", "tolong", "mohon", "tentang",
]);

// The word the UI asks about when no verb is known: the first word made of letters only (skips "Q3", "2x") that is
// not a stop word; null when there is none, and then nothing is learned for the dictionary.
// It is remembered as typed ("lunch"), so its own inflections match through stems() later.
export function askedWord(title: string): string | null {
  return titleWords(title).find((w) => /^\p{L}{2,}$/u.test(w) && !STOP_WORDS.has(w)) ?? null;
}

// ── Due date ────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

// Day number of an ISO calendar date, read in UTC so no time zone or summer time can shift it; null when the text
// is not a real date ("2026-02-30", "9/11").
function dayNumber(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const [y, month, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, month - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== d) return null;
  return t / DAY_MS;
}

// Whole days from today to the due date: 0 today, 1 tomorrow, negative when overdue; null without a valid date.
export function daysUntil(today: string, due: string | null): number | null {
  if (due === null) return null;
  const from = dayNumber(today);
  const to = dayNumber(due);
  return from === null || to === null ? null : to - from;
}

export function dueBucket(days: number | null): Tenggat | null {
  if (days === null) return null;
  if (days < 0) return "lewat";
  if (days === 0) return "hari ini";
  if (days === 1) return "besok";
  return days <= DUE_SOON_DAYS ? "≤ 3 hari" : "lainnya";
}

// ── Tagging ─────────────────────────────────────────────────────────────────────

export type TagSource = "correction" | "personal" | "lexicon" | "unknown";

export type TaskTag = {
  id: string; // Google's task id: local only
  sifat: Sifat | NotAssessed;
  beban: Beban | NotAssessed;
  tenggat: Tenggat | null; // null: no due date
  hari_ke_tenggat: number | null;
  urutan: number; // ImportedTask.order
  verb: string | null; // the entry that decided, or for an unknown verb the word the UI asks about
  source: TagSource; // "unknown": belum dinilai, ask once
};

// today: the local calendar day, "YYYY-MM-DD" (history.ts dayKey). corrections: per task id; personal: verb → rubric.
// A correction of this task wins, then the personal dictionary, then the lexicon.
export function tagTask(
  task: ImportedTask,
  today: string,
  corrections: ReadonlyMap<string, Rubric>,
  personal: ReadonlyMap<string, Rubric>,
): TaskTag {
  const found = findVerb(task.title, personal);
  const own = corrections.get(task.id);
  const rubric = own ?? found?.rubric ?? null;
  const hari = daysUntil(today, task.due);
  return {
    id: task.id,
    sifat: rubric?.sifat ?? NOT_ASSESSED,
    beban: rubric?.beban ?? NOT_ASSESSED,
    tenggat: dueBucket(hari),
    hari_ke_tenggat: hari,
    urutan: task.order,
    verb: found?.key ?? askedWord(task.title),
    source: own ? "correction" : (found?.source ?? "unknown"),
  };
}

// ── What the user confirmed or corrected ────────────────────────────────────────

export type TagMemory = {
  corrections: ReadonlyMap<string, Rubric>; // task id → rubric, one tap per task
  personal: ReadonlyMap<string, Rubric>; // verb → rubric, learned from those taps
};

export const emptyTagMemory = (): TagMemory => ({ corrections: new Map(), personal: new Map() });

// Most recent entries kept per map, so ids of tasks long gone do not pile up.
export const TAG_MEMORY_LIMIT = 1000;

function capped(map: Map<string, Rubric>): Map<string, Rubric> {
  const extra = map.size - TAG_MEMORY_LIMIT;
  if (extra <= 0) return map;
  return new Map([...map].slice(extra));
}

// A confirm or a correction (same thing: the user's answer) for one task. Stored for the task, and for its verb
// (the entry that matched, or the asked word of an unknown verb), so the next task with that verb gets it too.
export function rememberTag(memory: TagMemory, task: Pick<ImportedTask, "id" | "title">, choice: Rubric): TagMemory {
  const rubric: Rubric = { sifat: choice.sifat, beban: choice.beban };
  const corrections = new Map(memory.corrections);
  corrections.delete(task.id); // re-inserted last: the newest survives the cap
  corrections.set(task.id, rubric);
  const personal = new Map(memory.personal);
  const verb = findVerb(task.title, memory.personal)?.key ?? askedWord(task.title);
  if (verb !== null) {
    personal.delete(verb);
    personal.set(verb, rubric);
  }
  return { corrections: capped(corrections), personal: capped(personal) };
}

// ── The abstract task: the only task data allowed to leave the laptop (NOTES D-90) ──

export type AbstractTask = {
  id: string; // "t1".."tn"
  sifat: Sifat | NotAssessed;
  beban: Beban | NotAssessed;
  hari_ke_tenggat: number | null;
  posisi: number; // 0..n−1 among these tasks, for urutan = 1 − posisi/(n−1) (research §3.4)
};

// peta: "t3" → Google task id, kept in the browser to put the title back into the plan's sentences.
export type AbstractTasks = { tugas: AbstractTask[]; peta: ReadonlyMap<string, string> };

// Tasks in Google Tasks order, renumbered without gaps. Every field is picked by name: nothing of the title, the
// list or the task id can ride along. "belum dinilai" is sent as it is; the Task Matcher (W2.4) decides its weight.
export function toAbstractTasks(tasks: readonly ImportedTask[], today: string, memory: TagMemory): AbstractTasks {
  const peta = new Map<string, string>();
  const tugas = [...tasks]
    .sort((a, b) => a.order - b.order)
    .map((task, posisi): AbstractTask => {
      const tag = tagTask(task, today, memory.corrections, memory.personal);
      const id = `t${posisi + 1}`;
      peta.set(id, task.id);
      return { id, sifat: tag.sifat, beban: tag.beban, hari_ke_tenggat: tag.hari_ke_tenggat, posisi };
    });
  return { tugas, peta };
}

// ── Persistence ─────────────────────────────────────────────────────────────────

export type TagMemoryStore = { load(): TagMemory; save(memory: TagMemory): boolean };

export const TAG_MEMORY_KEY = "equilibre.rubrik-tugas.v1";
const MAX_KEY_LENGTH = { corrections: 200, personal: 60 } as const;

type StoredEntry = [string, Sifat, Beban];
type Stored = { versi: 1; koreksi: StoredEntry[]; kamus: StoredEntry[] };

const isSifat = (x: unknown): x is Sifat => SIFAT.includes(x as Sifat);
const isBeban = (x: unknown): x is Beban => BEBAN.includes(x as Beban);

function parseEntries(value: unknown, maxKey: number): Map<string, Rubric> {
  const out = new Map<string, Rubric>();
  if (!Array.isArray(value)) return out;
  for (const item of value.slice(-TAG_MEMORY_LIMIT)) {
    if (!Array.isArray(item) || item.length !== 3) continue;
    const [key, sifat, beban] = item as unknown[];
    if (typeof key !== "string" || key === "" || key.length > maxKey || !isSifat(sifat) || !isBeban(beban)) continue;
    out.delete(key);
    out.set(key, { sifat, beban });
  }
  return out;
}

// Rebuilt entry by entry: anything that is not a valid entry is dropped, never trusted.
export function parseTagMemory(raw: string | null): TagMemory {
  if (!raw) return emptyTagMemory();
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return emptyTagMemory();
    const v = value as Record<string, unknown>;
    return {
      corrections: parseEntries(v.koreksi, MAX_KEY_LENGTH.corrections),
      personal: parseEntries(v.kamus, MAX_KEY_LENGTH.personal),
    };
  } catch {
    return emptyTagMemory();
  }
}

export function serializeTagMemory(memory: TagMemory): string {
  const entries = (map: ReadonlyMap<string, Rubric>): StoredEntry[] => [...map].map(([key, r]) => [key, r.sifat, r.beban]);
  const stored: Stored = { versi: 1, koreksi: entries(memory.corrections), kamus: entries(memory.personal) };
  return JSON.stringify(stored);
}

// localStorage (or anything shaped like it). null, or a store that throws (private mode, quota, blocked site data):
// load gives an empty memory and save answers false, and tagging goes on from the lexicon.
export function localTagStore(storage: KeyValueStore | null): TagMemoryStore {
  return {
    load() {
      try {
        return parseTagMemory(storage?.getItem(TAG_MEMORY_KEY) ?? null);
      } catch {
        return emptyTagMemory();
      }
    },
    save(memory) {
      if (!storage) return false;
      try {
        storage.setItem(TAG_MEMORY_KEY, serializeTagMemory(memory));
        return true;
      } catch {
        return false;
      }
    },
  };
}

// For tests and for a session without storage.
export function memoryTagStore(initial: TagMemory = emptyTagMemory()): TagMemoryStore {
  let current = initial;
  return {
    load: () => current,
    save(memory) {
      current = memory;
      return true;
    },
  };
}
