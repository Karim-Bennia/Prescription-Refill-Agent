import assert from "node:assert/strict";
import { test } from "node:test";
import { GroqLanguageInterpreter } from "../agent/llm-client.js";
import { LlmProviderError } from "../agent/errors.js";
import type { Interpretation } from "../agent/intent.js";
import { latencySummary, LiveEvaluationObserver, LiveEvaluationStop } from "../evaluation/live-observer.js";

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "openai/gpt-oss-120b";
const SYNTHETIC_KEY = "synthetic-test-key-not-a-credential";
const SYNTHETIC_INPUT = "Synthetic medication request that must not appear in telemetry";
const proposal: Interpretation = {
  intent: "refill_request", identity: { firstName: null, lastName: null, dob: null, phoneLast4: null, zip: null },
  medicationQuery: "Synthetic medication", pharmacyQuery: null, clarification: "medication",
};
const envelope = (value: unknown = proposal, extras: Record<string, unknown> = {}) => ({
  model: MODEL, choices: [{ finish_reason: "stop", message: { content: JSON.stringify(value) } }],
  usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }, ...extras,
});
function provider(observer: LiveEvaluationObserver) {
  return observer.wrap(new GroqLanguageInterpreter({ apiKey: SYNTHETIC_KEY, model: MODEL, timeoutMs: 1000, maxRetries: 0 },
    { fetch: observer.fetch }));
}
function stopped(reason: string) {
  return (error: unknown) => error instanceof LiveEvaluationStop && error.reason === reason;
}
function providerFailed(code: string) {
  return (error: unknown) => error instanceof LlmProviderError && error.code === code;
}

test("live observer instruments the existing adapter without retaining synthetic prompts or credentials", async () => {
  // Arrange: this injected fetch is entirely local and never contacts Groq.
  let clock = 0;
  let calls = 0;
  const observer = new LiveEvaluationObserver({ minIntervalMs: 0 }, {
    now: () => clock,
    fetch: async () => {
      calls++; clock += 7;
      return Response.json(envelope(proposal, { debug: SYNTHETIC_KEY + SYNTHETIC_INPUT }));
    },
  });

  // Act
  const actual = await provider(observer).interpret(SYNTHETIC_INPUT);

  // Assert: interpretation is returned to orchestration; only labels and numeric metadata are retained.
  assert.deepEqual(actual, proposal);
  assert.equal(calls, 1);
  assert.deepEqual(observer.requests(), [{ attempt: 1, durationMs: 7, outcome: "response", status: 200,
    returnedModel: MODEL, modelMatchesExpected: true, usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 } }]);
  assert.deepEqual(observer.interpretations(), [{ durationMs: 7, structuredOutputValid: true,
    intent: "refill_request", clarification: "medication" }]);
  assert.deepEqual(observer.summary().tokens, { promptTokens: 12, completionTokens: 8, totalTokens: 20 });
  assert.equal(observer.summary().actualRequests, 1);
  assert.equal(observer.summary().interpretationCalls, 1);
  const report = JSON.stringify([observer.requests(), observer.interpretations(), observer.summary()]);
  for (const forbidden of [SYNTHETIC_KEY, SYNTHETIC_INPUT, proposal.medicationQuery!, "authorization", "debug", "choices"]) {
    assert.ok(!report.includes(forbidden));
  }
});

test("a shared observer budgets actual fetch attempts across adapter instances and returns isolated snapshots", async () => {
  // Arrange
  let calls = 0;
  const observer = new LiveEvaluationObserver({ maxRequests: 2, minIntervalMs: 0 }, {
    fetch: async () => { calls++; return Response.json(envelope()); },
  });

  // Act
  await provider(observer).interpret("Synthetic first turn");
  await provider(observer).interpret("Synthetic second turn");
  await assert.rejects(provider(observer).interpret("Synthetic third turn"), stopped("budget_exhausted"));
  const snapshot = observer.requests();
  snapshot[0].usage!.totalTokens = 999;

  // Assert
  assert.equal(calls, 2);
  assert.equal(observer.stopReason, "budget_exhausted");
  assert.equal(observer.summary().actualRequests, 2);
  assert.equal(observer.summary().tokens!.totalTokens, 40);
  assert.equal(observer.interpretations().length, 2);
});

test("live evaluation pacing happens before provider deadlines and separates model calls from HTTP turns", async () => {
  // Arrange
  let clock = 0;
  const sleeps: number[] = [];
  const observer = new LiveEvaluationObserver({ minIntervalMs: 100 }, {
    now: () => clock,
    sleep: async milliseconds => { sleeps.push(milliseconds); clock += milliseconds; },
    fetch: async () => { clock += 5; return Response.json(envelope()); },
  });
  const interpreter = provider(observer);

  // Act: the harness is responsible for recording HTTP turns separately.
  await interpreter.interpret("Synthetic first request");
  await interpreter.interpret("Synthetic second request");

  // Assert: no sleep is charged to model latency, including a clock starting at zero.
  assert.deepEqual(sleeps, [95]);
  assert.deepEqual(observer.requests().map(item => item.durationMs), [5, 5]);
  assert.deepEqual(observer.interpretations().map(item => item.durationMs), [5, 5]);
});

test("unexpected concurrent model calls are rejected before a second provider attempt", async () => {
  // Arrange
  let signalEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { signalEntered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const observer = new LiveEvaluationObserver({ minIntervalMs: 0 }, {
    fetch: async () => { calls++; signalEntered(); await gate; return Response.json(envelope()); },
  });
  const interpreter = provider(observer);

  // Act
  const first = interpreter.interpret("Synthetic first request");
  await entered;
  await assert.rejects(interpreter.interpret("Synthetic concurrent request"), stopped("concurrent_call"));
  release(); await first;

  // Assert
  assert.equal(calls, 1);
  assert.equal(observer.summary().actualRequests, 1);
  assert.equal(observer.summary().interpretationCalls, 1);
});

test("rate, billing, authentication and unavailable-provider responses stop further live requests", async t => {
  const cases = [
    { status: 429, reason: "rate_limit", code: "rate_limit" },
    { status: 402, reason: "payment_required", code: "provider" },
    { status: 401, reason: "authentication", code: "authentication" },
    { status: 403, reason: "authentication", code: "authentication" },
    { status: 404, reason: "model_unavailable", code: "model_unavailable" },
    { status: 503, reason: "provider_unavailable", code: "provider" },
  ];
  for (const fixture of cases) await t.test(String(fixture.status), async () => {
    // Arrange
    let calls = 0;
    const observer = new LiveEvaluationObserver({ minIntervalMs: 0 }, {
      fetch: async () => { calls++; return new Response(SYNTHETIC_KEY + SYNTHETIC_INPUT, { status: fixture.status }); },
    });
    const interpreter = provider(observer);

    // Act / Assert
    await assert.rejects(interpreter.interpret("Synthetic request"), providerFailed(fixture.code));
    await assert.rejects(interpreter.interpret("Synthetic retry"), stopped(fixture.reason));
    assert.equal(observer.stopReason, fixture.reason);
    assert.equal(calls, 1);
    assert.equal(observer.summary().failedRequests, 1);
    assert.equal(observer.summary().rateLimitEvents, fixture.status === 429 ? 1 : 0);
    assert.equal(observer.summary().tokens, null);
    assert.equal(observer.interpretations()[0].structuredOutputValid, null);
    assert.ok(!JSON.stringify([observer.requests(), observer.interpretations()]).includes(SYNTHETIC_KEY));
  });
});

test("malformed successful responses are recorded as invalid structured output without false success", async () => {
  // Arrange
  const observer = new LiveEvaluationObserver({ minIntervalMs: 0 }, {
    fetch: async () => Response.json(envelope({ ...proposal, authorized: true })),
  });

  // Act / Assert
  await assert.rejects(provider(observer).interpret("Synthetic request"), providerFailed("invalid_response"));
  assert.deepEqual(observer.summary().structuredOutput, { valid: 0, invalid: 1, notObserved: 0 });
  assert.equal(observer.summary().actualRequests, 1);
  assert.equal(observer.interpretations()[0].intent, undefined);
});

test("observer strips arbitrary thrown error content and records network failures separately", async () => {
  // Arrange
  const observer = new LiveEvaluationObserver({ minIntervalMs: 0 }, {
    fetch: async () => { throw new Error(SYNTHETIC_KEY + SYNTHETIC_INPUT); },
  });

  // Act / Assert
  await assert.rejects(provider(observer).interpret("Synthetic request"), error => {
    assert.ok(error instanceof LlmProviderError);
    assert.equal(error.code, "network");
    assert.ok(!String(error).includes(SYNTHETIC_KEY));
    return true;
  });
  assert.equal(observer.requests()[0].outcome, "network_error");
  assert.equal(observer.requests()[0].errorCode, "network");
  assert.equal(observer.summary().failedRequests, 1);
  assert.deepEqual(observer.summary().structuredOutput, { valid: 0, invalid: 0, notObserved: 1 });
  assert.ok(!JSON.stringify(observer.interpretations()).includes(SYNTHETIC_INPUT));
});

test("metadata validates token counters and never stores unexpected provider model strings", async () => {
  // Arrange
  const observer = new LiveEvaluationObserver({ minIntervalMs: 0 }, {
    fetch: async () => Response.json(envelope(proposal, {
      model: SYNTHETIC_KEY, usage: { prompt_tokens: -1, completion_tokens: 1, total_tokens: 0, unsafe: SYNTHETIC_KEY },
    })),
  });

  // Act
  await provider(observer).interpret("Synthetic request");

  // Assert
  assert.equal(observer.requests()[0].modelMatchesExpected, false);
  assert.equal(observer.requests()[0].returnedModel, undefined);
  assert.equal(observer.requests()[0].usage, undefined);
  assert.equal(observer.summary().usageSamples, 0);
  assert.ok(!JSON.stringify(observer.requests()).includes(SYNTHETIC_KEY));
});

test("metadata collection has a byte cap while leaving response validation to the existing adapter", async () => {
  // Arrange
  const observer = new LiveEvaluationObserver({ minIntervalMs: 0 }, {
    fetch: async () => Response.json(envelope(proposal, { padding: "x".repeat(65_536) })),
  });

  // Act / Assert
  await assert.rejects(provider(observer).interpret("Synthetic request"), providerFailed("invalid_response"));
  assert.equal(observer.summary().actualRequests, 1);
  assert.equal(observer.summary().usageSamples, 0);
  assert.equal(observer.requests()[0].returnedModel, undefined);
});

test("metadata collection stops at its own deadline without consuming the original response", async () => {
  // Arrange
  let close!: () => void;
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"model":"openai/gpt-oss-120b"'));
    close = () => controller.close();
  } });
  const original = new Response(body);
  const observer = new LiveEvaluationObserver({ minIntervalMs: 0, metadataTimeoutMs: 5 }, {
    fetch: async () => original,
  });

  // Act: the unresolved response body cannot hold metadata collection open indefinitely.
  const actual = await observer.fetch(ENDPOINT, { method: "POST" });
  close();

  // Assert
  assert.equal(actual, original);
  assert.equal(actual.bodyUsed, false);
  assert.equal(observer.requests()[0].returnedModel, undefined);
  await actual.body?.cancel();
});

test("unsafe destinations and aborted requests do not consume budget or reach transport", async () => {
  // Arrange
  let calls = 0;
  const observer = new LiveEvaluationObserver({ minIntervalMs: 0 }, { fetch: async () => {
    calls++; return Response.json(envelope());
  } });

  // Act / Assert
  await assert.rejects(observer.fetch("https://untrusted.invalid/", { method: "POST" }), stopped("invalid_destination"));
  await assert.rejects(observer.fetch(ENDPOINT, { method: "GET" }), stopped("invalid_destination"));
  await assert.rejects(observer.fetch(ENDPOINT, { method: "POST", signal: AbortSignal.abort() }), stopped("aborted"));
  assert.equal(calls, 0);
  assert.equal(observer.summary().actualRequests, 0);
});

test("live observer validates bounds and reports quantiles with explicit denominators", () => {
  // Arrange
  const values = [20, 1, 3, 2];

  // Act / Assert
  assert.deepEqual(latencySummary(values), { sampleCount: 4, medianMs: 2.5, p95Ms: 20, maxMs: 20 });
  assert.deepEqual(values, [20, 1, 3, 2]);
  assert.deepEqual(latencySummary([]), { sampleCount: 0, medianMs: null, p95Ms: null, maxMs: null });
  for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => latencySummary([invalid]), stopped("invalid_clock"));
  assert.throws(() => new LiveEvaluationObserver({ maxRequests: 51 }), stopped("invalid_configuration"));
  assert.throws(() => new LiveEvaluationObserver({ metadataTimeoutMs: 0 }), stopped("invalid_configuration"));
  assert.throws(() => new LiveEvaluationObserver({ expectedModel: "unsafe-model-without-provider" }), stopped("invalid_configuration"));
});
