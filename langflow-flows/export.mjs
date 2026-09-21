// Export a Langflow flow to langflow-flows/<name>.json with secrets removed.
// Usage (from equilibre/): node langflow-flows/export.mjs [flowId]   (default: LANGFLOW_FLOW_ID)
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

const baseUrl = (process.env.LANGFLOW_URL || "http://127.0.0.1:7860").replace(/\/+$/, "");
const flowId = process.argv[2] || process.env.LANGFLOW_FLOW_ID;
if (!flowId || !process.env.LANGFLOW_API_KEY) {
  console.error("Isi LANGFLOW_API_KEY dan LANGFLOW_FLOW_ID di .env (atau berikan flowId).");
  process.exit(1);
}

const res = await fetch(`${baseUrl}/api/v1/flows/${flowId}`, {
  headers: { "x-api-key": process.env.LANGFLOW_API_KEY },
});
if (!res.ok) {
  console.error(`Gagal mengambil flow: HTTP ${res.status}`);
  process.exit(1);
}
const flow = await res.json();

// Password fields either reference a Global Variable by name (load_from_db) or hold a raw
// secret. Keep the references, blank everything else.
let blanked = 0;
for (const node of flow.data?.nodes ?? []) {
  for (const field of Object.values(node.data?.node?.template ?? {})) {
    if (field && typeof field === "object" && field.password && !field.load_from_db && field.value) {
      field.value = "";
      blanked++;
    }
  }
}

const { id, name, description, data, endpoint_name, mcp_enabled, action_name, action_description } = flow;
const json = JSON.stringify(
  { id, name, description, endpoint_name, mcp_enabled, action_name, action_description, data },
  null,
  2,
);

// Last line of defence: Langflow keys (sk-...), OpenRouter keys (sk-or-...), bearer tokens.
const leak = json.match(/sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{20,}/);
if (leak) {
  console.error("Ekspor dibatalkan: ditemukan string yang mirip API key. Periksa flow di Langflow.");
  process.exit(1);
}

const outPath = fileURLToPath(new URL(`./${name}.json`, import.meta.url));
writeFileSync(outPath, json + "\n");
console.log(`Tersimpan: langflow-flows/${name}.json (${blanked} field rahasia dikosongkan)`);
