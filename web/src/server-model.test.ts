import { beforeEach, describe, expect, it } from "vitest";
import { FALLBACK_MODEL, LLM_NODE_ID } from "../../server/src/analyze.ts";
import { clearModelCache, FALLBACK_LABEL, modelLabel, readPrimaryModel, type Template } from "../../server/src/model.ts";
import { PROFILES } from "../../langflow-flows/profil.mts";

// The LLM node fields as langflow-flows/ganti-model.mts writes them for a profile. A profile without a
// watsonx URL leaves the field as it was, so the Gemini case keeps a watsonx URL on purpose.
const template = (profile: keyof typeof PROFILES, watsonxUrl = PROFILES[profile].watsonxUrl ?? "https://jp-tok.ml.cloud.ibm.com"): Template => ({
  model: { value: [PROFILES[profile].model] },
  base_url_ibm_watsonx: { value: watsonxUrl },
});

const flow = (t: Template) => ({
  data: {
    nodes: [
      { id: "ChatInput-x", data: { node: { template: {} } } },
      { id: LLM_NODE_ID, data: { node: { template: t } } },
    ],
  },
});

function fetchReturning(status: number, body: unknown) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify(body), { status });
  };
  return { fn, calls };
}

describe("modelLabel", () => {
  it("names the watsonx profile with its region", () => {
    expect(modelLabel(template("watsonx"))).toBe("IBM watsonx · Mistral Small 3.1 (Tokyo)");
    expect(modelLabel(template("watsonx", "https://us-south.ml.cloud.ibm.com"))).toBe("IBM watsonx · Mistral Small 3.1 (Dallas)");
  });

  it("names the Gemini profile without a region, although the watsonx URL field is still filled", () => {
    expect(modelLabel(template("gemini"))).toBe("Gemini 2.5 Flash");
  });

  it("keeps an unknown model id as written, and gives null when the node names no model", () => {
    expect(modelLabel({ model: { value: [{ name: "ibm/some-new-model", provider: "IBM WatsonX" }] } })).toBe(
      "IBM watsonx · some-new-model",
    );
    expect(modelLabel({ model: { value: [] } })).toBeNull();
    expect(modelLabel(undefined)).toBeNull();
  });

  it("labels the fixed fallback model", () => {
    expect(FALLBACK_MODEL.name).toBe("gemini-2.5-flash");
    expect(FALLBACK_LABEL).toBe("Gemini 2.5 Flash");
  });
});

describe("readPrimaryModel", () => {
  const src = { url: "http://127.0.0.1:7860", apiKey: "k", flowId: "abc" };
  beforeEach(() => clearModelCache());

  it("reads the flow's LLM node and keeps the label for 5 minutes", async () => {
    const { fn, calls } = fetchReturning(200, flow(template("watsonx")));
    expect(await readPrimaryModel(src, fn, 0)).toBe("IBM watsonx · Mistral Small 3.1 (Tokyo)");
    expect(await readPrimaryModel(src, fn, 4 * 60_000)).toBe("IBM watsonx · Mistral Small 3.1 (Tokyo)");
    expect(calls).toEqual(["http://127.0.0.1:7860/api/v1/flows/abc"]);
    await readPrimaryModel(src, fn, 6 * 60_000); // expired: read again
    expect(calls).toHaveLength(2);
  });

  it("gives null without caching when the read fails, so the next request tries again", async () => {
    expect(await readPrimaryModel(src, fetchReturning(404, {}).fn, 0)).toBeNull();
    const down = async (): Promise<Response> => {
      throw new TypeError("fetch failed");
    };
    expect(await readPrimaryModel(src, down, 0)).toBeNull();
    expect(await readPrimaryModel(src, fetchReturning(200, flow(template("gemini"))).fn, 1)).toBe("Gemini 2.5 Flash");
  });
});
