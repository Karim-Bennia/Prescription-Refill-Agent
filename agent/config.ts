import { z } from "zod";

export interface GroqConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
}

export interface AppConfig {
  readonly groq: GroqConfig;
  readonly backend: {
    readonly ehrBaseUrl: string;
    readonly pharmacyBaseUrl: string;
    readonly ehrApiKey: string;
    readonly pharmacyApiKey: string;
  };
  readonly agentPort: number;
}

const variableNames = [
  "GROQ_API_KEY", "LLM_MODEL", "EHR_BASE_URL", "PHARMACY_BASE_URL",
  "EHR_API_KEY", "PHARMACY_API_KEY", "AGENT_PORT", "REQUEST_TIMEOUT_MS", "LLM_MAX_RETRIES",
] as const;
type ConfigurationVariable = typeof variableNames[number];

/** Contains variable names only: never retain rejected values or schema issues. */
export class ConfigurationError extends Error {
  readonly variables: readonly ConfigurationVariable[];

  constructor(variables: readonly ConfigurationVariable[]) {
    const names = [...new Set(variables)].sort();
    super(`Invalid configuration: ${names.join(", ")}.`);
    this.name = "ConfigurationError";
    this.variables = Object.freeze(names);
  }
}

const placeholder = /^(?:replace(?:[-_\s]|$)|your(?:[-_\s]|$)|placeholder(?:[-_\s]|$)|change[-_\s]?me$|example$|todo$|<.*>|\$\{.*\})/i;
const secret = z.string().trim().min(1).max(4096)
  .refine(value => !/\s/.test(value) && !placeholder.test(value));
const model = z.string().trim().min(1).max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/);

const origin = z.string().trim().refine(value => {
  try {
    if (!/^https?:\/\//i.test(value) || value.includes("?") || value.includes("#")) return false;
    const url = new URL(value);
    if (url.username || url.password || url.pathname !== "/") return false;
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]"
      || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
    return url.protocol === "https:" || (url.protocol === "http:" && loopback);
  } catch {
    return false;
  }
}).transform(value => new URL(value).origin);

function integer(min: number, max: number, fallback: string) {
  return z.string().regex(/^(0|[1-9]\d*)$/).default(fallback).transform(Number)
    .pipe(z.number().int().min(min).max(max));
}

const environmentSchema = z.object({
  GROQ_API_KEY: secret,
  LLM_MODEL: model.default("openai/gpt-oss-120b"),
  EHR_BASE_URL: origin.default("http://127.0.0.1:4010"),
  PHARMACY_BASE_URL: origin.optional(),
  EHR_API_KEY: secret,
  PHARMACY_API_KEY: secret,
  AGENT_PORT: integer(1, 65535, "5050"),
  REQUEST_TIMEOUT_MS: integer(100, 60000, "10000"),
  LLM_MAX_RETRIES: integer(0, 3, "2"),
}).strict();

/** Pure parser. The composition root alone decides how environment is loaded. */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  const selected = Object.fromEntries(variableNames.map(name => [name, env[name]]));
  const parsed = environmentSchema.safeParse(selected);
  if (!parsed.success) {
    const invalid = parsed.error.issues.map(issue => issue.path[0])
      .filter((name): name is ConfigurationVariable => variableNames.includes(name as ConfigurationVariable));
    throw new ConfigurationError(invalid);
  }
  const values = parsed.data;
  return Object.freeze({
    groq: Object.freeze({
      apiKey: values.GROQ_API_KEY,
      model: values.LLM_MODEL,
      timeoutMs: values.REQUEST_TIMEOUT_MS,
      maxRetries: values.LLM_MAX_RETRIES,
    }),
    backend: Object.freeze({
      ehrBaseUrl: values.EHR_BASE_URL,
      pharmacyBaseUrl: values.PHARMACY_BASE_URL ?? values.EHR_BASE_URL,
      ehrApiKey: values.EHR_API_KEY,
      pharmacyApiKey: values.PHARMACY_API_KEY,
    }),
    agentPort: values.AGENT_PORT,
  });
}
