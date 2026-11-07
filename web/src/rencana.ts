import type { ImportedTask } from "./googleTasks.ts";
import type { PhaseResult } from "./phase.ts";
import { matchTasks, type MatchResult, type MatchStep, type ReasonCode, type StepKind, type TaskScore } from "./taskMatcher.ts";
import { toAbstractTasks, type AbstractTask, type TagMemory } from "./taskTagger.ts";

// "Plan my next hour" in the browser (plan P20 W2.4): builds what /api/rencana receives, asks the server, and puts the
// task titles into the answer on this laptop. No DOM (the card is W2.6). What leaves the device is the energy phase,
// the slump-hour flag, minutes since the last break and the abstract tasks t1..tn (NOTES D-01 as extended by D-90).
// Titles, list names and Google's task ids stay here: the server's sentences name "t3", and withTitles() swaps in
// the title. Field names and limits are identical to server/src/rencana.ts (rencana.test.ts checks).
// Whenever the server cannot give a plan (offline, not configured, daily limit, an answer that does not follow the
// rules), the plan of this laptop's own Task Matcher is returned instead, labelled as the offline plan.

export const RENCANA_FIELDS = ["fase", "jam_rawan", "menit_sejak_jeda", "tugas"] as const;
export const TUGAS_FIELDS = ["id", "sifat", "beban", "hari_ke_tenggat", "posisi"] as const;
export const RENCANA_LIMITS = { tugasMax: 50, hariMax: 365, menitSejakJedaMax: 24 * 60 } as const;
// "t3" in the server's sentences; same pattern as server/src/rencana.ts, which checks every marker against the ids sent.
export const MARKER = /\bt(\d{1,3})(?!\d)/gi;
// Two Langflow runs at most on the server (primary, then fallback), as the Vercel proxy allows 75 s.
export const RENCANA_TIMEOUT_MS = 90_000;

// The request body: the Task Matcher's own input (taskMatcher.ts MatchInput).
export type RencanaBody = {
  fase: PhaseResult["fase"];
  jam_rawan: boolean;
  menit_sejak_jeda: number | null;
  tugas: AbstractTask[];
};
// judul: "t3" → the task's title. Kept in the browser, never sent.
export type RencanaRequest = { body: RencanaBody; judul: ReadonlyMap<string, string> };

const clamp = (x: number, min: number, max: number) => Math.min(max, Math.max(min, x));

// The first RENCANA_LIMITS.tugasMax tasks in Google Tasks order, numbered t1..tn by toAbstractTasks. Every field of the
// body is picked by name, so nothing else of a task can ride along. A due date more than a year away either way is
// sent as ±365 days: it scores the same (taskMatcher.ts urgencyTenths).
export function toRencanaRequest(
  phase: Pick<PhaseResult, "fase" | "jam_rawan">,
  menitSejakJeda: number | null,
  tasks: readonly ImportedTask[],
  today: string,
  memory: TagMemory,
): RencanaRequest {
  const first = [...tasks].sort((a, b) => a.order - b.order).slice(0, RENCANA_LIMITS.tugasMax);
  const { tugas, peta } = toAbstractTasks(first, today, memory);
  const titleOf = new Map(first.map((t) => [t.id, t.title]));
  const judul = new Map([...peta].map(([tId, googleId]) => [tId, titleOf.get(googleId) ?? ""]));
  const days = RENCANA_LIMITS.hariMax;
  return {
    body: {
      fase: phase.fase,
      jam_rawan: phase.jam_rawan,
      menit_sejak_jeda: menitSejakJeda === null ? null : Math.round(clamp(menitSejakJeda, 0, RENCANA_LIMITS.menitSejakJedaMax)),
      tugas: tugas.map((t) => ({
        id: t.id,
        sifat: t.sifat,
        beban: t.beban,
        hari_ke_tenggat: t.hari_ke_tenggat === null ? null : clamp(t.hari_ke_tenggat, -days, days),
        posisi: t.posisi,
      })),
    },
    judul,
  };
}

// "t3" → “Write the Q3 report”. A marker of no task sent stays as written (the server refuses those anyway).
export function withTitles(text: string, judul: ReadonlyMap<string, string>): string {
  return text.replace(MARKER, (marker: string, n: string) => {
    const title = judul.get(`t${n}`);
    return title ? `“${title}”` : marker;
  });
}

// ── The plan ────────────────────────────────────────────────────────────────────

export type PlanStep = { jenis: StepKind; menit: number | null; tugas_id: string | null; judul: string | null; teks: string };
export type Plan = {
  asal: "server" | "offline"; // offline: this laptop's Task Matcher, no LLM
  sebab: string | null; // offline: why the server's plan is not shown
  langkah: PlanStep[];
  tugas_id: string | null;
  judul: string | null; // the chosen task's title, local only
  alasan: string;
  sumber: string[]; // knowledge base notes the LLM cited (answer.ts toSource); none offline
  model: string | null;
  cadangan: boolean; // the server's fallback model answered
  kode: ReasonCode[]; // always from this laptop's Task Matcher
  skor: TaskScore[];
};

// Offline wording. ⚠️ First copy; the card itself is W2.6. D-84: the energy rules are called a hypothesis.
export const REASON_TEXT: Readonly<Record<ReasonCode, string>> = {
  JEDA_DULU: "Your energy looks very low, so a break comes first and no task is suggested.",
  JALAN_DULU: "A short walk first: regular movement breaks help people feel less tired.",
  KAMERA_TIDAK_MENILAI: "The camera could not judge your energy, so the plan follows your due dates and your list.",
  AKTIF_SAAT_RAWAN: "Active work suits a low-energy time better than routine work (a hypothesis we are testing).",
  HINDARI_MONOTON: "A routine task would have come first, but routine work is harder to keep up when energy is low.",
  SIAP_FOKUS: "You look ready to focus, so a demanding task comes first.",
  TENGGAT_HARI_INI: "It is due today or overdue.",
  TENGGAT_DEKAT: "It is due in the next few days.",
  URUTAN_PENGGUNA: "It is first in your list.",
  BELUM_DINILAI: "Its kind of work is not assessed yet: tell Equilibre once and it will remember.",
  TIDAK_ADA_TUGAS: "There are no open tasks to choose from.",
};

const titleOrNull = (judul: ReadonlyMap<string, string>, id: string | null) => (id === null ? null : judul.get(id) || null);

function stepText(step: MatchStep, title: string | null): string {
  if (step.jenis === "jalan") return `Walk for ${step.menit} minutes.`;
  if (step.jenis === "jeda") return `Take an active break: walk for ${step.menit} minutes, or nap for 10–20 minutes if you can.`;
  const what = title ? `“${title}”` : "the next task";
  return step.menit === null ? `Work on ${what}.` : `Work on ${what} for ${step.menit} minutes.`;
}

export function offlinePlan(req: RencanaRequest, sebab: string | null, local: MatchResult = matchTasks(req.body)): Plan {
  return {
    asal: "offline",
    sebab,
    langkah: local.langkah.map((s) => {
      const judul = titleOrNull(req.judul, s.tugas_id);
      return { jenis: s.jenis, menit: s.menit, tugas_id: s.tugas_id, judul, teks: stepText(s, judul) };
    }),
    tugas_id: local.tugas_id,
    judul: titleOrNull(req.judul, local.tugas_id),
    alasan: local.kode.map((k) => REASON_TEXT[k]).join(" "),
    sumber: [],
    model: null,
    cadangan: false,
    kode: local.kode,
    skor: local.skor,
  };
}

export const NOT_FOLLOWED =
  "The server's plan did not follow the Task Matcher's rules, so the plan made on this laptop is shown.";
const UNREADABLE = "The server's plan could not be read, so the plan made on this laptop is shown.";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string";

// The server checked the reply (server/src/rencana.ts); checked again here for shape, and against this laptop's Task
// Matcher: the LLM explains the rules' choice and never makes its own (research §3.4), so another task or other steps
// mean the server's plan is not used. The minutes are the rules' too; the model only writes the sentences.
function fromServer(body: unknown, req: RencanaRequest, local: MatchResult): Plan {
  if (!isObject(body) || !Array.isArray(body.langkah) || !isText(body.alasan)) return offlinePlan(req, UNREADABLE, local);
  const steps = body.langkah;
  if (!steps.every((s) => isObject(s) && isText(s.jenis) && isText(s.teks) && (s.tugas_id === null || isText(s.tugas_id)))) {
    return offlinePlan(req, UNREADABLE, local);
  }
  const same =
    (body.tugas_id ?? null) === local.tugas_id &&
    steps.length === local.langkah.length &&
    steps.every((s, i) => s.jenis === local.langkah[i].jenis && s.tugas_id === local.langkah[i].tugas_id);
  if (!same) return offlinePlan(req, NOT_FOLLOWED, local);
  return {
    asal: "server",
    sebab: null,
    langkah: local.langkah.map((s, i) => ({
      jenis: s.jenis,
      menit: s.menit,
      tugas_id: s.tugas_id,
      judul: titleOrNull(req.judul, s.tugas_id),
      teks: withTitles(steps[i].teks as string, req.judul),
    })),
    tugas_id: local.tugas_id,
    judul: titleOrNull(req.judul, local.tugas_id),
    alasan: withTitles(body.alasan, req.judul),
    sumber: Array.isArray(body.sumber) ? body.sumber.filter(isText) : [],
    model: isText(body.model) && body.model.trim() !== "" ? body.model.trim() : null,
    cadangan: body.cadangan === true,
    kode: local.kode,
    skor: local.skor,
  };
}

// One POST /api/rencana (an LLM call on the server, so only when the user asks for a plan). Never throws: every
// failure gives the offline plan with the reason.
export async function requestPlan(req: RencanaRequest, fetcher: typeof fetch = fetch): Promise<Plan> {
  const local = matchTasks(req.body);
  let res: Response;
  try {
    res = await fetcher("/api/rencana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(RENCANA_TIMEOUT_MS),
    });
  } catch {
    return offlinePlan(req, "Can't reach the backend.", local);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error = isObject(body) && isText(body.error) ? body.error : `The backend answered HTTP ${res.status}.`;
    return offlinePlan(req, error, local);
  }
  return fromServer(body, req, local);
}
