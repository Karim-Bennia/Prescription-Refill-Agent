import { performance } from "node:perf_hooks";
import { z } from "zod";
import { interpretationSchema, type Interpretation, type LanguageInterpreter } from "../agent/intent.js";
import { LlmProviderError, type LlmErrorCode } from "../agent/errors.js";

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const MAX_METADATA_BYTES = 65_536;
export type LiveStopReason = "budget_exhausted" | "rate_limit" | "payment_required" | "authentication"
  | "model_unavailable" | "provider_unavailable";
type GuardReason = LiveStopReason | "concurrent_call" | "aborted" | "invalid_destination" | "invalid_configuration" | "invalid_clock";
export class LiveEvaluationStop extends Error {
  constructor(readonly reason: GuardReason) { super(`Live evaluation stopped (${reason}).`); this.name = "LiveEvaluationStop"; }
}

export interface TokenUsage { promptTokens: number; completionTokens: number; totalTokens: number }
export interface LiveRequestMetric {
  attempt: number; durationMs: number; outcome: "pending" | "response" | "network_error";
  status?: number; errorCode?: "network" | "timeout"; returnedModel?: string; modelMatchesExpected?: boolean; usage?: TokenUsage;
}
export interface LiveInterpretationMetric {
  durationMs: number; structuredOutputValid: boolean | null;
  intent?: Interpretation["intent"]; clarification?: Interpretation["clarification"];
  errorCode?: LlmErrorCode | GuardReason;
}
export interface LiveObserverOptions {
  maxRequests?: number; minIntervalMs?: number; expectedModel?: string; metadataTimeoutMs?: number;
}
export interface LiveObserverDependencies {
  fetch?: typeof fetch; sleep?: (milliseconds: number) => Promise<void>; now?: () => number;
}
const optionsSchema = z.strictObject({
  maxRequests: z.number().int().min(1).max(50).default(40),
  minIntervalMs: z.number().int().min(0).max(60_000).default(2000),
  expectedModel: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/).default("openai/gpt-oss-120b"),
  metadataTimeoutMs: z.number().int().min(1).max(5000).default(1000),
});
const usageSchema = z.object({ prompt_tokens: z.number().int().min(0).max(1_000_000_000),
  completion_tokens: z.number().int().min(0).max(1_000_000_000), total_tokens: z.number().int().min(0).max(1_000_000_000) });
const errorCodes = new Set<LlmErrorCode>(["invalid_input", "invalid_response", "authentication", "rate_limit",
  "model_unavailable", "provider", "network", "timeout", "refused"]);

export function latencySummary(values: readonly number[]) {
  if (!values.every(value => Number.isFinite(value) && value >= 0)) throw new LiveEvaluationStop("invalid_clock");
  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  return { sampleCount: count,
    medianMs: count ? (sorted[Math.floor((count - 1) / 2)] + sorted[Math.ceil((count - 1) / 2)]) / 2 : null,
    p95Ms: count ? sorted[Math.ceil(count * .95) - 1] : null, maxMs: count ? sorted[count - 1] : null };
}

/** Evaluation instrumentation only. Inject fetch into the existing Groq adapter, then wrap that adapter.
 * No prompts, request bodies, headers, credentials or arbitrary provider strings are retained. */
export class LiveEvaluationObserver {
  readonly #options: z.infer<typeof optionsSchema>;
  readonly #transport: typeof fetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #now: () => number;
  readonly #requests: LiveRequestMetric[] = [];
  readonly #interpretations: LiveInterpretationMetric[] = [];
  #activeInterpretation = false;
  #activeFetch = false;
  #lastDispatch?: number;
  #stopReason?: LiveStopReason;

  constructor(options: LiveObserverOptions = {}, dependencies: LiveObserverDependencies = {}) {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success) throw new LiveEvaluationStop("invalid_configuration");
    this.#options = parsed.data;
    this.#transport = dependencies.fetch ?? globalThis.fetch;
    this.#sleep = dependencies.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    this.#now = dependencies.now ?? performance.now.bind(performance);
  }

  get stopReason(): LiveStopReason | undefined { return this.#stopReason; }
  requests(): readonly LiveRequestMetric[] { return structuredClone(this.#requests); }
  interpretations(): readonly LiveInterpretationMetric[] { return structuredClone(this.#interpretations); }

  #clock(): number {
    const value = this.#now();
    if (!Number.isFinite(value)) throw new LiveEvaluationStop("invalid_clock");
    return value;
  }
  #running(): void {
    if (this.#stopReason) throw new LiveEvaluationStop(this.#stopReason);
    if (this.#requests.length >= this.#options.maxRequests) {
      this.#stopReason = "budget_exhausted"; throw new LiveEvaluationStop(this.#stopReason);
    }
  }
  async #pace(): Promise<void> {
    if (this.#lastDispatch !== undefined) {
      const remaining = this.#options.minIntervalMs - (this.#clock() - this.#lastDispatch);
      if (remaining > 0) await this.#sleep(remaining);
    }
  }

  /** Counts actual network attempts, including adapter retries; root uses maxRetries:0 for live runs. */
  readonly fetch: typeof fetch = async (input, init) => {
    this.#running();
    if (this.#activeFetch) throw new LiveEvaluationStop("concurrent_call");
    const destination = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (destination !== ENDPOINT || init?.method !== "POST") throw new LiveEvaluationStop("invalid_destination");
    this.#activeFetch = true;
    let metric: LiveRequestMetric | undefined;
    let started = 0;
    try {
      await this.#pace(); this.#running();
      if (init.signal?.aborted) throw new LiveEvaluationStop("aborted");
      started = this.#clock(); this.#lastDispatch = started;
      metric = { attempt: this.#requests.length + 1, durationMs: 0, outcome: "pending" };
      this.#requests.push(metric);
      let response: Response;
      try { response = await this.#transport(input, init); }
      catch {
        metric.outcome = "network_error"; metric.errorCode = init.signal?.aborted ? "timeout" : "network";
        throw new LlmProviderError(metric.errorCode);
      }
      metric.status = response.status; metric.outcome = "response";
      if (response.status === 429) this.#stopReason = "rate_limit";
      else if (response.status === 402) this.#stopReason = "payment_required";
      else if (response.status === 401 || response.status === 403) this.#stopReason = "authentication";
      else if (response.status === 404) this.#stopReason = "model_unavailable";
      else if (response.status >= 500) this.#stopReason = "provider_unavailable";
      if (response.ok) {
        const metadata = await this.#metadata(response);
        if (metadata) Object.assign(metric, metadata);
      }
      return response;
    } finally {
      if (metric) metric.durationMs = Math.max(0, this.#clock() - started);
      this.#activeFetch = false;
    }
  };

  /** Serial use is deliberate; accidental concurrent batches fail before provider invocation.
   * Pacing here occurs before the adapter starts its own request deadline. */
  wrap(provider: LanguageInterpreter): LanguageInterpreter {
    return { interpret: async text => {
      this.#running();
      if (this.#activeInterpretation) throw new LiveEvaluationStop("concurrent_call");
      if (this.#interpretations.length >= this.#options.maxRequests * 2) {
        this.#stopReason = "budget_exhausted"; throw new LiveEvaluationStop(this.#stopReason);
      }
      this.#activeInterpretation = true;
      let started: number | undefined;
      const metric: LiveInterpretationMetric = { durationMs: 0, structuredOutputValid: null };
      try {
        await this.#pace(); this.#running(); started = this.#clock();
        const parsed = interpretationSchema.safeParse(await provider.interpret(text));
        if (!parsed.success) throw new LlmProviderError("invalid_response");
        metric.structuredOutputValid = true; metric.intent = parsed.data.intent; metric.clarification = parsed.data.clarification;
        return parsed.data;
      } catch (error) {
        if (error instanceof LiveEvaluationStop) { metric.errorCode = error.reason; throw error; }
        const code = error instanceof LlmProviderError && errorCodes.has(error.code) ? error.code : "provider";
        metric.errorCode = code; metric.structuredOutputValid = code === "invalid_response" ? false : null;
        throw new LlmProviderError(code);
      } finally {
        if (started !== undefined) metric.durationMs = Math.max(0, this.#clock() - started);
        this.#interpretations.push(metric); this.#activeInterpretation = false;
      }
    } };
  }

  summary() {
    const usage = this.#requests.flatMap(request => request.usage ? [request.usage] : []);
    return { actualRequests: this.#requests.length, maxRequests: this.#options.maxRequests, stopReason: this.#stopReason ?? null,
      requestLatency: latencySummary(this.#requests.map(request => request.durationMs)),
      interpretationCalls: this.#interpretations.length, interpretationLatency: latencySummary(this.#interpretations.map(metric => metric.durationMs)),
      structuredOutput: { valid: this.#interpretations.filter(metric => metric.structuredOutputValid === true).length,
        invalid: this.#interpretations.filter(metric => metric.structuredOutputValid === false).length,
        notObserved: this.#interpretations.filter(metric => metric.structuredOutputValid === null).length },
      rateLimitEvents: this.#requests.filter(request => request.status === 429).length,
      failedRequests: this.#requests.filter(request => request.outcome !== "response" || (request.status ?? 0) >= 400).length,
      usageSamples: usage.length, tokens: usage.length ? { promptTokens: usage.reduce((sum, item) => sum + item.promptTokens, 0),
        completionTokens: usage.reduce((sum, item) => sum + item.completionTokens, 0), totalTokens: usage.reduce((sum, item) => sum + item.totalTokens, 0) } : null };
  }

  async #metadata(response: Response): Promise<Partial<LiveRequestMetric> | undefined> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const task = async (): Promise<Partial<LiveRequestMetric> | undefined> => {
      const clone = response.clone(); if (!clone.body) return undefined;
      reader = clone.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength; if (size > MAX_METADATA_BYTES) return undefined;
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!body || typeof body !== "object") return undefined;
      const value = z.object({ model: z.unknown().optional(), usage: z.unknown().optional() }).parse(body);
      const safe: Partial<LiveRequestMetric> = {};
      if (typeof value.model === "string") {
        safe.modelMatchesExpected = value.model === this.#options.expectedModel;
        if (safe.modelMatchesExpected) safe.returnedModel = this.#options.expectedModel;
      }
      const usage = usageSchema.safeParse(value.usage);
      if (usage.success) safe.usage = { promptTokens: usage.data.prompt_tokens, completionTokens: usage.data.completion_tokens, totalTokens: usage.data.total_tokens };
      return safe;
    };
    try {
      return await Promise.race([task().catch(() => undefined), new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), this.#options.metadataTimeoutMs);
      })]);
    } finally {
      if (timer) clearTimeout(timer);
      void reader?.cancel().catch(() => undefined);
      try { reader?.releaseLock(); } catch { /* Cancellation may finish after the metadata deadline. */ }
    }
  }
}
