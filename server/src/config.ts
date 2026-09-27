import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// .env lives at the repo root (equilibre/.env) and is never committed.
const envPath = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

export const config = {
  port: Number(process.env.PORT) || 8787,
  langflowUrl: (process.env.LANGFLOW_URL || "http://127.0.0.1:7860").replace(/\/+$/, ""),
  langflowApiKey: process.env.LANGFLOW_API_KEY ?? "",
  langflowFlowId: process.env.LANGFLOW_FLOW_ID ?? "",
  langflowTimeoutMs: 30_000,
  // IBM Bob (jalur B): key for headless runs (G-10), the isolated workspace next to equilibre/, and
  // bob.js from the global npm install (G-14).
  bobApiKey: process.env.BOB_API_KEY ?? "",
  bobWorkspace: process.env.BOB_WORKSPACE || fileURLToPath(new URL("../../../bob-workspace", import.meta.url)),
  bobJs: process.env.BOB_JS || `${process.env.APPDATA ?? ""}/npm/node_modules/bobshell/dist/bob.js`,
};
