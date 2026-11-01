// NOTES D-80: one run of analisis_status with exactly the tweak the server sends when the primary model
// fails (analyze.ts: FALLBACK_MODEL + FALLBACK_MAX_TOKENS, knowledge base query of the status), to show
// that the Gemini model picked by a tweak finds its key in Langflow. One LLM call, so nothing is sent
// without --jalankan (NOTES D-19). Prints the reply and whether it parses, never a key.
// Usage (from equilibre/): node langflow-flows/uji-cadangan.mts [--jalankan]
import { FALLBACK_MAX_TOKENS, FALLBACK_MODEL, LLM_NODE_ID } from "../server/src/analyze.ts";
import { config } from "../server/src/config.ts";
import { panduanTweaks, parseFeatures, toFlowInput } from "../server/src/features.ts";
import { runFlow } from "../server/src/langflow.ts";
import { parseJsonReply } from "../server/src/reply.ts";

const parsed = parseFeatures({ label: "tertidur", perclos: 0.8 });
if (!parsed.ok) throw new Error(parsed.error);
const input = toFlowInput(parsed.value)!;
const tweaks = {
  ...panduanTweaks(input.status),
  [LLM_NODE_ID]: { model: [FALLBACK_MODEL], max_tokens: FALLBACK_MAX_TOKENS },
};
console.log(`flow ${config.langflowFlowId ? "ada" : "KOSONG"}, model tweak: ${FALLBACK_MODEL.name}, max_tokens ${FALLBACK_MAX_TOKENS}`);
console.log("input:", JSON.stringify(input));
if (!process.argv.includes("--jalankan")) {
  console.log("Tanpa --jalankan: tidak ada panggilan.");
  process.exit(0);
}
const t0 = Date.now();
const text = await runFlow(config.langflowFlowId, JSON.stringify(input), tweaks);
console.log(`dijawab dalam ${((Date.now() - t0) / 1000).toFixed(1)} dtk, ${text.length} karakter, JSON: ${parseJsonReply(text) !== null}`);
console.log(text.slice(0, 600));
