// Installs langflow-flows/prompt-<flow>.txt into the Prompt node of the live flow (PATCH), so the
// prompt kept in Git is the one Langflow runs. Afterwards run export.mjs <flowId> and cek-flow.mjs.
// The trailing newline of the .txt is dropped: the live template has none. No LLM call.
// Usage (from equilibre/): node langflow-flows/pasang-prompt.mjs <cari_panduan|ringkasan_harian|analisis_status> [--cek]
//   --cek  only compares the live template with the .txt, changes nothing
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);
const base = (process.env.LANGFLOW_URL || "http://127.0.0.1:7860").replace(/\/+$/, "");
const name = process.argv[2];
const checkOnly = process.argv.includes("--cek");
const NODE_ID = "Prompt-t2oaK";
if (!name) {
  console.error("Usage: node langflow-flows/pasang-prompt.mjs <flow> [--cek]");
  process.exit(1);
}
const { id } = JSON.parse(readFileSync(fileURLToPath(new URL(`./${name}.json`, import.meta.url)), "utf8"));
const wanted = readFileSync(fileURLToPath(new URL(`./prompt-${name}.txt`, import.meta.url)), "utf8").replace(/\r?\n$/, "");

const { access_token } = await (await fetch(`${base}/api/v1/auto_login`)).json();
const auth = { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" };
const flow = await (await fetch(`${base}/api/v1/flows/${id}`, { headers: auth })).json();
const node = flow.data?.nodes?.find((n) => n.id === NODE_ID);
if (!node) {
  console.error(`${name}: node ${NODE_ID} tidak ada di flow ${id}`);
  process.exit(1);
}
const field = node.data.node.template.template;
const same = field.value === wanted;
console.log(`${name}: prompt live ${same ? "sama dengan" : "berbeda dari"} prompt-${name}.txt (${field.value.length} vs ${wanted.length} karakter)`);
// process.exit() with fetch handles still open aborts Node on Windows (UV_HANDLE_CLOSING), so set exitCode.
if (same || checkOnly) {
  process.exitCode = same ? 0 : 1;
} else {
  field.value = wanted;
  const res = await fetch(`${base}/api/v1/flows/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ data: flow.data }) });
  console.log(`${name}: PATCH ${res.status}`);
  const after = await (await fetch(`${base}/api/v1/flows/${id}`, { headers: auth })).json();
  const readBack = after.data.nodes.find((n) => n.id === NODE_ID).data.node.template.template.value;
  console.log(`${name}: dibaca balik ${readBack === wanted ? "sama" : "BERBEDA"}`);
  process.exitCode = res.ok && readBack === wanted ? 0 : 1;
}
