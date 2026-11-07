import { FALLBACK_MODEL, LLM_NODE_ID } from "./analyze.ts";

// The advice card names the model that answered (plan P20 W0.5). The primary model is whatever
// langflow-flows/ganti-model.mts last wrote into the flow's LLM node (watsonx Tokyo since NOTES D-80,
// Gemini during D-76), so it is read from the flow itself rather than from a constant that would go
// stale. Reading a flow is a plain GET with no LLM call (NOTES D-19). The fallback model is fixed in
// analyze.ts. No config import here: web tests import this file (no node:* modules, HANDOFF 1 Nov §5b).

type Field = { value?: unknown } | undefined;
export type Template = Record<string, Field>;

const PROVIDERS: Record<string, string> = { "IBM WatsonX": "IBM watsonx", "IBM watsonx.ai": "IBM watsonx" };
const MODELS: Record<string, string> = {
  "mistral-small-3-1-24b-instruct-2503": "Mistral Small 3.1",
  "granite-4-h-small": "Granite 4.0 H Small",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
};
const REGIONS: Record<string, string> = {
  "jp-tok": "Tokyo",
  "us-south": "Dallas",
  "eu-de": "Frankfurt",
  "eu-gb": "London",
  "au-syd": "Sydney",
  "ca-tor": "Toronto",
};

const shortModel = (name: string) => {
  const id = name.split("/").at(-1) ?? name;
  return MODELS[id] ?? id;
};

export const FALLBACK_LABEL = shortModel(FALLBACK_MODEL.name);

/** "IBM watsonx · Mistral Small 3.1 (Tokyo)", "Gemini 2.5 Flash", or null when the node names no model. */
export function modelLabel(template: Template | undefined): string | null {
  const entries = template?.model?.value;
  const entry = Array.isArray(entries) ? (entries[0] as { name?: unknown; provider?: unknown } | undefined) : undefined;
  if (!entry || typeof entry.name !== "string" || entry.name === "") return null;
  const model = shortModel(entry.name);
  const provider = typeof entry.provider === "string" ? PROVIDERS[entry.provider] : undefined;
  if (!provider) return model; // Gemini and others: the model name says enough
  const base = template?.base_url_ibm_watsonx?.value;
  const code = typeof base === "string" ? /^https:\/\/([a-z]+-[a-z]+)\.ml\.cloud\.ibm\.com/.exec(base)?.[1] : undefined;
  const region = code ? (REGIONS[code] ?? code) : null;
  return `${provider} · ${model}${region ? ` (${region})` : ""}`;
}

export type FlowSource = { url: string; apiKey: string; flowId: string };
type FetchFn = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

const TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; label: string }>();

/**
 * The primary model's label, read from the flow's LLM node and kept for 5 minutes. A failed read gives
 * null (the card then shows no model line) and is not cached, so the next request tries again.
 */
export async function readPrimaryModel(src: FlowSource, fetchFn: FetchFn = fetch, now = Date.now()): Promise<string | null> {
  const key = `${src.url}|${src.flowId}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.label;
  try {
    const res = await fetchFn(`${src.url}/api/v1/flows/${encodeURIComponent(src.flowId)}`, {
      headers: { "x-api-key": src.apiKey },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const flow = (await res.json()) as { data?: { nodes?: { id?: string; data?: { node?: { template?: Template } } }[] } };
    const node = flow.data?.nodes?.find((n) => n.id === LLM_NODE_ID);
    const label = modelLabel(node?.data?.node?.template);
    if (label) cache.set(key, { at: now, label });
    return label;
  } catch {
    return null;
  }
}

/** Test hook: forget cached labels. */
export function clearModelCache(): void {
  cache.clear();
}
