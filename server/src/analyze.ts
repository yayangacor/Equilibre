import { panduanTweaks, type FlowInput } from "./features.ts";
import { LangflowError, parseJsonReply } from "./reply.ts";

// The flow's LLM node runs the primary model: Mistral Small 3.1 on watsonx (NOTES D-11, D-40); Dallas
// until the IBM Cloud trial ended on 26 Oct, Tokyo on the new account from 1 Nov (NOTES D-80). Gemini
// 2.5 Flash ran it from 28 Oct while no IBM account was left (NOTES D-76). Both setups are in
// langflow-flows/profil.mts. When that call fails or its reply cannot be read, the same flow runs once
// more with the node switched to the fallback model, Gemini 2.5 Flash (user, 1 Nov; Qwen3.8 Flash on
// OpenRouter before, user 26 Sep). Gemini thinks before it answers and the thinking counts against
// max_tokens, so the fallback gets the larger cap of its setup (NOTES G-84).
// Prompt and knowledge base stay the same for both, and the second call only happens after
// a failure, so a normal request still costs one LLM call.
export const LLM_NODE_ID = "LanguageModelComponent-FLeYF";
export const FALLBACK_MODEL = {
  name: "gemini-2.5-flash",
  provider: "Google Generative AI",
  category: "Google Generative AI",
  icon: "GoogleGenerativeAI",
  metadata: {
    icon: "GoogleGenerativeAI",
    tool_calling: true,
    reasoning: false,
    search: false,
    preview: false,
    not_supported: false,
    deprecated: false,
    default: false,
    model_type: "llm",
    created: 0,
  },
};
export const FALLBACK_MAX_TOKENS = 4096;

export type Tweaks = Record<string, Record<string, unknown>>;
export type RunFlow = (inputValue: string, tweaks: Tweaks) => Promise<string>;

export type Analysis = {
  text: string;
  result: Record<string, unknown> | null;
  cadangan: boolean; // answered by the fallback model
};

// Status and break length are the server's, whatever the LLM wrote.
function toResult(text: string, input: FlowInput): Record<string, unknown> | null {
  const reply = parseJsonReply(text);
  return reply !== null && typeof reply === "object" && !Array.isArray(reply)
    ? { ...reply, status: input.status, durasi_jeda_menit: input.durasi_jeda_menit }
    : null;
}

export async function analyze(input: FlowInput, run: RunFlow): Promise<Analysis> {
  const inputValue = JSON.stringify(input);
  const tweaks = panduanTweaks(input.status);
  try {
    const text = await run(inputValue, tweaks);
    const result = toResult(text, input);
    if (result) return { text, result, cadangan: false };
    console.warn("[analyze] primary reply is not JSON, trying the fallback model");
  } catch (err) {
    if (!(err instanceof LangflowError) || !err.retryable) throw err;
    console.warn(`[analyze] primary model failed (${err.message}), trying the fallback model`);
  }
  const text = await run(inputValue, { ...tweaks, [LLM_NODE_ID]: { model: [FALLBACK_MODEL], max_tokens: FALLBACK_MAX_TOKENS } });
  return { text, result: toResult(text, input), cadangan: true };
}
