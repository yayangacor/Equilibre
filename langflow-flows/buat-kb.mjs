// Creates the knowledge base for the Gemini setup (NOTES D-76): the notes in knowledge/ (README
// excluded), one chunk per note as in v2 (chunk 2400, overlap 0, NOTES D-39), vectors from Google
// gemini-embedding-001 with the Langflow Global Variable GOOGLE_API_KEY. The split is checked first
// with preview-chunks, which stores nothing, and the run stops if a note would become more than one
// chunk. Ingest embeds the notes (embedding calls, no LLM). An existing knowledge base is never
// changed. The knowledge base endpoints are not in openapi.json; request shapes are from the Langflow
// 1.12.2 source (NOTES G-40). Search quality afterwards: cek-retrieval.mts.
// Usage (from equilibre/): node langflow-flows/buat-kb.mjs [--pratinjau]
//   --pratinjau  only previews the split, creates nothing
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);
const base = (process.env.LANGFLOW_URL || "http://127.0.0.1:7860").replace(/\/+$/, "");
const previewOnly = process.argv.includes("--pratinjau");
// Same name as PROFILES.gemini.knowledgeBase in profil.mts.
const KB = "equilibre_panduan_v3";
const EMBEDDING = { provider: "Google Generative AI", model: "models/gemini-embedding-001" };
// An empty separator keeps the splitter's default separators, as for v2 (separator null).
const SPLIT = { chunk_size: "2400", chunk_overlap: "0", separator: "" };
const V2 = { chunks: 9, words: 1844, characters: 13843 }; // GET /api/v1/knowledge_bases/equilibre_panduan_v2, 26 Sep
const READY_TIMEOUT_MS = 120_000;

const dir = new URL("../knowledge/", import.meta.url);
const notes = readdirSync(dir)
  .filter((f) => f.endsWith(".md") && f !== "README.md")
  .sort()
  .map((name) => ({ name, text: readFileSync(new URL(name, dir), "utf8") }));

function form(fields) {
  const body = new FormData();
  for (const n of notes) body.append("files", new Blob([n.text], { type: "text/markdown" }), n.name);
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return body;
}

const { access_token } = await (await fetch(`${base}/api/v1/auto_login`)).json();
const auth = { Authorization: `Bearer ${access_token}` };
const kbUrl = `${base}/api/v1/knowledge_bases`;

async function fail(step, res) {
  console.error(`${step}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  process.exitCode = 1;
}

async function run() {
  const preview = await fetch(`${kbUrl}/preview-chunks`, { method: "POST", headers: auth, body: form({ ...SPLIT, max_chunks: "5" }) });
  if (!preview.ok) return fail("preview-chunks", preview);
  let split = 0;
  for (const f of (await preview.json()).files) {
    const sizes = f.preview_chunks.map((c) => c.char_count).join(" + ");
    console.log(`  ${f.file_name.padEnd(38)} ${f.total_chunks} chunk (${sizes} karakter)`);
    if (f.total_chunks !== 1) split++;
  }
  // The splitter strips whitespace around each chunk, so the trimmed length is what Langflow counts.
  const characters = notes.reduce((n, x) => n + x.text.trim().length, 0);
  console.log(`${notes.length} catatan, ${characters} karakter tanpa spasi tepi (v2: ${V2.chunks} chunk, ${V2.characters} karakter)`);
  if (split > 0) {
    console.error(`${split} catatan menjadi lebih dari 1 chunk: naikkan chunk_size atau pecah catatannya dulu.`);
    process.exitCode = 1;
    return;
  }
  if (previewOnly) return;

  // Creating a knowledge base does not check the provider key; without it only the ingest fails and
  // leaves a failed knowledge base under this name. Only names and has_value are read, never values.
  const variables = await fetch(`${base}/api/v1/variables/`, { headers: auth });
  if (!variables.ok) return fail("variables", variables);
  if (!(await variables.json()).some((v) => v.name === "GOOGLE_API_KEY" && v.has_value)) {
    console.error("GOOGLE_API_KEY belum ada di Langflow: Settings → Global Variables → Add, tipe Credential.");
    process.exitCode = 1;
    return;
  }

  const existing = await fetch(`${kbUrl}/${KB}`, { headers: auth });
  if (existing.ok) {
    const info = await existing.json();
    console.log(`${KB} sudah ada (${info.status}, ${info.chunks} chunk, ${info.embedding_model}); tidak diubah.`);
    if (info.status === "failed") {
      console.log(`Gagal sebelumnya: ${info.failure_reason}. Hapus dulu (Langflow → Knowledge) lalu jalankan lagi.`);
      process.exitCode = 1;
    }
    return;
  }
  const created = await fetch(kbUrl, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ name: KB, embedding_provider: EMBEDDING.provider, embedding_model: EMBEDDING.model }),
  });
  if (created.status !== 201) return fail("buat knowledge base", created);
  console.log(`${KB} dibuat (${EMBEDDING.model})`);

  const ingest = await fetch(`${kbUrl}/${KB}/ingest`, { method: "POST", headers: auth, body: form(SPLIT) });
  if (!ingest.ok) return fail("ingest", ingest);
  console.log(`ingest berjalan (job ${(await ingest.json()).id})`);

  const deadline = Date.now() + READY_TIMEOUT_MS;
  let info;
  do {
    await new Promise((r) => setTimeout(r, 2_000));
    info = await (await fetch(`${kbUrl}/${KB}`, { headers: auth })).json();
  } while (["creating", "ingesting", "empty"].includes(info.status) && Date.now() < deadline);
  console.log(`${KB}: ${info.status}, ${info.chunks} chunk, ${info.words} kata, ${info.characters} karakter${info.failure_reason ? `, ${info.failure_reason}` : ""}`);
  if (info.status !== "ready") {
    process.exitCode = 1;
    return;
  }

  // Read back what was stored, not what was sent: one chunk per note, every note present.
  const { chunks } = await (await fetch(`${kbUrl}/${KB}/chunks?limit=50`, { headers: auth })).json();
  const perFile = new Map();
  for (const c of chunks) perFile.set(c.metadata?.file_name, (perFile.get(c.metadata?.file_name) ?? 0) + 1);
  const missing = notes.filter((n) => perFile.get(n.name) !== 1).map((n) => n.name);
  console.log(`dibaca balik: ${chunks.length} chunk dari ${perFile.size} file${missing.length ? `; tidak tepat 1 chunk: ${missing.join(", ")}` : ", tiap catatan 1 chunk"}`);
  if (missing.length > 0 || chunks.length !== notes.length) process.exitCode = 1;
}

await run();
