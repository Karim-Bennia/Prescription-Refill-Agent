import { z } from "zod";
import { conversationReplySchema, patientMessageSchema, serviceStatusSchema, type AgentResponse, type ResponseDetails, type ServiceStatus } from "./types.js";

export type ClientErrorCode = "invalid_input" | "network" | "timeout" | "http" | "invalid_json" | "invalid_response";
export class ConversationClientError extends Error {
  /** Keep public failure categories and returned data separate from internal exception details. */
  constructor(readonly code: ClientErrorCode, readonly details: ResponseDetails, message: string) {
    super(message); this.name = "ConversationClientError";
  }
}
export interface ClientOptions { readonly fetch?: typeof fetch; readonly timeoutMs?: number; readonly now?: () => number }
const conversationIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const errorSchema = z.strictObject({ error: z.string().trim().min(1).max(500), outcome: z.literal("unknown").optional() });
const UNKNOWN = "A reliable response was not received. An action may already have been processed. Verify the outcome before repeating a refill or pharmacy confirmation. No automatic retry was made.";

/** Bound a promise even if an injected transport fails to implement cancellation. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // Reject the bounded caller without exposing a raw transport exception.
    const aborted = () => reject(new Error("Request interrupted"));
    // Consume the underlying promise even if cancellation happened during transport creation.
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

/** Limit browser-side response memory before parsing untrusted JSON. */
async function readResponse(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing response body");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await abortable(reader.read(), signal); if (next.done) break;
      size += next.value.byteLength; if (size > 262_144) throw new Error("Response limit exceeded");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** Send one documented patient turn to the same-origin proxy without retries or credentials. */
export async function sendPatientMessage(conversationId: string, text: string, externalSignal?: AbortSignal, options: ClientOptions = {}): Promise<AgentResponse> {
  const now = options.now ?? (() => performance.now()); const started = now();
  // Measure one request without including patient contents in diagnostics.
  const details = (httpStatus: number | null, body: unknown): ResponseDetails => ({ httpStatus, body, durationMs: Math.max(0, now() - started) });
  const input = patientMessageSchema.safeParse({ from: "patient", text });
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!input.success || !conversationIdSchema.safeParse(conversationId).success
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new ConversationClientError("invalid_input", details(null, null), "Use a valid conversation and a message of 1–4000 characters.");
  }
  // A cancelled caller must not create a transport promise or dispatch a patient turn.
  if (externalSignal?.aborted) throw new ConversationClientError("network", details(null, null), UNKNOWN);
  const controller = new AbortController(); let timedOut = false;
  // Forward lifecycle cancellation to the single active transport operation.
  const cancel = () => controller.abort();
  externalSignal?.addEventListener("abort", cancel, { once: true });
  if (externalSignal?.aborted) controller.abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let status: number | null = null;
  try {
    const response = await abortable((options.fetch ?? globalThis.fetch)(`/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input.data),
      signal: controller.signal, cache: "no-store", credentials: "omit", redirect: "error",
    }), controller.signal);
    status = response.status;
    const raw = await readResponse(response, controller.signal);
    let body: unknown;
    try { body = JSON.parse(raw) as unknown; }
    catch { throw new ConversationClientError("invalid_json", details(status, raw), "The response was not valid JSON. Verify the service outcome before repeating a confirmation."); }
    const actual = details(status, body);
    if (!response.ok) {
      const error = errorSchema.safeParse(body);
      throw new ConversationClientError("http", actual, error.success
        ? `${error.data.error} Verify any pending action before repeating a confirmation.`
        : "The request returned an HTTP error. Verify the service outcome before repeating a confirmation.");
    }
    const parsed = conversationReplySchema.safeParse(body);
    if (!parsed.success) throw new ConversationClientError("invalid_response", actual, "The agent response did not match the conversation contract. No successful action is assumed; verify before resending.");
    return { reply: parsed.data, details: actual };
  } catch (error) {
    if (error instanceof ConversationClientError) throw error;
    throw new ConversationClientError(timedOut ? "timeout" : "network", details(status, null), UNKNOWN);
  } finally { clearTimeout(timer); externalSignal?.removeEventListener("abort", cancel); }
}

/** Read health only; this never proves patient authorization or provider connectivity. */
export async function getServiceStatus(signal?: AbortSignal): Promise<ServiceStatus> {
  const response = await fetch("/status", { signal, cache: "no-store", credentials: "omit", redirect: "error" });
  if (!response.ok) throw new Error("Local service status unavailable");
  const body: unknown = await response.json();
  return serviceStatusSchema.parse(body);
}
