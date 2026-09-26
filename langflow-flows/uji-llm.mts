// Plan P05 step 5: runs the scenarios of skenario-uji.json through the analisis_status flow
// with one model and saves every answer, its latency and automatic checks for the rubric
// (RESEARCH.md §8). One LLM call per scenario, so nothing is called without --jalankan
// (NOTES D-19): without it the script only prints what it would send.
// The model is set per run with a tweak on the LLM node; which model actually answered and
// which notes were retrieved are read back from Langflow's transaction log, not assumed.
// Usage (from equilibre/):
//   node langflow-flows/uji-llm.mts --model=mistral|granite [--skenario=S01,S15] [--jalankan]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { LLM_NODE_ID } from "../server/src/analyze.ts";
import { PANDUAN_TOP_K, panduanTweaks, parseFeatures, toFlowInput, type FlowInput } from "../server/src/features.ts";
import { parseJsonReply } from "../server/src/reply.ts";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);
const BASE = (process.env.LANGFLOW_URL || "http://127.0.0.1:7860").replace(/\/+$/, "");
const FLOW_ID = process.env.LANGFLOW_FLOW_ID ?? "";
const API_KEY = process.env.LANGFLOW_API_KEY ?? "";

const WATSONX_METADATA = {
  icon: "IBM",
  tool_calling: true,
  reasoning: false,
  search: false,
  preview: false,
  not_supported: false,
  deprecated: false,
  default: false,
  model_type: "llm",
  created: 0,
};
// Candidates on watsonx Dallas (NOTES D-39, G-41). Qwen is not tested here: user decision 26 Sep
// to leave the fallback as it is (G-42).
const MODELS: Record<string, string> = {
  mistral: "mistralai/mistral-small-3-1-24b-instruct-2503",
  granite: "ibm/granite-4-h-small",
};
const TIMEOUT_MS = 60_000;
const MAX_FAILURES_IN_A_ROW = 3;
const PAUSE_MS = 1_000;

type Scenario = {
  id: string;
  judul: string;
  payload: Record<string, unknown>;
  harapan: { dikirim: boolean; status: string | null; durasi_jeda_menit: number | null; wajib: string[]; dilarang_pola: string[] };
};
type ScenarioFile = { aturan_umum: { dilarang_pola: string[] }; skenario: Scenario[] };
type Transaction = { id: string; timestamp: string; vertex_id: string; status: string; inputs?: Record<string, unknown>; outputs?: Record<string, unknown> };

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : (hit.split("=")[1] ?? "");
}

const modelKey = arg("model") ?? "";
const run = arg("jalankan") !== undefined;
const only = arg("skenario")?.split(",").map((s) => s.trim().toUpperCase());
if (!(modelKey in MODELS)) {
  console.error(`--model harus salah satu dari: ${Object.keys(MODELS).join(", ")}`);
  process.exit(1);
}
const modelName = MODELS[modelKey];

const file = JSON.parse(readFileSync(new URL("./skenario-uji.json", import.meta.url), "utf8")) as ScenarioFile;
const knowledgeFiles = new Set(
  readdirSync(new URL("../knowledge/", import.meta.url)).filter((f) => f.endsWith(".md") && f !== "README.md"),
);
const prompt = readFileSync(new URL("./prompt-analisis_status.txt", import.meta.url), "utf8");

const planned = file.skenario
  .filter((s) => !only || only.includes(s.id))
  .map((s) => {
    const parsed = parseFeatures(s.payload);
    if (!parsed.ok) throw new Error(`${s.id}: payload ditolak server (${parsed.error})`);
    return { s, input: toFlowInput(parsed.value) };
  });
const toCall = planned.filter((p): p is { s: Scenario; input: FlowInput } => p.input !== null);

console.log(`Model: ${modelName}`);
console.log(`Skenario: ${planned.length}, dipanggil: ${toCall.length} (tidak dikirim: ${planned.filter((p) => !p.input).map((p) => p.s.id).join(", ") || "-"})`);
if (!run) {
  for (const { s, input } of toCall) console.log(`  ${s.id}  ${input.status}  "${panduanTweaks(input.status)["Knowledge-panduan"].search_query}"`);
  console.log(`Tidak ada yang dipanggil. Tambahkan --jalankan untuk ${toCall.length} panggilan LLM.`);
  process.exit(0);
}
if (!FLOW_ID || !API_KEY) {
  console.error("Isi LANGFLOW_API_KEY dan LANGFLOW_FLOW_ID di .env.");
  process.exit(1);
}

// The transaction log needs the admin token (AUTO_LOGIN), /run needs the API key (NOTES G-40).
const adminToken = ((await (await fetch(`${BASE}/api/v1/auto_login`)).json()) as { access_token: string }).access_token;

async function transactions(): Promise<Transaction[]> {
  const res = await fetch(`${BASE}/api/v1/monitor/transactions?flow_id=${FLOW_ID}&page=1&size=20`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  return ((await res.json()) as { items: Transaction[] }).items;
}

// Only file names, scores and the model name are kept: the node inputs also hold credentials.
function readBack(fresh: Transaction[]) {
  const llm = fresh.find((t) => t.vertex_id === LLM_NODE_ID);
  const knowledge = fresh.find((t) => t.vertex_id === "Knowledge-panduan");
  const model = (llm?.inputs?.model as { name?: string }[] | undefined)?.[0]?.name ?? null;
  const rows = ((knowledge?.outputs?.retrieve_data as { message?: unknown } | undefined)?.message ?? []) as {
    file_name?: string;
    _score?: number;
  }[];
  return {
    model_dipakai: model,
    status_llm: llm?.status ?? null,
    konteks: Array.isArray(rows) ? rows.map((r) => ({ file: r.file_name ?? null, skor: r._score ?? null })) : [],
  };
}

const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).filter((x) => x.trim() !== "").length;

function checks(s: Scenario, input: FlowInput, text: string, konteks: string[]) {
  const reply = parseJsonReply(text);
  const obj = reply !== null && typeof reply === "object" && !Array.isArray(reply) ? (reply as Record<string, unknown>) : null;
  const rekomendasi = typeof obj?.rekomendasi === "string" ? obj.rekomendasi : null;
  const alasan = typeof obj?.alasan === "string" ? obj.alasan : null;
  const sumber = Array.isArray(obj?.sumber) ? obj.sumber.map(String) : null;
  const all = `${rekomendasi ?? ""} ${alasan ?? ""}`;
  const patterns = [...s.harapan.dilarang_pola, ...file.aturan_umum.dilarang_pola];
  return {
    json: obj !== null,
    dibungkus_fence: /^\s*```/.test(text),
    format_lengkap: rekomendasi !== null && alasan !== null && sumber !== null,
    field_lain: obj ? Object.keys(obj).filter((k) => !["rekomendasi", "alasan", "sumber"].includes(k)) : [],
    sumber_di_luar_kb: sumber ? sumber.filter((f) => !knowledgeFiles.has(f)) : [],
    sumber_di_luar_konteks: sumber ? sumber.filter((f) => !konteks.includes(f)) : [],
    kalimat_rekomendasi: rekomendasi ? sentences(rekomendasi) : null,
    kalimat_alasan: alasan ? sentences(alasan) : null,
    menyebut_durasi: input.durasi_jeda_menit ? new RegExp(`\\b${input.durasi_jeda_menit}\\s*menit`, "i").test(all) : null,
    // Flagged for manual review (a match can be a negation), not an automatic failure.
    pola_dilarang: patterns.filter((p) => new RegExp(p, "i").test(all)),
  };
}

// Written after every call, so a crash halfway keeps the answers already paid for.
const outDir = fileURLToPath(new URL("./hasil-uji/", import.meta.url));
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const outName = `${modelKey}-${stamp}.json`;
function save(results: { error: string | null }[]) {
  const summary = {
    model: modelName,
    waktu_utc: new Date().toISOString(),
    prompt_sha256: createHash("sha256").update(prompt).digest("hex").slice(0, 12),
    dipanggil: results.length,
    berhasil: results.filter((r) => !r.error).length,
    hasil: results,
  };
  writeFileSync(`${outDir}${outName}`, JSON.stringify(summary, null, 2) + "\n");
}

const results = [];
let failuresInARow = 0;
for (const { s, input } of toCall) {
  const seen = new Set((await transactions()).map((t) => t.id));
  const tweaks = { ...panduanTweaks(input.status), [LLM_NODE_ID]: { model: [{ name: modelName, provider: "IBM WatsonX", category: "IBM WatsonX", icon: "IBM", metadata: WATSONX_METADATA }] } };
  const started = Date.now();
  let http: number | null = null;
  let text = "";
  let usage: unknown = null;
  let error: string | null = null;
  try {
    const res = await fetch(`${BASE}/api/v1/run/${FLOW_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify({ input_value: JSON.stringify(input), input_type: "chat", output_type: "chat", tweaks }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    http = res.status;
    const body = await res.text();
    if (!res.ok) error = body.slice(0, 500);
    else {
      const message = (JSON.parse(body) as { outputs?: { outputs?: { results?: { message?: { text?: unknown; properties?: { usage?: unknown } } } }[] }[] })
        .outputs?.[0]?.outputs?.[0]?.results?.message;
      text = typeof message?.text === "string" ? message.text : "";
      usage = message?.properties?.usage ?? null;
      if (text.trim() === "") error = "jawaban kosong";
    }
  } catch (err) {
    error = (err as Error).name === "TimeoutError" ? `tidak menjawab dalam ${TIMEOUT_MS / 1000} detik` : (err as Error).message;
  }
  const latency_ms = Date.now() - started;
  const back = readBack((await transactions()).filter((t) => !seen.has(t.id)));
  const konteks = back.konteks.map((k) => k.file).filter((f): f is string => f !== null);
  const result = {
    id: s.id,
    judul: s.judul,
    status: input.status,
    durasi_jeda_menit: input.durasi_jeda_menit,
    http,
    latency_ms,
    ...back,
    usage,
    error,
    teks: text,
    cek: error ? null : checks(s, input, text, konteks),
    wajib: s.harapan.wajib,
  };
  results.push(result);
  save(results);
  const c = result.cek;
  console.log(
    `${s.id} ${String(http).padEnd(4)} ${String(latency_ms).padStart(6)} ms  model=${back.model_dipakai}  konteks=${konteks.length}` +
      (c ? `  json=${c.json} sumber_luar=${c.sumber_di_luar_kb.length + c.sumber_di_luar_konteks.length} pola=${c.pola_dilarang.join("|") || "-"}` : `  GAGAL: ${error}`),
  );
  // A model that did not answer as asked would make every later result mislabelled.
  if (back.model_dipakai !== null && back.model_dipakai !== modelName) {
    console.error(`Berhenti: Langflow memakai ${back.model_dipakai}, bukan ${modelName}. Tweak model tidak berlaku.`);
    break;
  }
  // Same for the context: a hidden top_k field ignores the tweak and retrieves 5 notes (NOTES G-43).
  if (konteks.length > 0 && konteks.length !== PANDUAN_TOP_K) {
    console.error(`Berhenti: konteks berisi ${konteks.length} catatan, bukan ${PANDUAN_TOP_K}. Tweak top_k tidak berlaku.`);
    break;
  }
  failuresInARow = error ? failuresInARow + 1 : 0;
  if (failuresInARow >= MAX_FAILURES_IN_A_ROW) {
    console.error(`Berhenti: ${MAX_FAILURES_IN_A_ROW} panggilan gagal berturut-turut.`);
    break;
  }
  await new Promise((r) => setTimeout(r, PAUSE_MS));
}

console.log(`Tersimpan: langflow-flows/hasil-uji/${outName} (${results.length} panggilan)`);
