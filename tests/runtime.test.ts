import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntime } from "../agent/runtime.js";
import { interpretMessage } from "../agent/interpretation.js";
import type { Interpretation, LanguageInterpreter } from "../agent/intent.js";
import { GroqLanguageInterpreter } from "../agent/llm-client.js";

const environment = {
  GROQ_API_KEY: "synthetic-runtime-groq-value",
  EHR_API_KEY: "synthetic-runtime-ehr-value",
  PHARMACY_API_KEY: "synthetic-runtime-pharmacy-value",
};

test("composition accepts a fake interpreter without constructing or calling the provider", async () => {
  // Arrange
  const proposal: Interpretation = {
    intent: "other", identity: { firstName: null, lastName: null, dob: null, phoneLast4: null, zip: null },
    medicationQuery: null, pharmacyQuery: null, clarification: "request",
  };
  const texts: string[] = [];
  const fake: LanguageInterpreter = { interpret: async text => { texts.push(text); return proposal; } };
  const runtime = createRuntime(environment, fake);
  // Act
  const result = await interpretMessage(runtime.interpreter, "Could you help?");
  // Assert
  assert.equal(runtime.interpreter, fake);
  assert.deepEqual(texts, ["Could you help?"]);
  assert.equal(result.clarification, "How can I help with your prescription refill request?");
  assert.equal(Object.hasOwn(result, "patientId"), false);
  assert.equal(Object.hasOwn(result, "authorized"), false);
});

test("composition selects Groq without making startup model calls", () => {
  const runtime = createRuntime(environment);
  assert.ok(runtime.interpreter instanceof GroqLanguageInterpreter);
  assert.equal(runtime.config.groq.model, "openai/gpt-oss-120b");
});
