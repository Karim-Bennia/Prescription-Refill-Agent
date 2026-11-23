import { loadConfig, type AppConfig } from "./config.js";
import type { LanguageInterpreter } from "./intent.js";
import { GroqLanguageInterpreter } from "./llm-client.js";
import { HttpEhrIdentityMatcher, type IdentityMatcher } from "./ehr-client.js";
import { InMemorySessionRepository, type SessionRepository } from "./sessions.js";
import { ConversationEngine } from "./workflow.js";
import { HttpClinicalEhr, type ClinicalEhr } from "./clinical-ehr.js";
import { PatientClinicalReader } from "./patient-clinical.js";
import { PrescriptionWorkflow } from "./clinical-workflow.js";
import { RefillActions } from "./actions.js";
import { HttpPharmacyService, type PharmacyService } from "./pharmacy-client.js";
import { PharmacyWorkflow } from "./pharmacy-workflow.js";

export interface Runtime {
  readonly config: AppConfig;
  readonly interpreter: LanguageInterpreter;
  readonly engine: ConversationEngine;
  readonly actions: RefillActions;
}

interface RuntimeOverrides { matcher?: IdentityMatcher; sessions?: SessionRepository; ehr?: ClinicalEhr; pharmacy?: PharmacyService }

// The composition root is the only place selecting a concrete language provider.
/** Compose configuration, language interpretation and guarded clinical workflow dependencies. */
export function createRuntime(
  environment: Readonly<Record<string, string | undefined>>,
  interpreter?: LanguageInterpreter,
  overrides: RuntimeOverrides = {},
): Runtime {
  const config = loadConfig(environment);
  const language = interpreter ?? new GroqLanguageInterpreter(config.groq);
  const matcher = overrides.matcher ?? new HttpEhrIdentityMatcher({
    baseUrl: config.backend.ehrBaseUrl, apiKey: config.backend.ehrApiKey,
    timeoutMs: config.groq.timeoutMs, maxRetries: 1,
  });
  const ehr = overrides.ehr ?? new HttpClinicalEhr({ baseUrl: config.backend.ehrBaseUrl,
    apiKey: config.backend.ehrApiKey, timeoutMs: config.groq.timeoutMs, maxRetries: 1 });
  const actions = new RefillActions(ehr);
  const reader = new PatientClinicalReader(ehr);
  const engine = new ConversationEngine({
    matcher, interpreter: language, sessions: overrides.sessions ?? new InMemorySessionRepository(),
    clinical: new PrescriptionWorkflow(reader),
    pharmacy: overrides.pharmacy ? new PharmacyWorkflow(reader, overrides.pharmacy, actions) : undefined,
  });
  return Object.freeze({ config, interpreter: language, engine, actions });
}

// The clinical core factory remains useful for isolated tests.
/** Compose the executable agent with pharmacy integration and injectable workflow dependencies. */
export function createApplicationRuntime(
  environment: Readonly<Record<string, string | undefined>>,
  interpreter?: LanguageInterpreter,
  overrides: RuntimeOverrides = {},
): Runtime {
  const config = loadConfig(environment);
  const pharmacy = overrides.pharmacy ?? new HttpPharmacyService({ ...config.backend,
    timeoutMs: config.groq.timeoutMs, maxRetries: 1 });
  return createRuntime(environment, interpreter, { ...overrides, pharmacy });
}
