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
  // The flow rencana_kerja behind /api/rencana (plan P20 W2.4): Task Matcher → knowledge base → LLM. Empty → 503.
  langflowRencanaFlowId: process.env.LANGFLOW_RENCANA_FLOW_ID ?? "",
  langflowTimeoutMs: 30_000,
  // IBM Bob (jalur B): key for headless runs (G-10), the isolated workspace next to equilibre/, and
  // bob.js from the global npm install (G-14).
  bobApiKey: process.env.BOB_API_KEY ?? "",
  bobWorkspace: process.env.BOB_WORKSPACE || fileURLToPath(new URL("../../../bob-workspace", import.meta.url)),
  bobJs: process.env.BOB_JS || `${process.env.APPDATA ?? ""}/npm/node_modules/bobshell/dist/bob.js`,
  // Online demo (NOTES D-80): a second listener for the tunnel, opened only when PROXY_SECRET is set.
  // The Vercel Function sends the same secret in a header; anything else reaching the tunnel is refused.
  publicPort: Number(process.env.PUBLIC_PORT) || 8788,
  proxySecret: process.env.PROXY_SECRET ?? "",
  // On the VPS (NOTES D-98): where the reverse SSH tunnel from the laptop ends. Set → /api/tanya is answered by the
  // laptop's server (forward.ts), not by a Bob on this machine. Empty on the laptop itself.
  askForwardUrl: (process.env.ASK_FORWARD_URL ?? "").trim().replace(/\/+$/, ""),
  // On the laptop: the VPS's SSH alias and the port the tunnel opens there (npm run ask-tunnel).
  vpsSshHost: process.env.VPS_SSH_HOST || "equilibre-vps",
  askTunnelPort: Number(process.env.ASK_TUNNEL_PORT) || 18788,
};
