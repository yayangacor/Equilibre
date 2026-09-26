import { panduanTweaks, type FlowInput } from "./features.ts";
import { LangflowError, parseJsonReply } from "./reply.ts";

// The flow's LLM node runs the primary model (Mistral Small 3.1 on watsonx). When that call
// fails or its reply cannot be read, the same flow runs once more with the node switched to
// the fallback model (Qwen3.8 Flash on OpenRouter). User decision 26 Sep (NOTES D-11).
// Prompt and knowledge base stay the same for both, and the second call only happens after
// a failure, so a normal request still costs one LLM call.
export const LLM_NODE_ID = "LanguageModelComponent-FLeYF";
export const FALLBACK_MODEL = {
  name: "qwen/qwen3.8-flash",
  provider: "OpenAI Compatible",
  category: "OpenAI Compatible",
  icon: "Plug",
  metadata: {
    icon: "Plug",
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
  const text = await run(inputValue, { ...tweaks, [LLM_NODE_ID]: { model: [FALLBACK_MODEL] } });
  return { text, result: toResult(text, input), cadangan: true };
}
