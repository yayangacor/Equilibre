// "Plan my next hour" (plan P20 W2.4, NOTES D-83, D-84, D-90): what /api/rencana accepts, the run of the Langflow flow
// rencana_kerja (Task Matcher component → knowledge base → LLM), and the check of the LLM's JSON. Pure: no config or
// node:* imports, so web's tests load this file too (as analyze.ts and forward.ts). Field names and limits are
// identical in web/src/rencana.ts (web/src/server-rencana.test.ts checks).
import { FALLBACK_MAX_TOKENS, FALLBACK_MODEL, LLM_NODE_ID, type RunFlow } from "./analyze.ts";
import { LangflowError, parseJsonReply } from "./reply.ts";

// ── What the app may send (NOTES D-01 as extended by D-90) ──────────────────────
// The energy phase, the slump-hour flag, minutes since the last break, and the abstract tasks t1..tn: kind, load, days
// to the due date, place in the user's list. No title, note, list name or Google task id can be carried: every string
// is an enum value or an id that must equal "t" + (posisi + 1), and unknown keys are refused at both levels.

export const FASE = ["siap fokus", "biasa", "rendah ringan", "rendah berat", "tidak tahu"] as const;
export const SIFAT = ["aktif", "monoton", "belum dinilai"] as const;
export const BEBAN = ["berat", "ringan", "belum dinilai"] as const;
export type Fase = (typeof FASE)[number];

export const RENCANA_FIELDS = ["fase", "jam_rawan", "menit_sejak_jeda", "tugas"] as const;
export const TUGAS_FIELDS = ["id", "sifat", "beban", "hari_ke_tenggat", "posisi"] as const;

// ⚠️ tugasMax: the first tasks of the user's order; 50 abstract tasks are about 4 kB, well under express.json()'s 16 kB.
// hariMax: a due date further than a year either way is sent as ±365 (web/src/rencana.ts clamps); it scores the same.
export const RENCANA_LIMITS = { tugasMax: 50, hariMax: 365, menitSejakJedaMax: 24 * 60 } as const;

export type RencanaTugas = {
  id: string;
  sifat: (typeof SIFAT)[number];
  beban: (typeof BEBAN)[number];
  hari_ke_tenggat: number | null;
  posisi: number;
};
export type RencanaInput = { fase: Fase; jam_rawan: boolean; menit_sejak_jeda: number | null; tugas: RencanaTugas[] };

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const extraKeys = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).filter((k) => !allowed.includes(k));
const missingKeys = (v: Record<string, unknown>, required: readonly string[]) => required.filter((k) => !Object.hasOwn(v, k));
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);
const wholeIn = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const numberIn = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

function parseTugas(v: unknown, i: number): Result<RencanaTugas> {
  const at = `tugas[${i}]`;
  if (!isObject(v)) return { ok: false, error: `${at} must be an object.` };
  const extra = extraKeys(v, TUGAS_FIELDS);
  if (extra.length > 0) return { ok: false, error: `Unknown fields in ${at}: ${extra.join(", ")}.` };
  const missing = missingKeys(v, TUGAS_FIELDS);
  if (missing.length > 0) return { ok: false, error: `Missing fields in ${at}: ${missing.join(", ")}.` };
  // Ids and positions are exactly toAbstractTasks' numbering, so neither can carry anything else.
  if (v.posisi !== i) return { ok: false, error: `${at}.posisi must be ${i}: tasks are sent in the user's order.` };
  if (v.id !== `t${i + 1}`) return { ok: false, error: `${at}.id must be "t${i + 1}".` };
  if (!oneOf(SIFAT, v.sifat)) return { ok: false, error: `${at}.sifat must be one of: ${SIFAT.join(", ")}.` };
  if (!oneOf(BEBAN, v.beban)) return { ok: false, error: `${at}.beban must be one of: ${BEBAN.join(", ")}.` };
  const hari = v.hari_ke_tenggat;
  const max = RENCANA_LIMITS.hariMax;
  if (hari !== null && !wholeIn(hari, -max, max)) {
    return { ok: false, error: `${at}.hari_ke_tenggat must be null or a whole number from ${-max} to ${max}.` };
  }
  return { ok: true, value: { id: `t${i + 1}`, sifat: v.sifat, beban: v.beban, hari_ke_tenggat: hari, posisi: i } };
}

export function parseRencana(body: unknown): Result<RencanaInput> {
  if (!isObject(body)) return { ok: false, error: "The body must be a JSON object." };
  const extra = extraKeys(body, RENCANA_FIELDS);
  if (extra.length > 0) return { ok: false, error: `Unknown fields: ${extra.join(", ")}.` };
  const missing = missingKeys(body, RENCANA_FIELDS);
  if (missing.length > 0) return { ok: false, error: `Missing fields: ${missing.join(", ")}.` };
  if (!oneOf(FASE, body.fase)) return { ok: false, error: `fase must be one of: ${FASE.join(", ")}.` };
  if (typeof body.jam_rawan !== "boolean") return { ok: false, error: "jam_rawan must be true or false." };
  const menit = body.menit_sejak_jeda;
  const menitMax = RENCANA_LIMITS.menitSejakJedaMax;
  if (menit !== null && !numberIn(menit, 0, menitMax)) {
    return { ok: false, error: `menit_sejak_jeda must be null or a number from 0 to ${menitMax}.` };
  }
  if (!Array.isArray(body.tugas)) return { ok: false, error: "tugas must be a list." };
  if (body.tugas.length > RENCANA_LIMITS.tugasMax) {
    return { ok: false, error: `tugas may hold at most ${RENCANA_LIMITS.tugasMax} tasks.` };
  }
  const tugas: RencanaTugas[] = [];
  for (const [i, t] of body.tugas.entries()) {
    const parsed = parseTugas(t, i);
    if (!parsed.ok) return parsed;
    tugas.push(parsed.value);
  }
  return { ok: true, value: { fase: body.fase, jam_rawan: body.jam_rawan, menit_sejak_jeda: menit, tugas } };
}

// ── What the LLM must answer ────────────────────────────────────────────────────
// {langkah[], tugas_id, alasan, sumber}: the Task Matcher's steps in words, the task it chose, why, and the knowledge
// base notes cited. Sentences name a task only by its marker ("t3"); the laptop puts the title in (D-90). The model
// line is the server's (read from the flow, as for /api/analyze): whatever the LLM writes there is dropped.

export const LANGKAH_JENIS = ["jalan", "jeda", "tugas"] as const;
// ⚠️ Text caps: a step is one short line, the reason two or three sentences.
export const JAWABAN_LIMITS = { langkahMax: 4, menitMax: 60, teksMax: 200, alasanMax: 600, sumberMax: 5, sumberTeksMax: 120 } as const;

// "t3" in a sentence, also "t3nya" or "(t3)"; not inside a word ("at3") and not a longer number ("t1234").
// web/src/rencana.ts uses the same pattern to put the titles in.
export const MARKER = /\bt(\d{1,3})(?!\d)/gi;
// Sleep in any sentence: the plan never suggests a nap, not even a short one (NOTES D-27, user 22 Sep), whatever the
// model writes. "tertidur" (the label) is one word and does not match. web/src/rencana.ts refuses the same.
export const SLEEP_WORDS = /\b(?:tidur|terlelap|nap|naps|napping|sleep|sleeping)\b/i;
// "25 menit", "25-minute", "25 min": minutes named in a step must be that step's own (the rules' minutes).
export const MINUTES = /(\d+)\s*-?\s*(?:menit|minutes?|mins?)\b/gi;

export type RencanaLangkah = { jenis: (typeof LANGKAH_JENIS)[number]; menit: number | null; tugas_id: string | null; teks: string };
export type RencanaJawaban = { langkah: RencanaLangkah[]; tugas_id: string | null; alasan: string; sumber: string[] };

// C0/C1 control characters except tab and newline (as in tanya.ts).
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

function text(v: unknown, what: string, max: number, ids: ReadonlySet<string>): Result<string> {
  const s = typeof v === "string" ? v.trim() : null;
  if (s === null || s === "" || s.length > max) return { ok: false, error: `${what} must be text of 1–${max} characters.` };
  if (CONTROL.test(s)) return { ok: false, error: `${what} contains unsupported characters.` };
  for (const m of s.matchAll(MARKER)) {
    if (!ids.has(`t${m[1]}`)) return { ok: false, error: `${what} names ${m[0]}, which is not one of the tasks sent.` };
  }
  return { ok: true, value: s };
}

function taskId(v: unknown, what: string, ids: ReadonlySet<string>): Result<string | null> {
  if (v === null || v === undefined) return { ok: true, value: null };
  if (typeof v === "string" && ids.has(v)) return { ok: true, value: v };
  return { ok: false, error: `${what} must be null or one of the tasks sent.` };
}

export function parseRencanaReply(reply: string, input: RencanaInput): Result<RencanaJawaban> {
  const r = parseJsonReply(reply);
  if (!isObject(r)) return { ok: false, error: "the reply is not a JSON object" };
  const ids = new Set(input.tugas.map((t) => t.id));
  const L = JAWABAN_LIMITS;

  const chosen = taskId(r.tugas_id, "tugas_id", ids);
  if (!chosen.ok) return chosen;
  // A task is named exactly when the rules give one: never in "rendah berat" (D-84), always when there are tasks.
  const expectsTask = input.fase !== "rendah berat" && input.tugas.length > 0;
  if (expectsTask !== (chosen.value !== null)) {
    return { ok: false, error: expectsTask ? "the plan names no task" : "the plan names a task where it must not" };
  }

  if (!Array.isArray(r.langkah) || r.langkah.length > L.langkahMax) {
    return { ok: false, error: `langkah must be a list of at most ${L.langkahMax} steps` };
  }
  const langkah: RencanaLangkah[] = [];
  for (const [i, s] of r.langkah.entries()) {
    const at = `langkah[${i}]`;
    if (!isObject(s) || !oneOf(LANGKAH_JENIS, s.jenis)) return { ok: false, error: `${at}.jenis must be one of: ${LANGKAH_JENIS.join(", ")}` };
    const menit = s.menit ?? null;
    if (menit !== null && !wholeIn(menit, 1, L.menitMax)) {
      return { ok: false, error: `${at}.menit must be null or a whole number from 1 to ${L.menitMax}` };
    }
    const id = taskId(s.tugas_id, `${at}.tugas_id`, ids);
    if (!id.ok) return id;
    if ((s.jenis === "tugas") !== (id.value !== null) || (id.value !== null && id.value !== chosen.value)) {
      return { ok: false, error: `${at}: only a "tugas" step names a task, and it is tugas_id` };
    }
    const teks = text(s.teks, `${at}.teks`, L.teksMax, ids);
    if (!teks.ok) return teks;
    // A step may name only the chosen task: "Work on t2" under a plan for t1 would show another task's title in the
    // step than in the card's heading. The reason (alasan) may still compare it with the others.
    for (const m of teks.value.matchAll(MARKER)) {
      if (`t${m[1]}` !== chosen.value) return { ok: false, error: `${at}.teks names ${m[0]}; a step may name only the chosen task.` };
    }
    for (const m of teks.value.matchAll(MINUTES)) {
      if (Number(m[1]) !== menit) return { ok: false, error: `${at}.teks says "${m[0]}", but the step has ${menit ?? "no"} minutes.` };
    }
    if (SLEEP_WORDS.test(teks.value)) return { ok: false, error: `${at}.teks mentions sleep; the plan never suggests a nap.` };
    langkah.push({ jenis: s.jenis, menit, tugas_id: id.value, teks: teks.value });
  }

  const alasan = text(r.alasan, "alasan", L.alasanMax, ids);
  if (!alasan.ok) return alasan;
  if (SLEEP_WORDS.test(alasan.value)) return { ok: false, error: "alasan mentions sleep; the plan never suggests a nap." };

  const sumberRaw = r.sumber ?? [];
  if (!Array.isArray(sumberRaw) || sumberRaw.length > L.sumberMax) return { ok: false, error: `sumber must be a list of at most ${L.sumberMax}` };
  const sumber: string[] = [];
  for (const [i, s] of sumberRaw.entries()) {
    const one = text(s, `sumber[${i}]`, L.sumberTeksMax, new Set());
    if (!one.ok) return one;
    sumber.push(one.value);
  }
  return { ok: true, value: { langkah, tugas_id: chosen.value, alasan: alasan.value, sumber } };
}

// ── The run ─────────────────────────────────────────────────────────────────────

export type Rencana = { jawaban: RencanaJawaban; cadangan: boolean };

// As analyze.ts: one LLM call normally; after a retryable failure or an answer that fails the check above, the same flow
// once more with its LLM node switched to the fallback model. The flow rencana_kerja keeps the LLM node id of the other
// flows (LLM_NODE_ID), so the same tweak reaches it.
export async function rencana(input: RencanaInput, run: RunFlow): Promise<Rencana> {
  const inputValue = JSON.stringify(input);
  try {
    const parsed = parseRencanaReply(await run(inputValue, {}), input);
    if (parsed.ok) return { jawaban: parsed.value, cadangan: false };
    console.warn(`[rencana] primary reply rejected (${parsed.error}), trying the fallback model`);
  } catch (err) {
    if (!(err instanceof LangflowError) || !err.retryable) throw err;
    console.warn(`[rencana] primary model failed (${err.message}), trying the fallback model`);
  }
  // The Gemini fallback is allowed here only because this request carries no task title (NOTES D-90 (a)). A titled
  // request (the opt-in switch of D-90 (b)) must never take this path: Gemini's free tier may be read by human
  // reviewers. Such a request gets its own route that fails instead of falling back.
  const tweaks = { [LLM_NODE_ID]: { model: [FALLBACK_MODEL], max_tokens: FALLBACK_MAX_TOKENS } };
  const parsed = parseRencanaReply(await run(inputValue, tweaks), input);
  if (!parsed.ok) throw new LangflowError(`The plan from the model could not be used: ${parsed.error}.`, 502);
  return { jawaban: parsed.value, cadangan: true };
}
