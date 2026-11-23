export type LlmErrorCode = "invalid_input" | "invalid_response" | "authentication"
  | "rate_limit" | "model_unavailable" | "provider" | "network" | "timeout" | "refused";

interface ErrorDetails {
  retryable?: boolean;
  status?: number;
  retryAfterMs?: number;
}

export class LlmProviderError extends Error {
  readonly code: LlmErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  /** Retain only an allowlisted model-error category and safe retry metadata. */
  constructor(code: LlmErrorCode, details: ErrorDetails = {}) {
    // Error objects must never retain bodies, causes, prompts, headers or credentials.
    super(`Language provider failed (${code}).`);
    this.name = "LlmProviderError";
    this.code = code;
    this.retryable = details.retryable ?? false;
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
  }
}
