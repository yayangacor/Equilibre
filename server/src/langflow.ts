import { config } from "./config.ts";
import { LangflowError } from "./reply.ts";

type RunResponse = {
  outputs?: { outputs?: { results?: { message?: { text?: unknown } } }[] }[];
};

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
      throw new LangflowError(`Langflow tidak menjawab dalam ${config.langflowTimeoutMs / 1000} detik.`, 504, true);
    }
    throw new LangflowError(`Tidak bisa menghubungi Langflow di ${config.langflowUrl}. Pastikan Langflow sudah jalan.`, 502);
  }

  if (res.status === 401 || res.status === 403) {
    throw new LangflowError("Langflow menolak API key. Cek LANGFLOW_API_KEY di .env.", 502);
  }
  if (res.status === 404) {
    throw new LangflowError("Flow tidak ditemukan di Langflow. Cek LANGFLOW_FLOW_ID di .env.", 502);
  }
  if (!res.ok) {
    console.error(`[langflow] HTTP ${res.status}:`, (await res.text()).slice(0, 1000));
    // 5xx = a component failed, usually the LLM (e.g. 429 upstream, quota). 4xx = the request itself.
    throw new LangflowError(`Langflow mengembalikan error (HTTP ${res.status}).`, 502, res.status >= 500);
  }

  const data = (await res.json()) as RunResponse;
  const text = data.outputs?.[0]?.outputs?.[0]?.results?.message?.text;
  if (typeof text !== "string" || text.trim() === "") {
    console.error("[langflow] unexpected response:", JSON.stringify(data).slice(0, 2000));
    throw new LangflowError("Jawaban Langflow kosong atau formatnya tidak dikenali.", 502, true);
  }
  return text;
}
