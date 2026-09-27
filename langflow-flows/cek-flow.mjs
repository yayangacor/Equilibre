// Compares the live Langflow flows with the exports in this folder: edges and the selected type of
// each output. Opening a flow in the Langflow 1.12.2 UI after a restart dropped the
// Knowledge.retrieve_data -> Parser edge and saved the flow (27 Sep): the flow still runs, but the
// knowledge base never reaches the prompt. No LLM call; prints structure only.
// Usage (from equilibre/): node langflow-flows/cek-flow.mjs [--pulihkan]
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);
const base = (process.env.LANGFLOW_URL || "http://127.0.0.1:7860").replace(/\/+$/, "");
const restore = process.argv.includes("--pulihkan");
const NAMES = ["analisis_status", "cari_panduan", "ringkasan_harian"];

const { access_token } = await (await fetch(`${base}/api/v1/auto_login`)).json();
const auth = { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" };
const edgeName = (e) => `${e.source}.${e.data?.sourceHandle?.name} -> ${e.target}.${e.data?.targetHandle?.fieldName}`;

let problems = 0;
for (const name of NAMES) {
  const exported = JSON.parse(readFileSync(fileURLToPath(new URL(`./${name}.json`, import.meta.url)), "utf8"));
  const res = await fetch(`${base}/api/v1/flows/${exported.id}`, { headers: auth });
  if (!res.ok) {
    console.log(`${name}: flow ${exported.id} tidak ada di Langflow (HTTP ${res.status})`);
    problems++;
    continue;
  }
  const live = await res.json();
  const liveEdges = new Set(live.data.edges.map(edgeName));
  const missing = exported.data.edges.filter((e) => !liveEdges.has(edgeName(e)));
  const selected = [];
  for (const n of live.data.nodes) {
    const exp = exported.data.nodes.find((x) => x.id === n.id);
    for (const o of n.data.node?.outputs ?? []) {
      const eo = exp?.data.node?.outputs?.find((x) => x.name === o.name);
      if (eo?.selected !== undefined && o.selected !== eo.selected) selected.push({ o, value: eo.selected, label: `${n.id}.${o.name}` });
    }
  }
  if (missing.length === 0 && selected.length === 0) {
    console.log(`${name}: cocok (${live.data.edges.length} edge)`);
    continue;
  }
  problems++;
  for (const e of missing) console.log(`${name}: edge hilang ${edgeName(e)}`);
  for (const s of selected) console.log(`${name}: output ${s.label} selected ${s.o.selected} (ekspor: ${s.value})`);
  if (!restore) continue;
  live.data.edges.push(...missing);
  for (const s of selected) s.o.selected = s.value;
  const patch = await fetch(`${base}/api/v1/flows/${exported.id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ data: live.data }) });
  console.log(`${name}: dipulihkan (PATCH ${patch.status})`);
}
if (problems > 0 && !restore) console.log("Jalankan lagi dengan --pulihkan untuk memasang kembali dari ekspor.");
process.exitCode = problems > 0 && !restore ? 1 : 0;
