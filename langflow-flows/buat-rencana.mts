// Builds the fourth flow, rencana_kerja (plan P20 W2.4, NOTES D-83, D-84, D-90), from analisis_status.json as the
// template, so the node ids the server and the other scripts use stay the same: the Language Model node
// LanguageModelComponent-FLeYF (server/src/analyze.ts LLM_NODE_ID: the Gemini fallback tweak of /api/rencana
// reaches it), Knowledge-panduan (ganti-model.mts) and Prompt-t2oaK (pasang-prompt.mjs).
//
//   Chat Input (the /api/rencana body as JSON)
//     → Task Matcher (komponen/task_matcher.py: rules + score, picks the steps and the task)
//         .rencana → Language Model input        (what the LLM explains)
//         .kueri   → Knowledge search_query (v4) → Parser → Prompt context → Language Model system message
//     → Language Model (watsonx Mistral Small 3.1, the template's settings) → Chat Output (JSON, checked by the server)
//
// The Task Matcher node is made by lfx itself (komponen/bentuk_node.py, run in the Python of the Langflow install,
// offline), so its template, outputs and code hash are what Langflow makes when the code is pasted into a Custom
// Component. The JSON parse of the answer is the server's (server/src/rencana.ts parseRencanaReply); the Parser in
// the flow formats the knowledge base rows, as in the other flows.
//
// Usage (from equilibre/):
//   node langflow-flows/buat-rencana.mts --tulis        writes langflow-flows/rencana_kerja.json (offline)
//   node langflow-flows/buat-rencana.mts --cek          offline: rencana_kerja.json equals a fresh build, structure checks
//   node langflow-flows/buat-rencana.mts --unggah [--ganti]
//        uploads rencana_kerja.json to the Langflow at LANGFLOW_URL with its own id (PUT /api/v1/flows/{id}, upsert,
//        Langflow 1.12.2 source langflow/api/v1/flows.py upsert_flow), then reads it back. No LLM call. Without
//        --ganti an existing flow with this id is left alone. Close the flow in the Langflow UI first (NOTES G-86).
// Python of the Langflow install: LANGFLOW_PYTHON, or ../langflow/.venv next to the equilibre folder.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LLM_NODE_ID } from "../server/src/analyze.ts";
import { KNOWLEDGE_NODE_ID } from "../server/src/features.ts";
import { describeValue, diffFlows, exportedPart, KEY_PATTERN } from "./bentuk-ekspor.mjs";
import { RENCANA_KNOWLEDGE_BASE } from "./profil.mts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const OUT = here("./rencana_kerja.json");
const COMPONENT = here("./komponen/task_matcher.py");
const SERIALIZER = here("./komponen/bentuk_node.py");
const PROMPT = here("./prompt-rencana_kerja.txt");

// The flow's own id, fixed so .env (LANGFLOW_RENCANA_FLOW_ID), cek-flow.mjs and ganti-model.mts find it after upload.
const FLOW_ID = "08662df6-d885-4cea-891f-b558071e7c71";
const TASK_MATCHER_ID = "TaskMatcher-rencana";
const CHAT_INPUT_ID = "ChatInput-b6UCc";
const PROMPT_ID = "Prompt-t2oaK";
const CHAT_OUTPUT_ID = "ChatOutput-yK0AU";
const PARSER_ID = "ParserComponent-panduan";
const KEPT = [CHAT_INPUT_ID, PROMPT_ID, CHAT_OUTPUT_ID, LLM_NODE_ID, KNOWLEDGE_NODE_ID, PARSER_ID];

type Field = { value?: unknown; options?: unknown[]; input_types?: string[]; type?: string; show?: boolean };
type OutputDef = { name: string; types: string[] };
type FlowNode = {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: { id: string; type: string; node: { template: Record<string, Field>; outputs: OutputDef[] }; [k: string]: unknown };
  [k: string]: unknown;
};
type Handle = Record<string, unknown>;
type Edge = { source: string; target: string; data: { sourceHandle: Handle; targetHandle: Handle }; [k: string]: unknown };
type Flow = {
  id: string;
  name: string;
  description: string;
  endpoint_name: string;
  mcp_enabled: boolean;
  action_name: string | null;
  action_description: string | null;
  data: { nodes: FlowNode[]; edges: Edge[]; viewport: unknown };
};

// The handle strings of a Langflow 1.12.2 edge: the handle object as JSON with every " written as œ.
const handleString = (h: Handle) => JSON.stringify(h).replaceAll('"', "œ");
// JSON with the keys of every object sorted, to compare values whatever the key order.
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x,
  );

function makeEdge(nodes: Map<string, FlowNode>, source: string, output: string, target: string, field: string): Edge {
  const s = nodes.get(source);
  const t = nodes.get(target);
  const out = s?.data.node.outputs.find((o) => o.name === output);
  const input = t?.data.node.template[field];
  if (!s || !t || !out || !input) throw new Error(`edge ${source}.${output} -> ${target}.${field}: node, output or field missing`);
  const sourceHandle = { dataType: s.data.type, id: source, name: output, output_types: out.types };
  const targetHandle = { fieldName: field, id: target, inputTypes: input.input_types, type: input.type };
  return {
    animated: false,
    className: "",
    data: { sourceHandle, targetHandle },
    id: `reactflow__edge-${source}${handleString(sourceHandle)}-${target}${handleString(targetHandle)}`,
    selected: false,
    source,
    sourceHandle: handleString(sourceHandle),
    target,
    targetHandle: handleString(targetHandle),
  };
}

function pythonPath(): string {
  if (process.env.LANGFLOW_PYTHON) return process.env.LANGFLOW_PYTHON;
  const venv = here("../../langflow/.venv/");
  return process.platform === "win32" ? `${venv}Scripts\\python.exe` : `${venv}bin/python`;
}

// The Task Matcher node as lfx builds it from the code (bentuk_node.py). Offline: no Langflow server, no LLM. lfx
// gets a config folder of its own in the temp folder, so the Langflow install's own config is never read or written.
function taskMatcherNode(): { type: string; node: FlowNode["data"]["node"] } {
  const out = execFileSync(pythonPath(), ["-I", SERIALIZER, COMPONENT], {
    encoding: "utf8",
    env: { ...process.env, DO_NOT_TRACK: "true", LANGFLOW_CONFIG_DIR: join(tmpdir(), "equilibre-bentuk-node") },
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out);
}

function build(): Flow {
  const template = JSON.parse(readFileSync(here("./analisis_status.json"), "utf8")) as Flow;
  const nodes = new Map<string, FlowNode>();
  for (const id of KEPT) {
    const n = template.data.nodes.find((x) => x.id === id);
    if (!n) throw new Error(`analisis_status.json has no node ${id}`);
    nodes.set(id, structuredClone(n));
  }

  // The prompt kept in Git, without its trailing newline (as pasang-prompt.mjs installs it).
  const prompt = nodes.get(PROMPT_ID)!.data.node.template.template;
  prompt.value = readFileSync(PROMPT, "utf8").replace(/\r?\n$/, "");

  // Knowledge: v4, searched with the Task Matcher's query through an edge (the field is shown, NOTES G-40).
  const kb = nodes.get(KNOWLEDGE_NODE_ID)!;
  kb.selected = false;
  const kbField = kb.data.node.template.knowledge_base;
  kbField.value = RENCANA_KNOWLEDGE_BASE;
  if (!(kbField.options ?? []).includes(RENCANA_KNOWLEDGE_BASE)) kbField.options = [...(kbField.options ?? []), RENCANA_KNOWLEDGE_BASE];
  kb.data.node.template.search_query.value = "";
  kb.data.node.template.search_query.show = true;

  const input = nodes.get(CHAT_INPUT_ID)!;
  input.position = { x: -660, y: 700 };
  input.data.node.template.input_value.value = "";

  const tm = taskMatcherNode();
  nodes.set(TASK_MATCHER_ID, {
    id: TASK_MATCHER_ID,
    type: "genericNode",
    position: { x: -211, y: 640 },
    data: { id: TASK_MATCHER_ID, type: tm.type, node: tm.node },
    selected: false,
    measured: { width: 320, height: 260 },
  });

  const edges = [
    makeEdge(nodes, CHAT_INPUT_ID, "message", TASK_MATCHER_ID, "masukan"),
    makeEdge(nodes, TASK_MATCHER_ID, "rencana", LLM_NODE_ID, "input_value"),
    makeEdge(nodes, TASK_MATCHER_ID, "kueri", KNOWLEDGE_NODE_ID, "search_query"),
    makeEdge(nodes, KNOWLEDGE_NODE_ID, "retrieve_data", PARSER_ID, "input_data"),
    makeEdge(nodes, PARSER_ID, "parsed_text", PROMPT_ID, "context"),
    makeEdge(nodes, PROMPT_ID, "prompt", LLM_NODE_ID, "system_message"),
    makeEdge(nodes, LLM_NODE_ID, "text_output", CHAT_OUTPUT_ID, "input_value"),
  ];
  // Self-check of makeEdge: the edges taken over from the template come out with the same values as stored there
  // (key order aside: the template's edges were saved by the UI and by the API in two orders).
  const templateEdges = new Map(template.data.edges.map((e) => [e.id, e]));
  for (const e of edges) {
    const same = templateEdges.get(e.id as string);
    if (same && canonical(same) !== canonical(e)) throw new Error(`makeEdge differs from the template for ${e.id}`);
  }
  if (edges.filter((e) => templateEdges.has(e.id as string)).length !== 4) throw new Error("expected 4 edges equal to the template");

  return {
    id: FLOW_ID,
    name: "rencana_kerja",
    description:
      "Plan my next hour (plan P20 W2.4). Input: JSON body /api/rencana (fase, jam_rawan, menit_sejak_jeda, tugas abstrak t1..tn). " +
      "Task Matcher (aturan + skor) memilih langkah dan tugas; LLM menjelaskan dengan knowledge base v4. " +
      "Output: JSON {langkah, tugas_id, alasan, sumber}, judul tugas tidak pernah dikirim (D-90).",
    endpoint_name: "rencana_kerja",
    // Not an MCP tool: only the server calls it, and Bob keeps his two tools (NOTES D-45).
    mcp_enabled: false,
    action_name: null,
    action_description: null,
    data: { nodes: [...nodes.values()], edges, viewport: template.data.viewport },
  };
}

// Offline checks of a flow file: what the server, the scripts and Langflow's graph builder rely on.
function check(flow: Flow): string[] {
  const problems: string[] = [];
  const nodes = new Map(flow.data.nodes.map((n) => [n.id, n]));
  if (nodes.size !== flow.data.nodes.length) problems.push("duplicate node ids");
  for (const id of [...KEPT, TASK_MATCHER_ID]) if (!nodes.has(id)) problems.push(`node ${id} missing`);
  for (const e of flow.data.edges) {
    const s = nodes.get(e.source);
    const t = nodes.get(e.target);
    const sh = e.data.sourceHandle;
    const th = e.data.targetHandle;
    if (!s || !t) {
      problems.push(`edge ${e.source} -> ${e.target}: node missing`);
      continue;
    }
    const out = s.data.node.outputs.find((o) => o.name === sh.name);
    const field = t.data.node.template[th.fieldName as string];
    if (!out) problems.push(`edge from ${e.source}: no output ${sh.name}`);
    if (!field) problems.push(`edge to ${e.target}: no field ${th.fieldName}`);
    if (sh.id !== e.source || th.id !== e.target || sh.dataType !== s.data.type) problems.push(`edge ${e.source} -> ${e.target}: handle ids or type differ`);
    const outTypes = (sh.output_types as string[]) ?? [];
    const inTypes = (th.inputTypes as string[]) ?? [];
    if (!outTypes.some((x) => inTypes.includes(x))) problems.push(`edge ${e.source}.${sh.name} -> ${e.target}.${th.fieldName}: no common type`);
  }
  // Every node feeds the Chat Output, and the graph has no cycle.
  const into = new Map<string, string[]>();
  for (const e of flow.data.edges) into.set(e.target, [...(into.get(e.target) ?? []), e.source]);
  const reached = new Set<string>();
  const walk = (id: string, path: string[]) => {
    if (path.includes(id)) return problems.push(`cycle through ${id}`);
    reached.add(id);
    for (const src of into.get(id) ?? []) walk(src, [...path, id]);
  };
  walk(CHAT_OUTPUT_ID, []);
  for (const id of nodes.keys()) if (!reached.has(id)) problems.push(`node ${id} does not reach the Chat Output`);

  const llm = nodes.get(LLM_NODE_ID)?.data.node.template;
  const model = (llm?.model?.value as { name?: string }[] | undefined)?.[0]?.name;
  if (model !== "mistralai/mistral-small-3-1-24b-instruct-2503") problems.push(`LLM model ${model}`);
  if (llm?.base_url_ibm_watsonx?.value !== "https://jp-tok.ml.cloud.ibm.com") problems.push("LLM region is not Tokyo");
  if (nodes.get(KNOWLEDGE_NODE_ID)?.data.node.template.knowledge_base?.value !== RENCANA_KNOWLEDGE_BASE) problems.push("knowledge base is not v4");
  const code = nodes.get(TASK_MATCHER_ID)?.data.node.template.code?.value;
  if (code !== readFileSync(COMPONENT, "utf8")) problems.push("Task Matcher code differs from komponen/task_matcher.py");
  const promptText = nodes.get(PROMPT_ID)?.data.node.template.template?.value as string | undefined;
  if (promptText !== readFileSync(PROMPT, "utf8").replace(/\r?\n$/, "")) problems.push("prompt differs from prompt-rencana_kerja.txt");
  const variables = [...(promptText ?? "").matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]);
  if (variables.join() !== "context") problems.push(`prompt variables: ${variables.join(", ")} (only context expected)`);
  if (KEY_PATTERN.test(JSON.stringify(flow))) problems.push("a string shaped like an API key");
  return problems;
}

const mode = process.argv.find((a) => ["--tulis", "--cek", "--unggah"].includes(a));
if (!mode) {
  console.error("Usage: node langflow-flows/buat-rencana.mts --tulis | --cek | --unggah [--ganti]");
  process.exitCode = 1;
} else if (mode === "--tulis") {
  const flow = build();
  const problems = check(flow);
  if (problems.length > 0) {
    console.error(`Tidak ditulis, ${problems.length} masalah:\n  ${problems.join("\n  ")}`);
    process.exitCode = 1;
  } else {
    writeFileSync(OUT, JSON.stringify(flow, null, 2) + "\n");
    console.log(`Tersimpan: langflow-flows/rencana_kerja.json (${flow.data.nodes.length} node, ${flow.data.edges.length} edge, id ${FLOW_ID})`);
  }
} else if (mode === "--cek") {
  const file = JSON.parse(readFileSync(OUT, "utf8")) as Flow;
  const problems = check(file);
  const { diffs, compared } = diffFlows(file, build());
  for (const d of diffs) problems.push(`beda dari build baru: ${d.path}\n    file:  ${describeValue(d.path, d.live)}\n    build: ${describeValue(d.path, d.ekspor)}`);
  console.log(problems.length === 0 ? `rencana_kerja.json: cocok dengan build baru (${compared} nilai), struktur lolos` : `rencana_kerja.json: ${problems.length} masalah\n  ${problems.join("\n  ")}`);
  process.exitCode = problems.length === 0 ? 0 : 1;
} else {
  // Talks to Langflow (no LLM). Written for the user to run with Langflow started (NOTES R-02); never run by an agent
  // without permission.
  const envPath = here("../.env");
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const base = (process.env.LANGFLOW_URL || "http://127.0.0.1:7860").replace(/\/+$/, "");
  const file = JSON.parse(readFileSync(OUT, "utf8")) as Flow;
  const problems = check(file);
  if (problems.length > 0) {
    console.error(`Tidak diunggah: ${problems.join("; ")}. Jalankan --tulis dulu.`);
    process.exitCode = 1;
  } else {
    const { access_token } = await (await fetch(`${base}/api/v1/auto_login`)).json();
    const auth = { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" };
    const kb = await fetch(`${base}/api/v1/knowledge_bases/${RENCANA_KNOWLEDGE_BASE}`, { headers: auth });
    const kbStatus = kb.ok ? ((await kb.json()) as { status?: string }).status : `HTTP ${kb.status}`;
    if (kbStatus !== "ready") console.log(`Peringatan: knowledge base ${RENCANA_KNOWLEDGE_BASE} ${kbStatus}; bangun dulu dengan buat-kb.mjs.`);
    const existing = await fetch(`${base}/api/v1/flows/${FLOW_ID}`, { headers: auth });
    if (existing.ok && !process.argv.includes("--ganti")) {
      console.log(`rencana_kerja (${FLOW_ID}) sudah ada di Langflow; tidak diubah. Untuk menimpanya: --unggah --ganti.`);
    } else {
      const { id: _id, ...body } = file;
      const put = await fetch(`${base}/api/v1/flows/${FLOW_ID}`, { method: "PUT", headers: auth, body: JSON.stringify(body) });
      if (!put.ok) {
        console.error(`PUT /api/v1/flows/${FLOW_ID}: HTTP ${put.status} ${(await put.text()).slice(0, 300)}`);
        process.exitCode = 1;
      } else {
        const back = await (await fetch(`${base}/api/v1/flows/${FLOW_ID}`, { headers: auth })).json();
        const { diffs, compared } = diffFlows(exportedPart(back).part, file);
        console.log(`rencana_kerja: PUT ${put.status}, dibaca balik ${diffs.length} dari ${compared} nilai beda dari rencana_kerja.json`);
        for (const d of diffs.slice(0, 20)) console.log(`  ${d.path}\n    live: ${describeValue(d.path, d.live)}\n    file: ${describeValue(d.path, d.ekspor)}`);
        console.log(`Berikutnya: LANGFLOW_RENCANA_FLOW_ID=${FLOW_ID} di equilibre/.env, lalu cek-flow.mjs --penuh.`);
        if (diffs.length > 0) process.exitCode = 1;
      }
    }
  }
}
