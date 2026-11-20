import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";
import { ConfigurationError, loadConfig } from "../agent/config.js";

function environment(overrides: Record<string, string | undefined> = {}) {
  return {
    GROQ_API_KEY: "synthetic-groq-token",
    EHR_API_KEY: "synthetic-ehr-token",
    PHARMACY_API_KEY: "synthetic-pharmacy-token",
    ...overrides,
  };
}

test("configuration applies documented defaults without mutating its input", () => {
  const input = environment({ UNRELATED_SETTING: "ignored" });
  const before = { ...input };
  const config = loadConfig(input);
  assert.deepEqual(config, {
    groq: { apiKey: "synthetic-groq-token", model: "openai/gpt-oss-120b", timeoutMs: 10000, maxRetries: 2 },
    backend: {
      ehrBaseUrl: "http://127.0.0.1:4010", pharmacyBaseUrl: "http://127.0.0.1:4010",
      ehrApiKey: "synthetic-ehr-token", pharmacyApiKey: "synthetic-pharmacy-token",
    },
    agentPort: 5050,
  });
  assert.deepEqual(input, before);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.groq));
  assert.ok(Object.isFrozen(config.backend));
});

test("configuration accepts explicit model, independent backend origins and bounds", () => {
  const config = loadConfig(environment({
    LLM_MODEL: "provider/model-v2.1", EHR_BASE_URL: "https://ehr.example.test/",
    PHARMACY_BASE_URL: "https://pharmacy.example.test", AGENT_PORT: "65535",
    REQUEST_TIMEOUT_MS: "60000", LLM_MAX_RETRIES: "3",
  }));
  assert.equal(config.groq.model, "provider/model-v2.1");
  assert.equal(config.backend.ehrBaseUrl, "https://ehr.example.test");
  assert.equal(config.backend.pharmacyBaseUrl, "https://pharmacy.example.test");
  assert.equal(config.agentPort, 65535);
  assert.equal(config.groq.timeoutMs, 60000);
  assert.equal(config.groq.maxRetries, 3);
});

test("configuration accepts minimum bounds and inherits the configured EHR origin", () => {
  const config = loadConfig(environment({
    EHR_BASE_URL: "https://ehr.example.test", AGENT_PORT: "1", REQUEST_TIMEOUT_MS: "100", LLM_MAX_RETRIES: "0",
  }));
  assert.equal(config.backend.pharmacyBaseUrl, "https://ehr.example.test");
  assert.equal(config.agentPort, 1);
  assert.equal(config.groq.timeoutMs, 100);
  assert.equal(config.groq.maxRetries, 0);
});

for (const name of ["GROQ_API_KEY", "EHR_API_KEY", "PHARMACY_API_KEY"]) {
  for (const value of [undefined, "", "   ", "replace-with-a-secret", "your-api-key", "<api-key>", "has whitespace"]) {
    test(`configuration rejects absent or placeholder ${name}: ${value === undefined ? "undefined" : JSON.stringify(value)}`, () => {
      assert.throws(() => loadConfig(environment({ [name]: value })), error => {
        assert.ok(error instanceof ConfigurationError);
        assert.deepEqual(error.variables, [name]);
        return true;
      });
    });
  }
}

for (const value of ["", "gpt-oss-120b", "openai/", "/model", "openai/a/b", "provider/model?key=secret", "provider/model name"]) {
  test(`configuration rejects invalid model syntax: ${JSON.stringify(value)}`, () => {
    assert.throws(() => loadConfig(environment({ LLM_MODEL: value })), ConfigurationError);
  });
}

for (const [name, value] of [
  ["AGENT_PORT", "0"], ["AGENT_PORT", "65536"], ["AGENT_PORT", "3.5"],
  ["AGENT_PORT", "1e3"], ["AGENT_PORT", "NaN"], ["AGENT_PORT", "-1"], ["AGENT_PORT", ""],
  ["REQUEST_TIMEOUT_MS", "99"], ["REQUEST_TIMEOUT_MS", "60001"],
  ["LLM_MAX_RETRIES", "-1"], ["LLM_MAX_RETRIES", "4"], ["LLM_MAX_RETRIES", "0.5"],
]) {
  test(`configuration rejects out-of-range or noninteger ${name}: ${value}`, () => {
    assert.throws(() => loadConfig(environment({ [name]: value })), ConfigurationError);
  });
}

for (const value of ["http://localhost:4010", "http://127.0.0.2:4010", "http://[::1]:4010", "https://backend.example.test:4443"]) {
  test(`configuration accepts permitted backend origin: ${value}`, () => {
    assert.equal(loadConfig(environment({ EHR_BASE_URL: value })).backend.ehrBaseUrl, value);
  });
}

for (const value of [
  "http://backend.example.test", "https://user:password@backend.example.test", "https://backend.example.test/api",
  "https://backend.example.test?token=value", "https://backend.example.test#fragment", "https://backend.example.test?",
  "ftp://localhost", "http:localhost", "invalid", "",
]) {
  test(`configuration rejects unsafe backend origin: ${value}`, () => {
    assert.throws(() => loadConfig(environment({ EHR_BASE_URL: value })), ConfigurationError);
    assert.throws(() => loadConfig(environment({ PHARMACY_BASE_URL: value })), ConfigurationError);
  });
}

test("configuration failures reveal only variable names and never rejected values", () => {
  const marker = "private-marker-never-log";
  assert.throws(() => loadConfig(environment({
    GROQ_API_KEY: `${marker} contains whitespace`,
    LLM_MODEL: `${marker}/invalid/model`,
    EHR_BASE_URL: `https://${marker}:password@backend.example.test`,
  })), error => {
    assert.ok(error instanceof ConfigurationError);
    assert.deepEqual(error.variables, ["EHR_BASE_URL", "GROQ_API_KEY", "LLM_MODEL"]);
    assert.equal(error.message, "Invalid configuration: EHR_BASE_URL, GROQ_API_KEY, LLM_MODEL.");
    assert.ok(!inspect(error).includes(marker));
    assert.ok(!JSON.stringify(error).includes(marker));
    assert.ok(!("issues" in error));
    assert.ok(!("cause" in error));
    return true;
  });
});
