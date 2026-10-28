// Switches the three flows between the setups in profil.mts (NOTES D-76): model and max tokens of the
// Language Model node, knowledge base of the Knowledge node. PATCH per flow, then read back. No LLM
// call. Afterwards: node langflow-flows/export.mjs <flowId> for each flow, then cek-flow.mjs.
// Usage (from equilibre/): node langflow-flows/ganti-model.mts <gemini|watsonx> [--cek]
//   --cek  only prints the setup of each live flow, changes nothing
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LLM_NODE_ID } from "../server/src/analyze.ts";
import { KNOWLEDGE_NODE_ID } from "../server/src/features.ts";
import { FLOWS, PROFILES, type ProfileName } from "./profil.mts";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);
const base = (process.env.LANGFLOW_URL || "http://127.0.0.1:7860").replace(/\/+$/, "");
const target = process.argv[2] ?? "";
const checkOnly = process.argv.includes("--cek");
if (!(target in PROFILES)) {
  console.error(`Usage: node langflow-flows/ganti-model.mts <${Object.keys(PROFILES).join("|")}> [--cek]`);
  process.exit(1);
}
const profile = PROFILES[target as ProfileName];

type Field = { value?: unknown; options?: unknown[] };
type Node = { id: string; data: { node: { template: Record<string, Field> } } };
type Flow = { data: { nodes: Node[] } };
type Selection = { name?: string; provider?: string };

const template = (flow: Flow, id: string) => flow.data.nodes.find((n) => n.id === id)?.data.node.template;

function setup(flow: Flow) {
  const llm = template(flow, LLM_NODE_ID);
  const model = (llm?.model?.value as Selection[] | undefined)?.[0];
  return {
    model: model ? `${model.name} (${model.provider})` : null,
    maxTokens: llm?.max_tokens?.value ?? null,
    knowledgeBase: template(flow, KNOWLEDGE_NODE_ID)?.knowledge_base?.value ?? null,
  };
}

function matches(flow: Flow) {
  const s = setup(flow);
  return (
    s.model === `${profile.model.name} (${profile.model.provider})` &&
    s.maxTokens === profile.maxTokens &&
    (template(flow, KNOWLEDGE_NODE_ID) === undefined || s.knowledgeBase === profile.knowledgeBase)
  );
}

function apply(flow: Flow) {
  const llm = template(flow, LLM_NODE_ID);
  if (!llm?.model || !llm.max_tokens) throw new Error(`node ${LLM_NODE_ID} tidak lengkap`);
  llm.model.value = [profile.model];
  // Keep the picker able to show the selection when the flow is opened in the UI.
  const options = (llm.model.options ?? []) as Selection[];
  if (!options.some((o) => o.name === profile.model.name && o.provider === profile.model.provider)) {
    llm.model.options = [...options, profile.model];
  }
  llm.max_tokens.value = profile.maxTokens;
  const kb = template(flow, KNOWLEDGE_NODE_ID)?.knowledge_base;
  if (kb) {
    kb.value = profile.knowledgeBase;
    if (!(kb.options ?? []).includes(profile.knowledgeBase)) kb.options = [...(kb.options ?? []), profile.knowledgeBase];
  }
}

const { access_token } = await (await fetch(`${base}/api/v1/auto_login`)).json();
const auth = { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" };

let failed = 0;
for (const name of FLOWS) {
  const { id } = JSON.parse(readFileSync(fileURLToPath(new URL(`./${name}.json`, import.meta.url)), "utf8"));
  const res = await fetch(`${base}/api/v1/flows/${id}`, { headers: auth });
  if (!res.ok) {
    console.log(`${name}: flow ${id} tidak ada di Langflow (HTTP ${res.status})`);
    failed++;
    continue;
  }
  const flow = (await res.json()) as Flow;
  const before = setup(flow);
  console.log(`${name}: ${before.model}, max_tokens ${before.maxTokens}, knowledge base ${before.knowledgeBase ?? "-"}`);
  if (matches(flow)) {
    console.log(`${name}: sudah setelan ${target}`);
    continue;
  }
  if (checkOnly) {
    console.log(`${name}: belum setelan ${target}`);
    failed++;
    continue;
  }
  apply(flow);
  const patch = await fetch(`${base}/api/v1/flows/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ data: flow.data }) });
  const after = (await (await fetch(`${base}/api/v1/flows/${id}`, { headers: auth })).json()) as Flow;
  const ok = patch.ok && matches(after);
  const s = setup(after);
  console.log(`${name}: PATCH ${patch.status}, dibaca balik ${ok ? "sesuai" : "BERBEDA"}: ${s.model}, max_tokens ${s.maxTokens}, knowledge base ${s.knowledgeBase ?? "-"}`);
  if (!ok) failed++;
}
if (!checkOnly && failed === 0) console.log("Berikutnya: export.mjs <flowId> untuk tiap flow, lalu cek-flow.mjs.");
// process.exit() with fetch handles still open aborts Node on Windows (UV_HANDLE_CLOSING), so set exitCode.
process.exitCode = failed > 0 ? 1 : 0;
