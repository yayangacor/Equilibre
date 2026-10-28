// Export a Langflow flow to langflow-flows/<name>.json with secrets removed.
// Usage (from equilibre/): node langflow-flows/export.mjs [flowId]   (default: LANGFLOW_FLOW_ID)
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { exportedPart, KEY_PATTERN } from "./bentuk-ekspor.mjs";

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
const { part, blanked } = exportedPart(await res.json());
const json = JSON.stringify(part, null, 2);

// Last line of defence: a key outside a password field.
if (KEY_PATTERN.test(json)) {
  console.error("Ekspor dibatalkan: ditemukan string yang mirip API key. Periksa flow di Langflow.");
  // process.exit() with fetch handles still open aborts Node on Windows (UV_HANDLE_CLOSING), so set exitCode.
  process.exitCode = 1;
} else {
  writeFileSync(fileURLToPath(new URL(`./${part.name}.json`, import.meta.url)), json + "\n");
  console.log(`Tersimpan: langflow-flows/${part.name}.json (${blanked} field rahasia dikosongkan)`);
}
