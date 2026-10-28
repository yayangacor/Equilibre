// Asks the cari_panduan flow one question the way Bob's MCP tool call does (question as Chat Input,
// no tweaks), but without Bob, whose key is dead (NOTES G-81, D-76). One LLM call plus one embedding
// call, so nothing is sent without --jalankan (NOTES D-19). Prints the answer, its latency, the model
// that answered and the notes retrieved, read back from Langflow's transaction log.
// Usage (from equilibre/): node langflow-flows/tanya-panduan.mts "<pertanyaan>" [--jalankan]
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LLM_NODE_ID } from "../server/src/analyze.ts";
import { KNOWLEDGE_NODE_ID } from "../server/src/features.ts";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);
const base = (process.env.LANGFLOW_URL || "http://127.0.0.1:7860").replace(/\/+$/, "");
const API_KEY = process.env.LANGFLOW_API_KEY ?? "";
const TIMEOUT_MS = 60_000;
const question = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "";
const run = process.argv.includes("--jalankan");
if (question.trim() === "") {
  console.error('Usage: node langflow-flows/tanya-panduan.mts "<pertanyaan>" [--jalankan]');
  process.exit(1);
}
const { id: flowId } = JSON.parse(readFileSync(new URL("./cari_panduan.json", import.meta.url), "utf8")) as { id: string };
console.log(`cari_panduan ${flowId}: "${question}"`);
if (!run) {
  console.log("Tidak ada yang dipanggil. Tambahkan --jalankan untuk 1 panggilan LLM.");
  process.exit(0);
}
if (!API_KEY) {
  console.error("Isi LANGFLOW_API_KEY di .env.");
  process.exit(1);
}

type Transaction = { id: string; vertex_id: string; status: string; inputs?: Record<string, unknown>; outputs?: Record<string, unknown> };
// The transaction log needs the admin token (AUTO_LOGIN), /run needs the API key (NOTES G-40).
const { access_token } = await (await fetch(`${base}/api/v1/auto_login`)).json();
async function transactions(): Promise<Transaction[]> {
  const res = await fetch(`${base}/api/v1/monitor/transactions?flow_id=${flowId}&page=1&size=20`, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  return ((await res.json()) as { items: Transaction[] }).items;
}

const seen = new Set((await transactions()).map((t) => t.id));
const started = Date.now();
let text = "";
try {
  const res = await fetch(`${base}/api/v1/run/${flowId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
    body: JSON.stringify({ input_value: question, input_type: "chat", output_type: "chat" }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.text();
  if (!res.ok) {
    console.log(`HTTP ${res.status} setelah ${Date.now() - started} ms: ${body.slice(0, 500)}`);
    process.exitCode = 1;
  } else {
    const message = (JSON.parse(body) as { outputs?: { outputs?: { results?: { message?: { text?: unknown } } }[] }[] }).outputs?.[0]?.outputs?.[0]
      ?.results?.message;
    text = typeof message?.text === "string" ? message.text : "";
    console.log(`HTTP ${res.status} dalam ${Date.now() - started} ms${text.trim() === "" ? ", JAWABAN KOSONG" : ""}`);
    if (text.trim() === "") process.exitCode = 1;
  }
} catch (err) {
  console.log((err as Error).name === "TimeoutError" ? `tidak menjawab dalam ${TIMEOUT_MS / 1000} detik` : (err as Error).message);
  process.exitCode = 1;
}

// Only file names, scores and the model name are printed: the node inputs also hold credentials.
const fresh = (await transactions()).filter((t) => !seen.has(t.id));
const llm = fresh.find((t) => t.vertex_id === LLM_NODE_ID);
const knowledge = fresh.find((t) => t.vertex_id === KNOWLEDGE_NODE_ID);
const rows = ((knowledge?.outputs?.retrieve_data as { message?: unknown } | undefined)?.message ?? []) as { file_name?: string; _score?: number }[];
console.log(`model: ${(llm?.inputs?.model as { name?: string }[] | undefined)?.[0]?.name ?? "?"} (${llm?.status ?? "tidak tercatat"})`);
console.log(`konteks: ${Array.isArray(rows) ? rows.map((r) => `${r.file_name} ${r._score?.toFixed(3)}`).join(", ") : "?"}`);
if (text) console.log(`---\n${text}`);
