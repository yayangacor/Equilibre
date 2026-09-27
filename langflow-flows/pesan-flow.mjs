// Prints the last messages that went in and out of a Langflow flow (monitor/messages): the text the
// flow received and what it answered, without API keys. Used to compare an app answer with the flow
// output ([[G-47]]). A User message whose session_id equals the flow id and has no AI reply is a
// partial build, not a failed run. No LLM call.
// Usage (from equilibre/): node langflow-flows/pesan-flow.mjs <analisis_status|cari_panduan|ringkasan_harian> [n=6]
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);
const base = (process.env.LANGFLOW_URL || "http://127.0.0.1:7860").replace(/\/+$/, "");
const [name, nArg] = process.argv.slice(2);
if (!name) {
  console.error("Usage: node langflow-flows/pesan-flow.mjs <flow> [n]");
  process.exit(1);
}
const n = Number(nArg ?? 6);
const { id } = JSON.parse(readFileSync(fileURLToPath(new URL(`./${name}.json`, import.meta.url)), "utf8"));

const { access_token } = await (await fetch(`${base}/api/v1/auto_login`)).json();
const res = await fetch(`${base}/api/v1/monitor/messages?flow_id=${id}`, {
  headers: { Authorization: `Bearer ${access_token}` },
});
if (!res.ok) {
  console.error(`monitor/messages: HTTP ${res.status}`);
  process.exit(1);
}
const messages = (await res.json()).sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
for (const m of n > 0 ? messages.slice(-n) : []) { // slice(-0) would be every message
  const session = m.session_id === id ? " (sesi = id flow)" : "";
  console.log(`--- ${m.timestamp} ${m.sender}${session}\n${m.text}`);
}
// Langflow 1.12 returns only the newest window (default 100 messages, max 200), so this is not a total;
// monitor/transactions has the total.
console.log(`\n${messages.length} pesan terbaru dibaca untuk ${name} (Langflow membatasi ke 100 terbaru)`);
