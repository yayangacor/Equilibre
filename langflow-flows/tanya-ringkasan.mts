// Runs the ringkasan_harian flow once with the input Bob's MCP tool call sends (the DATA_HARI_INI JSON of
// server/src/tanya.ts as Chat Input, no tweaks), without Bob. One LLM call, so nothing is sent without
// --jalankan (NOTES D-19). Prints the raw answer, whether it parses, its latency and the model that answered,
// read back from Langflow's transaction log, then the answer after the server's withoutNoHistory guard.
// Usage (from equilibre/): node langflow-flows/tanya-ringkasan.mts <kosong|angka> [--jalankan]
//   kosong  hari_ini null: the flow must reply exactly NO_HISTORY
//   angka   today's numbers, label "lelah ringan": state names, "5.5 out of 9", no calibration sentence
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LLM_NODE_ID } from "../server/src/analyze.ts";
import { parseJsonReply } from "../server/src/reply.ts";
import { NO_HISTORY, withoutNoHistory, type HariIni } from "../server/src/tanya.ts";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);
const base = (process.env.LANGFLOW_URL || "http://127.0.0.1:7860").replace(/\/+$/, "");
const API_KEY = process.env.LANGFLOW_API_KEY ?? "";
const TIMEOUT_MS = 60_000;

const ANGKA: HariIni = {
  menit_normal: 182,
  menit_lelah_ringan: 24.5,
  menit_lelah: 6,
  menit_tertidur: 0,
  menit_tidak_di_depan_layar: 31,
  jumlah_jeda: 3,
  kss_rata_rata: 5.5,
};
// The same JSON tanyaPrompt() puts after DATA_HARI_INI, which Bob is told to pass on as it is.
const INPUTS = {
  kosong: { status: null, label: null, hari_ini: null, catatan: "no history for today yet" },
  // The status the server derives from the label (features.ts toFlowInput).
  angka: { status: "perlu jeda singkat", label: "lelah ringan", hari_ini: ANGKA },
} as const;

const which = process.argv.slice(2).find((a) => !a.startsWith("--")) as keyof typeof INPUTS | undefined;
const run = process.argv.includes("--jalankan");
if (!which || !(which in INPUTS)) {
  console.error("Usage: node langflow-flows/tanya-ringkasan.mts <kosong|angka> [--jalankan]");
  process.exit(1);
}
const input = JSON.stringify(INPUTS[which]);
const { id: flowId } = JSON.parse(readFileSync(new URL("./ringkasan_harian.json", import.meta.url), "utf8")) as { id: string };
console.log(`ringkasan_harian ${flowId}: ${input}`);
if (!run) {
  console.log("Tidak ada yang dipanggil. Tambahkan --jalankan untuk 1 panggilan LLM.");
  process.exit(0);
}
if (!API_KEY) {
  console.error("Isi LANGFLOW_API_KEY di .env.");
  process.exit(1);
}

type Transaction = { id: string; vertex_id: string; status: string; inputs?: Record<string, unknown> };
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
    body: JSON.stringify({ input_value: input, input_type: "chat", output_type: "chat" }),
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

// Only the model name is printed: the node inputs also hold credentials.
const llm = (await transactions()).filter((t) => !seen.has(t.id)).find((t) => t.vertex_id === LLM_NODE_ID);
console.log(`model: ${(llm?.inputs?.model as { name?: string }[] | undefined)?.[0]?.name ?? "?"} (${llm?.status ?? "tidak tercatat"})`);
if (!text) process.exit();
console.log(`---\n${text}\n---`);
const reply = parseJsonReply(text);
const jawaban = reply && typeof (reply as { jawaban?: unknown }).jawaban === "string" ? (reply as { jawaban: string }).jawaban : null;
if (jawaban === null) {
  console.log("TIDAK TERBACA sebagai {\"jawaban\": ...}");
  process.exitCode = 1;
} else if (which === "kosong") {
  console.log(jawaban === NO_HISTORY ? "persis NO_HISTORY: ya" : `persis NO_HISTORY: TIDAK\n  diharapkan: ${NO_HISTORY}`);
} else {
  const guarded = withoutNoHistory(jawaban);
  console.log(`setelah withoutNoHistory (server): ${guarded === jawaban ? "tidak berubah" : guarded}`);
}
