import { ConfigurationError, loadConfig } from "./config.js";
import { LlmProviderError } from "./errors.js";
import { GroqLanguageInterpreter } from "./llm-client.js";
import { loadLocalEnvironment } from "./local-env.js";

// Explicit opt-in only. One synthetic request, no real patient data and no retries.
try {
  loadLocalEnvironment();
  const { groq } = loadConfig(process.env);
  const interpreter = new GroqLanguageInterpreter({ ...groq, maxRetries: 0 });
  await interpreter.interpret("Which details should I provide for a prescription refill request?");
  console.log("Groq smoke test passed: a schema-valid interpretation was received.");
} catch (error) {
  if (error instanceof ConfigurationError) console.error(error.message);
  else if (error instanceof LlmProviderError) console.error(`Groq smoke test failed: ${error.code}.`);
  else console.error("Groq smoke test failed during startup.");
  process.exitCode = 1;
}
