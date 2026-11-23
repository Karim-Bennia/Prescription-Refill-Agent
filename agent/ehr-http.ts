import { z } from "zod";
import type { IdentityFactors } from "./identity.js";
import { EhrError } from "./ehr-errors.js";

export interface EhrIdentityConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
}
export interface EhrDependencies {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

const configSchema = z.strictObject({
  baseUrl: z.string().refine(value => {
    try {
      const url = new URL(value);
      const local = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
      return !url.username && !url.password && url.pathname === "/" && !value.includes("?") && !value.includes("#")
        && (url.protocol === "https:" || (url.protocol === "http:" && local));
    } catch { return false; }
  }),
  apiKey: z.string().min(1).max(4096).refine(value => !/\s/.test(value)),
  timeoutMs: z.number().int().min(1).max(60000),
  maxRetries: z.number().int().min(0).max(3),
});

/** Translate valid provider retry timing into milliseconds without retaining header contents. */
function retryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const result = Number(value) * 1000;
    return Number.isFinite(result) ? result : undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}

/** Parse a size-limited UTF-8 identity-service response or fail with a sanitized error. */
async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new EhrError("invalid_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 16384) {
        void reader.cancel().catch(() => undefined);
        throw new EhrError("invalid_response");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
    catch { throw new EhrError("invalid_response"); }
  } finally { reader.releaseLock(); }
}

/** Only the documented identity-match operation is exposed. It performs no patient reads/writes. */
export class IdentityHttpTransport {
  readonly #config: EhrIdentityConfig;
  readonly #fetch: typeof fetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #random: () => number;
  readonly #now: () => number;

  /** Validate the identity-service origin and inject transport and retry dependencies. */
  constructor(config: EhrIdentityConfig, dependencies: EhrDependencies = {}) {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new EhrError("invalid_request");
    this.#config = Object.freeze({ ...parsed.data, baseUrl: new URL(parsed.data.baseUrl).origin });
    this.#fetch = dependencies.fetch ?? globalThis.fetch;
    this.#sleep = dependencies.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    this.#random = dependencies.random ?? Math.random;
    this.#now = dependencies.now ?? Date.now;
  }

  /** Perform the read-only identity-match POST with bounded safe retries. */
  async postMatch(factors: IdentityFactors): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.#attempt(factors); }
      catch (error) {
        const failure = error instanceof EhrError ? error : new EhrError("network", { retryable: true });
        if (!failure.retryable || attempt >= this.#config.maxRetries) throw failure;
        const ceiling = Math.min(2000, 250 * 2 ** attempt);
        const jitter = Math.round(ceiling * (0.5 + 0.5 * Math.max(0, Math.min(1, this.#random()))));
        const delay = (failure.retryAfterMs ?? 0) + jitter;
        if (delay > 10000) throw failure;
        await this.#sleep(delay);
      }
    }
  }

  /** Bound one identity-match request and its response body by the configured deadline. */
  async #attempt(factors: IdentityFactors): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new EhrError("timeout", { retryable: true }));
        controller.abort();
      }, this.#config.timeoutMs);
    });
    /** Send only identity factors to the fixed match endpoint and classify service failures. */
    const request = async (): Promise<unknown> => {
      try {
        const response = await this.#fetch(`${this.#config.baseUrl}/ehr/patients:match`, {
          method: "POST", redirect: "error", cache: "no-store", signal: controller.signal,
          headers: { authorization: `Bearer ${this.#config.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ factors }),
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          const authentication = response.status === 401 || response.status === 403;
          throw new EhrError(authentication ? "authentication" : "unavailable", {
            status: response.status,
            retryable: !authentication && (response.status === 408 || response.status === 429 || response.status >= 500),
            retryAfterMs: retryAfter(response.headers.get("retry-after"), this.#now()),
          });
        }
        return await readBoundedJson(response);
      } catch (error) {
        if (error instanceof EhrError) throw error;
        throw new EhrError(controller.signal.aborted ? "timeout" : "network", { retryable: true });
      }
    };
    try { return await Promise.race([request(), deadline]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
}
