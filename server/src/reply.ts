// Shared by langflow.ts and analyze.ts. No imports: web's tests load this file too, and web's
// typecheck has no Node types (config.ts would drag in `process`).

/**
 * Error with a user-facing (Indonesian) message and the HTTP status to return.
 * `retryable`: the model may answer on another try (LLM error, empty reply, timeout). A wrong
 * key, a missing flow or Langflow being down fail the same way again.
 */
export class LangflowError extends Error {
  // Plain fields, not parameter properties: web's typecheck uses erasableSyntaxOnly (NOTES G-18).
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number, retryable = false) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

/** The flow prompt asks for bare JSON, but LLMs sometimes wrap it in ```json fences. */
export function parseJsonReply(text: string): unknown {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}
