// Compares the live Langflow flows with the exports in this folder: edges and the selected type of
// each output. Opening a flow in the Langflow 1.12.2 UI after a restart dropped the
// Knowledge.retrieve_data -> Parser edge and saved the flow (27 Sep): the flow still runs, but the
// knowledge base never reaches the prompt. With --penuh: every field, `show` included. A flow left
// open in the UI saves its own copy over changes made through the API, and refreshing it flips
// `show` on Knowledge fields; a hidden field is built with its default value (NOTES G-86).
// No LLM call; prints structure only, never the value of a secret field.
// Usage (from equilibre/): node langflow-flows/cek-flow.mjs [--penuh] [--pulihkan]
//   --pulihkan  writes the export back: the missing edges and selected types, or with --penuh the
//               whole flow data. Close every flow in the Langflow UI first.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describeValue, diffFlows, exportedPart } from "./bentuk-ekspor.mjs";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);
const base = (process.env.LANGFLOW_URL || "http://127.0.0.1:7860").replace(/\/+$/, "");
const restore = process.argv.includes("--pulihkan");
const full = process.argv.includes("--penuh");
const NAMES = ["analisis_status", "cari_panduan", "ringkasan_harian"];

const { access_token } = await (await fetch(`${base}/api/v1/auto_login`)).json();
const auth = { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" };
const edgeName = (e) => `${e.source}.${e.data?.sourceHandle?.name} -> ${e.target}.${e.data?.targetHandle?.fieldName}`;

let problems = 0;
let unrestored = 0;
for (const name of NAMES) {
  const exported = JSON.parse(readFileSync(fileURLToPath(new URL(`./${name}.json`, import.meta.url)), "utf8"));
  const res = await fetch(`${base}/api/v1/flows/${exported.id}`, { headers: auth });
  if (!res.ok) {
    console.log(`${name}: flow ${exported.id} tidak ada di Langflow (HTTP ${res.status})`);
    problems++;
    continue;
  }
  const live = await res.json();

  if (full) {
    const { part, blanked } = exportedPart(live);
    const { diffs, compared } = diffFlows(part, exported);
    if (diffs.length === 0) {
      console.log(`${name}: sama dengan ekspor (${compared} nilai)`);
      continue;
    }
    problems++;
    console.log(`${name}: ${diffs.length} dari ${compared} nilai beda dari ekspor`);
    for (const d of diffs) console.log(`  ${d.path}\n    live:   ${describeValue(d.path, d.live)}\n    ekspor: ${describeValue(d.path, d.ekspor)}`);
    if (!restore) continue;
    // The export has raw secrets blanked, so writing it over a flow that holds one would erase it.
    if (blanked > 0) {
      console.log(`${name}: tidak dipulihkan: ${blanked} field rahasia di flow live diisi langsung, bukan lewat Global Variable`);
      unrestored++;
      continue;
    }
    const patch = await fetch(`${base}/api/v1/flows/${exported.id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ data: exported.data }) });
    const back = await (await fetch(`${base}/api/v1/flows/${exported.id}`, { headers: auth })).json();
    const left = diffFlows(exportedPart(back).part, exported).diffs.length;
    console.log(`${name}: dipulihkan dari ekspor (PATCH ${patch.status}), dibaca balik ${left} beda`);
    if (!patch.ok || left > 0) unrestored++;
    continue;
  }

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
if (problems > 0 && !restore) {
  console.log(`Untuk memasang kembali dari ekspor: tutup semua flow di UI Langflow, lalu jalankan lagi dengan ${full ? "--penuh --pulihkan" : "--pulihkan"}.`);
}
// process.exit() with fetch handles still open aborts Node on Windows (UV_HANDLE_CLOSING), so set exitCode.
process.exitCode = (problems > 0 && !restore) || unrestored > 0 ? 1 : 0;
