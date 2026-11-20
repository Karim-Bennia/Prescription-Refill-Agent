import { loadConfig, type AppConfig } from "./config.js";
import type { LanguageInterpreter } from "./intent.js";
import { GroqLanguageInterpreter } from "./llm-client.js";

export interface Runtime {
  readonly config: AppConfig;
  readonly interpreter: LanguageInterpreter;
}

// The composition root is the only place selecting a concrete language provider.
export function createRuntime(
  environment: Readonly<Record<string, string | undefined>>,
  interpreter?: LanguageInterpreter,
): Runtime {
  const config = loadConfig(environment);
  return Object.freeze({ config, interpreter: interpreter ?? new GroqLanguageInterpreter(config.groq) });
}
