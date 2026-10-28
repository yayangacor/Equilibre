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
  // watsonx Dallas (NOTES D-39, D-40, G-41)
  mistral: selection("mistralai/mistral-small-3-1-24b-instruct-2503", "IBM WatsonX", "IBM"),
  granite: selection("ibm/granite-4-h-small", "IBM WatsonX", "IBM"),
  // Google AI Studio (NOTES D-76)
  gemini: selection("gemini-2.5-flash", "Google Generative AI", "GoogleGenerativeAI"),
};

// The knowledge base goes with the model provider: v2 holds watsonx e5 vectors, so it cannot be
// searched without a working watsonx key, and v3 holds the same 9 notes with Gemini vectors.
// gemini-2.5-flash thinks before it answers and the thinking counts against max_output_tokens, so at
// 512 the reply can come back empty (NOTES G-84). The Language Model node has no thinking budget
// field, so the cap is raised instead; it is a ceiling, not the expected length.
export const PROFILES = {
  watsonx: { model: MODELS.mistral, maxTokens: 512, knowledgeBase: "equilibre_panduan_v2" },
  gemini: { model: MODELS.gemini, maxTokens: 4096, knowledgeBase: "equilibre_panduan_v3" },
};
export type ProfileName = keyof typeof PROFILES;

// Flows that use the setups. They are copies of analisis_status, so the Language Model and Knowledge
// nodes keep the ids the server uses (LLM_NODE_ID, KNOWLEDGE_NODE_ID); ringkasan_harian has no
// Knowledge node.
export const FLOWS = ["analisis_status", "cari_panduan", "ringkasan_harian"] as const;
