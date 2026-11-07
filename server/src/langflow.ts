import { config } from "./config.ts";
import { LangflowError } from "./reply.ts";

type RunResponse = {
  outputs?: { outputs?: { results?: { message?: { text?: unknown } } }[] }[];
};

/** Whether Langflow answers GET /health within 3 s. */
export async function langflowUp(): Promise<boolean> {
  try {
    const res = await fetch(`${config.langflowUrl}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Throws when Langflow does not answer GET /health. Checked before a Bob run: without Langflow, Bob
 * starts with no MCP tools, writes tool calls as text and makes up an answer (NOTES G-48).
 */
export async function assertLangflowUp(): Promise<void> {
  if (await langflowUp()) return;
  throw new LangflowError(
    `Langflow is not running at ${config.langflowUrl}, so Bob has no flow to call. Start Langflow and try again.`,
    503,
  );
}

/**
 * Runs a chat flow via POST /api/v1/run/{flowId} and returns the Chat Output text.
 * `tweaks` override node fields for this run only, keyed by node id.
 */
export async function runFlow(
  flowId: string,
  inputValue: string,
  tweaks?: Record<string, Record<string, unknown>>,
): Promise<string> {
  const url = `${config.langflowUrl}/api/v1/run/${encodeURIComponent(flowId)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": config.langflowApiKey },
      body: JSON.stringify({ input_value: inputValue, input_type: "chat", output_type: "chat", ...(tweaks && { tweaks }) }),
      signal: AbortSignal.timeout(config.langflowTimeoutMs),
    });
  } catch (err) {
    if ((err as Error).name === "TimeoutError") {
      throw new LangflowError(`Langflow did not answer within ${config.langflowTimeoutMs / 1000} s.`, 504, true);
    }
    throw new LangflowError(`Cannot reach Langflow at ${config.langflowUrl}. Make sure Langflow is running.`, 502);
  }

  if (res.status === 401 || res.status === 403) {
    throw new LangflowError("Langflow rejected the API key. Check LANGFLOW_API_KEY in .env.", 502);
  }
  if (res.status === 404) {
    throw new LangflowError("Langflow has no flow with this ID. Check LANGFLOW_FLOW_ID (advice) or LANGFLOW_RENCANA_FLOW_ID (plan) in .env.", 502);
  }
  if (!res.ok) {
    console.error(`[langflow] HTTP ${res.status}:`, (await res.text()).slice(0, 1000));
    // 5xx = a component failed, usually the LLM (e.g. 429 upstream, quota). 4xx = the request itself.
    throw new LangflowError(`Langflow returned an error (HTTP ${res.status}).`, 502, res.status >= 500);
  }

  const data = (await res.json()) as RunResponse;
  const text = data.outputs?.[0]?.outputs?.[0]?.results?.message?.text;
  if (typeof text !== "string" || text.trim() === "") {
    console.error("[langflow] unexpected response:", JSON.stringify(data).slice(0, 2000));
    throw new LangflowError("Langflow's answer was empty or in an unknown format.", 502, true);
  }
  return text;
}
