import { loadConfig, type AppConfig } from "./config.js";
import type { LanguageInterpreter } from "./intent.js";
import { GroqLanguageInterpreter } from "./llm-client.js";
import { HttpEhrIdentityMatcher, type IdentityMatcher } from "./ehr-client.js";
import { InMemorySessionRepository, type SessionRepository } from "./sessions.js";
import { ConversationEngine } from "./workflow.js";

export interface Runtime {
  readonly config: AppConfig;
  readonly interpreter: LanguageInterpreter;
  readonly engine: ConversationEngine;
}

// The composition root is the only place selecting a concrete language provider.
export function createRuntime(
  environment: Readonly<Record<string, string | undefined>>,
  interpreter?: LanguageInterpreter,
  overrides: { matcher?: IdentityMatcher; sessions?: SessionRepository } = {},
): Runtime {
  const config = loadConfig(environment);
  const language = interpreter ?? new GroqLanguageInterpreter(config.groq);
  const matcher = overrides.matcher ?? new HttpEhrIdentityMatcher({
    baseUrl: config.backend.ehrBaseUrl, apiKey: config.backend.ehrApiKey,
    timeoutMs: config.groq.timeoutMs, maxRetries: 1,
  });
  const engine = new ConversationEngine({
    matcher, interpreter: language, sessions: overrides.sessions ?? new InMemorySessionRepository(),
  });
  return Object.freeze({ config, interpreter: language, engine });
}
