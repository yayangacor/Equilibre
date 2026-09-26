// Checks skenario-uji.json without calling Langflow or an LLM: every payload is what the
// app could send and the server accepts, and each expected status matches what the
// server decides (toFlowInput). Also checks that it catches broken scenarios.
// Usage (from equilibre/): node langflow-flows/cek-skenario.mts
import { readFileSync } from "node:fs";
import { parseFeatures, toFlowInput, type FatigueFeatures } from "../server/src/features.ts";
import { RULES } from "../web/src/rules.ts";

type Scenario = {
  id: string;
  judul: string;
  payload: Record<string, unknown>;
  harapan: { dikirim: boolean; status: string | null; durasi_jeda_menit: number | null; wajib: string[]; dilarang_pola: string[] };
};
type File = { aturan_umum: { dilarang_pola: string[] }; skenario: Scenario[] };

// Fields toAnalyzePayload() always sends (web/src/payload.ts, the non-optional ones).
const ALWAYS_SENT = ["label", "skor", "tanda", "mata_tertutup_lama", "menguap", "menit_sejak_jeda", "menit_lelah_60"];
// skor per label as rules.ts computes it: poin / 4, at least 0.75 with PERCLOS ≥ 15%, 1 for "tertidur".
const SKOR_RANGE: Record<string, [number, number]> = {
  normal: [0, 0],
  "lelah ringan": [0.25, 0.5],
  lelah: [0.75, 1],
  tertidur: [1, 1],
  "tidak di depan layar": [0, 0],
};

// tanda (NOTES D-41) against the numbers and the label, as classify() in web/src/rules.ts
// would give them. Slow and fast blinks need the baseline, so only their count is checked.
function checkTanda(p: FatigueFeatures): string[] {
  const errors: string[] = [];
  const tanda = p.tanda ?? [];
  const asleep = tanda.filter((t) => t.startsWith("tertidur_"));
  if (p.label === "tertidur") {
    if (tanda.length !== 1 || asleep.length !== 1) errors.push(`tertidur butuh tepat satu tanda tertidur_*, ada: ${tanda.join(", ")}`);
    return errors;
  }
  if (asleep.length > 0) errors.push(`tanda tertidur_* pada label "${p.label}"`);
  if (p.label === "tidak di depan layar") {
    if (tanda.length > 0) errors.push("tanda pada label tidak di depan layar");
    return errors;
  }
  const fromNumbers: [string, boolean][] = [
    ["mata_sering_tertutup", (p.perclos ?? 0) >= RULES.perclosMild],
    ["menguap", (p.menguap ?? 0) >= RULES.yawns],
    ["mata_terpejam_lama", (p.mata_tertutup_lama ?? 0) >= RULES.longClosures],
  ];
  for (const [name, expected] of fromNumbers) {
    if (tanda.includes(name as never) !== expected) errors.push(`tanda ${name} ${expected ? "hilang" : "tidak sesuai angka"}`);
  }
  if (tanda.includes("kedipan_sering") && tanda.length === 1) errors.push("kedipan_sering tanpa tanda lain");
  const perclosTired = (p.perclos ?? 0) >= RULES.perclosTired;
  const label = perclosTired || tanda.length >= RULES.tiredPoints ? "lelah" : tanda.length >= 1 ? "lelah ringan" : "normal";
  if (label !== p.label) errors.push(`label "${p.label}", dari tanda: "${label}"`);
  const skor = Math.max(Math.min(1, tanda.length / 4), perclosTired ? 0.75 : 0);
  if (p.skor !== skor) errors.push(`skor ${p.skor}, dari tanda: ${skor}`);
  return errors;
}

function check(s: Scenario, globalPatterns: readonly string[]): string[] {
  const errors: string[] = [];
  const parsed = parseFeatures(s.payload);
  if (!parsed.ok) return [`payload ditolak server: ${parsed.error}`];

  const missing = ALWAYS_SENT.filter((key) => !(key in s.payload));
  if (missing.length > 0) errors.push(`field yang selalu dikirim app tidak ada: ${missing.join(", ")}`);

  const [lo, hi] = SKOR_RANGE[parsed.value.label];
  const skor = parsed.value.skor;
  if (skor === undefined || skor < lo || skor > hi) errors.push(`skor ${skor} tidak mungkin untuk "${parsed.value.label}" (${lo}–${hi})`);

  errors.push(...checkTanda(parsed.value));

  const input = toFlowInput(parsed.value);
  if ((input !== null) !== s.harapan.dikirim) errors.push(`dikirim ${s.harapan.dikirim}, server: ${input !== null}`);
  const status = input?.status ?? null;
  const durasi = input?.durasi_jeda_menit ?? null;
  if (status !== s.harapan.status) errors.push(`status "${s.harapan.status}", server: "${status}"`);
  if (durasi !== s.harapan.durasi_jeda_menit) errors.push(`durasi_jeda_menit ${s.harapan.durasi_jeda_menit}, server: ${durasi}`);

  for (const pattern of [...globalPatterns, ...s.harapan.dilarang_pola]) {
    try {
      new RegExp(pattern, "i");
    } catch {
      errors.push(`pola bukan regex: ${pattern}`);
    }
    // A control character here means an escape was lost on the way (NOTES G-35).
    if (/[\x00-\x1f]/.test(pattern)) errors.push(`pola berisi karakter kontrol: ${JSON.stringify(pattern)}`);
  }
  if (s.harapan.wajib.length === 0 && s.harapan.dikirim) errors.push("harapan.wajib kosong");
  return errors;
}

const file = JSON.parse(readFileSync(new URL("./skenario-uji.json", import.meta.url), "utf8")) as File;
const globalPatterns = file.aturan_umum.dilarang_pola;
let failed = 0;
const ids = new Set<string>();
for (const s of file.skenario) {
  const errors = check(s, globalPatterns);
  if (ids.has(s.id)) errors.push("id ganda");
  ids.add(s.id);
  if (errors.length > 0) {
    failed++;
    console.log(`✗ ${s.id} ${s.judul}\n    ${errors.join("\n    ")}`);
  }
}
const statuses = new Map<string, number>();
for (const s of file.skenario) statuses.set(String(s.harapan.status), (statuses.get(String(s.harapan.status)) ?? 0) + 1);
console.log(`${file.skenario.length - failed}/${file.skenario.length} skenario lolos`);
console.log(`status: ${[...statuses].map(([k, n]) => `${k} ×${n}`).join(", ")}`);

// Negative controls: the checker must reject each of these broken copies of S13.
const base = file.skenario.find((s) => s.id === "S13");
if (!base) throw new Error("S13 tidak ada");
const broken: [string, Scenario][] = [
  ["field asing", { ...base, payload: { ...base.payload, jenis_pekerjaan: "kode" } }],
  ["status salah", { ...base, harapan: { ...base.harapan, status: "perlu jeda" } }],
  ["skor tidak cocok label", { ...base, payload: { ...base.payload, skor: 0.25 } }],
  ["escape hilang", { ...base, harapan: { ...base.harapan, dilarang_pola: ["\bizin\b"] } }],
  ["tanda tidak cocok angka", { ...base, payload: { ...base.payload, tanda: ["mata_sering_tertutup"] } }],
  ["tanda asing", { ...base, payload: { ...base.payload, tanda: ["wajah_pucat"] } }],
];
const caught = broken.filter(([, s]) => check(s, globalPatterns).length > 0);
console.log(`kontrol negatif: ${caught.length}/${broken.length} tertolak (${broken.map(([name]) => name).join(", ")})`);

process.exitCode = failed > 0 || caught.length < broken.length ? 1 : 0;
