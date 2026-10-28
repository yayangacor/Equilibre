// Which notes the Knowledge node returns for one knowledge base, through a partial build of
// analisis_status that stops at the Knowledge node (NOTES G-40): no LLM, one embedding call per query.
// Queries: the 5 per status that the server sends (PANDUAN_QUERIES), 3 questions like the ones Bob
// passes to cari_panduan, and an off-topic control. Compared with v2, whose top 3 per status are taken
// from the 19-scenario run of 26 Sep (NOTES D-39); v2 itself cannot be searched any more without a
// watsonx key (G-81). The flow is not changed: the build gets the edited flow data in memory only.
// Scores are -distance and only comparable within one knowledge base.
// Usage (from equilibre/): node langflow-flows/cek-retrieval.mts [--kb=equilibre_panduan_v3]
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KNOWLEDGE_NODE_ID, PANDUAN_QUERIES, PANDUAN_TOP_K, type Status } from "../server/src/features.ts";
import { PROFILES } from "./profil.mts";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);
const base = (process.env.LANGFLOW_URL || "http://127.0.0.1:7860").replace(/\/+$/, "");
const kbArg = process.argv.find((a) => a.startsWith("--kb="));
const kb = kbArg ? kbArg.slice("--kb=".length) : PROFILES.gemini.knowledgeBase;
const TIMEOUT_MS = 60_000;
const PAUSE_MS = 1_000;

// Run with every status retrieved from v2 (prompt c4b7ffee64b8, contexts of 3 notes).
const V2_RUN = "mistral-20260926-121240.json";
// P05 step 2 checked these on the first knowledge base; only the start of the 2nd and 3rd question
// was written down, so their wording here is reconstructed. Expected: the note at the top.
const QUESTIONS = [
  { query: "kenapa harus istirahat mata", top: "aao-20-20-20.md" },
  { query: "saya mengantuk saat bekerja, apa yang bisa saya lakukan supaya segar", top: "niosh-kewaspadaan-kerja.md" },
  { query: "berapa banyak air yang perlu saya minum setiap hari", top: "eu-432-2012-air-minum.md" },
];
// Negative control: off-topic, so its best score should be worse than the best score of every query
// above (retrieval still returns top_k notes; refusing is the prompt's job).
const CONTROL = "resep rendang";

type Row = { file: string | null; score: number | null };
type Field = { value?: unknown; options?: unknown[] };
type Node = { id: string; data: { node: { template: Record<string, Field> } } };
type Flow = { id: string; data: { nodes: Node[]; edges: unknown[]; viewport?: unknown } };
type Transaction = { id: string; vertex_id: string; status: string; outputs?: Record<string, unknown> };

const v2 = new Map<string, string[]>();
const recorded = JSON.parse(readFileSync(new URL(`./hasil-uji/${V2_RUN}`, import.meta.url), "utf8")) as {
  hasil: { status: string; konteks: { file: string }[] }[];
};
for (const r of recorded.hasil) if (!v2.has(r.status) && r.konteks.length > 0) v2.set(r.status, r.konteks.map((k) => k.file));

const { access_token } = await (await fetch(`${base}/api/v1/auto_login`)).json();
const auth = { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" };
const { id: flowId } = JSON.parse(readFileSync(new URL("./analisis_status.json", import.meta.url), "utf8")) as { id: string };
const live = (await (await fetch(`${base}/api/v1/flows/${flowId}`, { headers: auth })).json()) as Flow;
const info = await fetch(`${base}/api/v1/knowledge_bases/${kb}`, { headers: auth });
const kbInfo = info.ok ? ((await info.json()) as { status: string; chunks: number; embedding_model: string }) : null;
console.log(kbInfo ? `${kb}: ${kbInfo.status}, ${kbInfo.chunks} chunk, ${kbInfo.embedding_model}, top_k ${PANDUAN_TOP_K}` : `Knowledge base ${kb} tidak ada (HTTP ${info.status}). Buat dulu dengan buat-kb.mjs.`);

async function transactions(): Promise<Transaction[]> {
  const res = await fetch(`${base}/api/v1/monitor/transactions?flow_id=${flowId}&page=1&size=20`, { headers: auth });
  return ((await res.json()) as { items: Transaction[] }).items;
}

async function retrieve(query: string): Promise<Row[]> {
  const data = structuredClone(live.data);
  const t = data.nodes.find((n) => n.id === KNOWLEDGE_NODE_ID)?.data.node.template;
  if (!t?.knowledge_base || !t.search_query || !t.top_k) throw new Error(`node ${KNOWLEDGE_NODE_ID} tidak lengkap`);
  t.knowledge_base.value = kb;
  if (!(t.knowledge_base.options ?? []).includes(kb)) t.knowledge_base.options = [...(t.knowledge_base.options ?? []), kb];
  t.search_query.value = query;
  t.top_k.value = PANDUAN_TOP_K;
  const seen = new Set((await transactions()).map((x) => x.id));
  const build = await fetch(`${base}/api/v1/build/${flowId}/flow?stop_component_id=${KNOWLEDGE_NODE_ID}`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ data }),
  });
  if (!build.ok) throw new Error(`build: HTTP ${build.status} ${(await build.text()).slice(0, 300)}`);
  const { job_id } = (await build.json()) as { job_id: string };
  // The event stream (one JSON object per line) closes when the build ends.
  const res = await fetch(`${base}/api/v1/build/${job_id}/events`, { headers: auth, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const events = await res.text();
  if (!res.ok) throw new Error(`events: HTTP ${res.status} ${events.slice(0, 300)}`);
  const error = events
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { event: string; data?: { error?: unknown } })
    .find((e) => e.event === "error");
  if (error) throw new Error(`build gagal: ${JSON.stringify(error.data).slice(0, 300)}`);
  const knowledge = (await transactions()).find((x) => !seen.has(x.id) && x.vertex_id === KNOWLEDGE_NODE_ID);
  if (!knowledge) throw new Error("transaksi node Knowledge tidak ditemukan");
  if (knowledge.status !== "success") throw new Error(`node Knowledge: ${knowledge.status}`);
  const rows = ((knowledge.outputs?.retrieve_data as { message?: unknown } | undefined)?.message ?? []) as {
    file_name?: string;
    _score?: number;
  }[];
  return Array.isArray(rows) ? rows.map((r) => ({ file: r.file_name ?? null, score: r._score ?? null })) : [];
}

const short = (f: string | null) => (f ?? "?").replace(/\.md$/, "");
const fmt = (rows: Row[]) => rows.map((r) => `${short(r.file)} ${r.score?.toFixed(3) ?? "tanpa skor"}`).join(", ");
const pause = () => new Promise((r) => setTimeout(r, PAUSE_MS));

let problems = 0;
const bestRelevant: number[] = [];

async function relevant(query: string): Promise<Row[]> {
  const rows = await retrieve(query);
  if (rows.length !== PANDUAN_TOP_K || rows.some((r) => r.score === null)) problems++;
  if (rows[0]?.score != null) bestRelevant.push(rows[0].score);
  await pause();
  return rows;
}

async function compare() {
  for (const [status, query] of Object.entries(PANDUAN_QUERIES) as [Status, string][]) {
    const rows = await relevant(query);
    const files = rows.map((r) => r.file);
    const before = v2.get(status) ?? [];
    const shared = before.filter((f) => files.includes(f)).length;
    const sameOrder = before.length === files.length && before.every((f, i) => f === files[i]);
    console.log(`${status.padEnd(24)} ${fmt(rows)}`);
    console.log(`${"".padEnd(24)} v2: ${before.map(short).join(", ")} | sama ${shared}/${before.length}${sameOrder ? ", urutan sama" : ""}`);
  }
  for (const q of QUESTIONS) {
    const rows = await relevant(q.query);
    console.log(`tanya "${q.query}"`);
    console.log(`${"".padEnd(24)} ${fmt(rows)} | harapan teratas ${short(q.top)}: ${rows[0]?.file === q.top ? "ya" : "TIDAK"}`);
  }
  const control = await retrieve(CONTROL);
  const controlBest = control[0]?.score ?? null;
  const worst = Math.min(...bestRelevant);
  const below = controlBest !== null && bestRelevant.length > 0 && controlBest < worst;
  console.log(`kontrol "${CONTROL}": ${fmt(control)}`);
  console.log(
    `${"".padEnd(24)} teratas ${controlBest?.toFixed(3)} vs teratas query relevan ${worst.toFixed(3)}..${Math.max(...bestRelevant).toFixed(3)}: ` +
      (below ? "lebih buruk dari semua (sesuai)" : "TIDAK lebih buruk dari semua"),
  );
  if (problems > 0) console.log(`${problems} query tidak mengembalikan ${PANDUAN_TOP_K} catatan berskor.`);
}

// A failed build (missing or wrong GOOGLE_API_KEY, quota) stops the run: the next query would fail the same way.
// process.exit() with fetch handles still open aborts Node on Windows (UV_HANDLE_CLOSING), so set exitCode.
if (!kbInfo) problems++;
else {
  try {
    await compare();
  } catch (err) {
    console.error(`Berhenti: ${(err as Error).message}`);
    problems++;
  }
}
process.exitCode = problems > 0 ? 1 : 0;
