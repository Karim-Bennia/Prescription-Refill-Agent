export type EhrErrorCode = "invalid_request" | "invalid_response" | "authentication" | "unavailable" | "timeout" | "network";
export class EhrError extends Error {
  readonly code: EhrErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  /** Create a sanitized identity-service failure with bounded retry metadata. */
  constructor(code: EhrErrorCode, details: { retryable?: boolean; status?: number; retryAfterMs?: number } = {}) {
    super(`Identity service failed (${code}).`);
    this.name = "EhrError";
    this.code = code;
    this.retryable = details.retryable ?? false;
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
  }
}
