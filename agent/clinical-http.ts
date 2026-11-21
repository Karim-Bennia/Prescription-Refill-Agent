import { z } from "zod";

export type ClinicalEhrErrorCode = "invalid_request" | "invalid_response" | "authentication"
  | "not_found" | "rate_limit" | "unavailable" | "timeout" | "network" | "rejected";

/** Contains diagnostic classifications only; never retains a request, body or original cause. */
export class ClinicalEhrError extends Error {
  readonly code: ClinicalEhrErrorCode;
  readonly uncertain: boolean;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(code: ClinicalEhrErrorCode, details: {
    uncertain?: boolean; retryable?: boolean; status?: number; retryAfterMs?: number;
  } = {}) {
    super(`Clinical service failed (${code}).`);
    this.name = "ClinicalEhrError";
    this.code = code;
    this.uncertain = details.uncertain ?? false;
    this.retryable = details.retryable ?? false;
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
  }
}

export interface ClinicalEhrConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
}
export interface ClinicalEhrDependencies {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

function safeOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]"
      || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
    // Compare against the parsed origin too, rejecting normalized dot segments and hidden paths.
    return (value === url.origin || value === `${url.origin}/`)
      && !url.username && !url.password
      && (url.protocol === "https:" || (url.protocol === "http:" && loopback));
  } catch { return false; }
}

const configSchema = z.strictObject({
  baseUrl: z.string().refine(safeOrigin),
  apiKey: z.string().min(1).max(4096).refine(value => !/[\s\u0000-\u001f\u007f]/.test(value)),
  timeoutMs: z.number().int().min(1).max(60000),
  maxRetries: z.number().int().min(0).max(3),
});

const identifierSchema = z.string().min(1).max(200)
  .refine(value => value !== "." && value !== ".." && !/[\s\u0000-\u001f\u007f]/.test(value))
  .refine(value => { try { encodeURIComponent(value); return true; } catch { return false; } });
const labTypeSchema = z.string().min(1).max(100)
  .refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value))
  .refine(value => { try { encodeURIComponent(value); return true; } catch { return false; } });

const operationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("time") }),
  z.strictObject({ kind: z.literal("medications"), patientId: identifierSchema }),
  z.strictObject({ kind: z.literal("labs"), patientId: identifierSchema, type: labTypeSchema }),
  z.strictObject({ kind: z.literal("pharmacy"), patientId: identifierSchema }),
  z.strictObject({ kind: z.literal("refill"), patientId: identifierSchema, medId: identifierSchema }),
]);
export type ClinicalOperation = z.infer<typeof operationSchema>;

function requestDetails(operation: ClinicalOperation): { path: string; body?: string } {
  if (operation.kind === "time") return { path: "/ehr/time" };
  const prefix = `/ehr/patients/${encodeURIComponent(operation.patientId)}`;
  switch (operation.kind) {
    case "medications": return { path: `${prefix}/medications` };
    case "labs": return { path: `${prefix}/labs?type=${encodeURIComponent(operation.type)}` };
    case "pharmacy": return { path: `${prefix}/pharmacy` };
    case "refill": return { path: `${prefix}/refills`, body: JSON.stringify({ medId: operation.medId }) };
  }
}

function retryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const milliseconds = Number(value) * 1000;
    return Number.isFinite(milliseconds) ? milliseconds : undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && Number.isFinite(now) ? Math.max(0, timestamp - now) : undefined;
}

async function readBoundedJson(response: Response, write: boolean): Promise<unknown> {
  if (!response.body) throw new ClinicalEhrError("invalid_response", { uncertain: write });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 256 * 1024) {
        void reader.cancel().catch(() => undefined);
        throw new ClinicalEhrError("invalid_response", { uncertain: write });
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
    catch { throw new ClinicalEhrError("invalid_response", { uncertain: write }); }
  } finally { reader.releaseLock(); }
}

/** Fixed service origin and allowlisted operations. Raw IDs are trusted internal inputs, not authorization. */
export class ClinicalHttpTransport {
  readonly #config: ClinicalEhrConfig;
  readonly #fetch: typeof fetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #random: () => number;
  readonly #now: () => number;

  constructor(config: ClinicalEhrConfig, dependencies: ClinicalEhrDependencies = {}) {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new ClinicalEhrError("invalid_request");
    this.#config = Object.freeze({ ...parsed.data, baseUrl: new URL(parsed.data.baseUrl).origin });
    this.#fetch = dependencies.fetch ?? globalThis.fetch;
    this.#sleep = dependencies.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    this.#random = dependencies.random ?? Math.random;
    this.#now = dependencies.now ?? Date.now;
  }

  async execute(operation: ClinicalOperation): Promise<unknown> {
    const parsed = operationSchema.safeParse(operation);
    if (!parsed.success) throw new ClinicalEhrError("invalid_request");
    const write = parsed.data.kind === "refill";
    for (let attempt = 0; ; attempt++) {
      try { return await this.#attempt(parsed.data); }
      catch (error) {
        const failure = error instanceof ClinicalEhrError ? error
          : new ClinicalEhrError("network", { uncertain: write, retryable: !write });
        if (write || !failure.retryable || attempt >= this.#config.maxRetries) throw failure;
        const random = this.#random();
        const sample = Number.isFinite(random) ? Math.max(0, Math.min(1, random)) : 1;
        const ceiling = Math.min(2000, 250 * 2 ** attempt);
        const jitter = Math.round(ceiling * (0.5 + 0.5 * sample));
        const delay = (failure.retryAfterMs ?? 0) + jitter;
        if (delay > 10000) throw failure;
        await this.#sleep(delay);
      }
    }
  }

  async #attempt(operation: ClinicalOperation): Promise<unknown> {
    const write = operation.kind === "refill";
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new ClinicalEhrError("timeout", { uncertain: write, retryable: !write }));
        controller.abort();
      }, this.#config.timeoutMs);
    });
    const request = async (): Promise<unknown> => {
      try {
        const { path, body } = requestDetails(operation);
        const headers: Record<string, string> = { authorization: `Bearer ${this.#config.apiKey}` };
        if (write) headers["content-type"] = "application/json";
        const response = await this.#fetch(`${this.#config.baseUrl}${path}`, {
          method: write ? "POST" : "GET", headers, body,
          redirect: "error", cache: "no-store", signal: controller.signal,
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          const status = response.status;
          const code: ClinicalEhrErrorCode = status === 401 || status === 403 ? "authentication"
            : status === 404 ? "not_found" : status === 429 ? "rate_limit" : status === 408 ? "timeout"
            : status >= 500 ? "unavailable" : "rejected";
          throw new ClinicalEhrError(code, {
            status, uncertain: write && status >= 500,
            retryable: !write && (status === 408 || status === 429 || status >= 500),
            retryAfterMs: retryAfter(response.headers.get("retry-after"), this.#now()),
          });
        }
        return await readBoundedJson(response, write);
      } catch (error) {
        if (error instanceof ClinicalEhrError) throw error;
        throw new ClinicalEhrError(controller.signal.aborted ? "timeout" : "network", {
          uncertain: write, retryable: !write,
        });
      }
    };
    try { return await Promise.race([request(), deadline]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
}
