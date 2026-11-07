// Model setups of the three flows (NOTES D-76). watsonx ran them until the IBM Cloud trial ended on
// 26 Oct (G-81); Gemini (Google AI Studio key in the Langflow Global Variable GOOGLE_API_KEY) runs
// them while the IBM code is pending. ganti-model.mts switches the flows between the two setups and
// uji-llm.mts sends the model it tests. A model entry has the shape the Langflow 1.12.2 model picker
// stores in the Language Model node.
export type ModelSelection = {
  name: string;
  provider: string;
  category: string;
  icon: string;
  metadata: Record<string, unknown>;
};

function selection(name: string, provider: string, icon: string): ModelSelection {
  return {
    name,
    provider,
    category: provider,
    icon,
    metadata: {
      icon,
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
}

export const MODELS: Record<string, ModelSelection> = {
  // watsonx: Dallas until 26 Oct (NOTES D-39, D-40, G-41), Tokyo from 1 Nov (D-80)
  mistral: selection("mistralai/mistral-small-3-1-24b-instruct-2503", "IBM WatsonX", "IBM"),
  granite: selection("ibm/granite-4-h-small", "IBM WatsonX", "IBM"),
  // Google AI Studio (NOTES D-76)
  gemini: selection("gemini-2.5-flash", "Google Generative AI", "GoogleGenerativeAI"),
};

// v3 holds the 9 notes with Gemini vectors (GOOGLE_API_KEY), so search needs the Google key in both setups.
// gemini-2.5-flash thinks before it answers and the thinking counts against max_output_tokens, so at
// 512 the reply can come back empty (NOTES G-84). The Language Model node has no thinking budget
// field, so the cap is raised instead; it is a ceiling, not the expected length.
// watsonx = the new IBM account in Tokyo from 1 Nov (NOTES D-80). Its LLM is the same Mistral Small 3.1
// (listed in jp-tok), but it keeps the Gemini knowledge base v3: Langflow 1.12.2 embeds a knowledge base
// through watsonx Dallas whatever the region (NOTES G-40), so e5 vectors cannot be built or searched with
// a Tokyo project. v2 (Dallas e5, 26 Sep) died with the old account (G-81).
// watsonxUrl: the Language Model node calls the region in its own field base_url_ibm_watsonx (default
// us-south), not the Global Variable WATSONX_URL; Dallas with a Tokyo key = 401 "user profile … 404"
// (NOTES G-41, G-102). Left as it is in a profile without one.
export type Profile = { model: ModelSelection; maxTokens: number; knowledgeBase: string; watsonxUrl?: string };
export const PROFILES: Record<"watsonx" | "gemini", Profile> = {
  watsonx: {
    model: MODELS.mistral,
    maxTokens: 512,
    knowledgeBase: "equilibre_panduan_v3",
    watsonxUrl: "https://jp-tok.ml.cloud.ibm.com",
  },
  gemini: { model: MODELS.gemini, maxTokens: 4096, knowledgeBase: "equilibre_panduan_v3" },
};
export type ProfileName = keyof typeof PROFILES;

// rencana_kerja (plan P20 W2.4) searches v4: the 9 notes of v3 plus the 3 notes of "Plan my next hour", Gemini vectors
// as v3 (buat-kb.mjs builds it). The other flows stay on the profile's v3, so their tested retrieval does not change.
export const RENCANA_KNOWLEDGE_BASE = "equilibre_panduan_v4";

// Flows that use the setups. They are copies of analisis_status, so the Language Model and Knowledge
// nodes keep the ids the server uses (LLM_NODE_ID, KNOWLEDGE_NODE_ID); ringkasan_harian has no
// Knowledge node.
export const FLOWS = ["analisis_status", "cari_panduan", "ringkasan_harian"] as const;
