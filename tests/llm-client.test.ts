import assert from "node:assert/strict";
import { test } from "node:test";
import { GroqLanguageInterpreter, LlmProviderError } from "../agent/llm-client.js";
import { interpretationSchema, type Interpretation } from "../agent/intent.js";
import { interpretMessage } from "../agent/interpretation.js";

const API_KEY = "test-api-key-not-a-secret";
const INPUT = "Please help with my refill request.";

function interpretation(overrides: Partial<Interpretation> = {}): Interpretation {
  return {
    intent: "refill_request",
    identity: { firstName: null, lastName: null, dob: null, phoneLast4: null, zip: null },
    medicationQuery: "Example medication",
    pharmacyQuery: null,
    clarification: "identity",
    ...overrides,
  };
}

function completion(value: unknown = interpretation(), finishReason = "stop"): Response {
  return Response.json({
    choices: [{ finish_reason: finishReason, message: { content: JSON.stringify(value) } }],
  });
}

function config(overrides: Partial<{ timeoutMs: number; maxRetries: number }> = {}) {
  return { apiKey: API_KEY, model: "openai/gpt-oss-120b", timeoutMs: 1000, maxRetries: 0, ...overrides };
}

function providerError(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof LlmProviderError);
    assert.equal(error.code, code);
    const exposed = JSON.stringify(error) + String(error) + (error.stack ?? "");
    assert.ok(!exposed.includes(API_KEY), "Provider errors must not expose credentials");
    assert.ok(!exposed.includes(INPUT), "Provider errors must not expose patient text");
    return true;
  };
}

test("mocked Groq completion uses the fixed endpoint and validated structured output", async () => {
  // Arrange
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchMock: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return completion();
  };
  const provider = new GroqLanguageInterpreter(config(), { fetch: fetchMock });

  // Act
  const result = await provider.interpret(INPUT);

  // Assert
  assert.deepEqual(result, interpretation());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(new Headers(calls[0].init?.headers).get("authorization"), `Bearer ${API_KEY}`);
  assert.equal(calls[0].init?.redirect, "error", "Credentials must not follow a provider redirect");
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.model, "openai/gpt-oss-120b");
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
  assert.equal(body.temperature, 0);
  assert.equal(body.max_completion_tokens, 2048);
  assert.equal(body.reasoning_effort, "low");
  assert.equal(body.tools, undefined);
  assert.equal(body.messages.filter((message: { role: string }) => message.role === "user").length, 1);
  assert.equal(body.messages.find((message: { role: string }) => message.role === "user").content, INPUT);
  assert.ok(!JSON.stringify(body).includes(API_KEY), "The credential must be a header, never model input");
});

test("strict interpretation schema rejects model-invented identity, authority and write fields", () => {
  // Arrange
  const valid = interpretation();
  const unsafe = [
    { ...valid, patientId: "foreign-patient" },
    { ...valid, medId: "foreign-medication" },
    { ...valid, pharmacyId: "foreign-pharmacy" },
    { ...valid, authenticated: true },
    { ...valid, authorized: true },
    { ...valid, eligible: true },
    { ...valid, refillSubmitted: true },
    { ...valid, action: { method: "POST", url: "https://untrusted.invalid/refills" } },
    { ...valid, identity: { ...valid.identity, patientId: "foreign-patient" } },
    { ...valid, intent: "submit_refill" },
    { ...valid, clarification: "Your refill was submitted." },
  ];

  // Act / Assert
  assert.equal(interpretationSchema.safeParse(valid).success, true);
  for (const candidate of unsafe) {
    assert.equal(interpretationSchema.safeParse(candidate).success, false);
  }
});

test("malformed successful model responses fail closed without retries", async (t) => {
  const responses: [string, () => Response][] = [
    ["invalid provider JSON", () => new Response("not-json", { status: 200 })],
    ["missing choices", () => Response.json({})],
    ["empty choices", () => Response.json({ choices: [] })],
    ["missing message content", () => Response.json({ choices: [{ finish_reason: "stop", message: {} }] })],
    ["invalid completion JSON", () => Response.json({ choices: [{ finish_reason: "stop", message: { content: "not-json" } }] })],
    ["invalid intent", () => completion({ ...interpretation(), intent: "approve_refill" })],
    ["model-invented ID", () => completion({ ...interpretation(), patientId: "foreign-patient" })],
    ["missing required output field", () => completion({ intent: "other" })],
    ["truncated completion", () => completion(interpretation(), "length")],
    ["unexpected tool response", () => Response.json({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [] } }] })],
  ];
  for (const [name, response] of responses) {
    await t.test(name, async () => {
      // Arrange
      let requests = 0;
      const delays: number[] = [];
      const provider = new GroqLanguageInterpreter(config({ maxRetries: 3 }), {
        fetch: async () => { requests++; return response(); },
        sleep: async (delay) => { delays.push(delay); },
      });

      // Act / Assert
      await assert.rejects(provider.interpret(INPUT), providerError("invalid_response"));
      assert.equal(requests, 1);
      assert.deepEqual(delays, []);
    });
  }
});

test("provider refusal is explicit, sanitized and not retried", async () => {
  // Arrange
  let requests = 0;
  const provider = new GroqLanguageInterpreter(config({ maxRetries: 2 }), {
    fetch: async () => {
      requests++;
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: null, refusal: "private-provider-refusal" } }] });
    },
  });

  // Act / Assert
  await assert.rejects(provider.interpret(INPUT), (error: unknown) => {
    providerError("refused")(error);
    assert.ok(!String(error).includes("private-provider-refusal"));
    return true;
  });
  assert.equal(requests, 1);
});

test("permanent authentication and unavailable model failures are never retried", async (t) => {
  for (const [status, code] of [[401, "authentication"], [403, "authentication"], [404, "model_unavailable"], [400, "provider"]] as const) {
    await t.test(String(status), async () => {
      // Arrange
      let requests = 0;
      const provider = new GroqLanguageInterpreter(config({ maxRetries: 3 }), {
        fetch: async () => {
          requests++;
          return Response.json({ error: { message: `private-provider-body ${API_KEY} ${INPUT}` } }, { status });
        },
      });

      // Act / Assert
      await assert.rejects(provider.interpret(INPUT), (error: unknown) => {
        providerError(code)(error);
        assert.ok(error instanceof LlmProviderError);
        assert.equal(error.status, status);
        assert.equal(error.retryable, false);
        assert.ok(!JSON.stringify(error).includes("private-provider-body"));
        return true;
      });
      assert.equal(requests, 1);
    });
  }
});

test("rate limits respect Retry-After before a successful bounded retry", async () => {
  // Arrange
  let requests = 0;
  const delays: number[] = [];
  const provider = new GroqLanguageInterpreter(config({ maxRetries: 2 }), {
    fetch: async () => ++requests === 1
      ? new Response(null, { status: 429, headers: { "retry-after": "2" } })
      : completion(),
    sleep: async (delay) => { delays.push(delay); },
    random: () => 0,
  });

  // Act
  const result = await provider.interpret(INPUT);

  // Assert
  assert.deepEqual(result, interpretation());
  assert.equal(requests, 2);
  assert.equal(delays.length, 1);
  assert.equal(delays[0], 2125, "Jitter must remain effective after the Retry-After minimum");
});

test("HTTP-date Retry-After uses injected time, not wall-clock timing", async () => {
  // Arrange
  const currentTime = Date.parse("2030-01-01T00:00:00Z");
  let requests = 0;
  const delays: number[] = [];
  const provider = new GroqLanguageInterpreter(config({ maxRetries: 1 }), {
    fetch: async () => ++requests === 1
      ? new Response(null, { status: 429, headers: { "retry-after": "Tue, 01 Jan 2030 00:00:03 GMT" } })
      : completion(),
    now: () => currentTime,
    random: () => 0,
    sleep: async (delay) => { delays.push(delay); },
  });

  // Act
  await provider.interpret(INPUT);

  // Assert
  assert.equal(requests, 2);
  assert.equal(delays.length, 1);
  assert.ok(delays[0] >= 3000 && delays[0] <= 3250);
});

test("a long free-tier Retry-After fails without retrying too early", async () => {
  // Arrange
  let requests = 0;
  const delays: number[] = [];
  const provider = new GroqLanguageInterpreter(config({ maxRetries: 3 }), {
    fetch: async () => { requests++; return new Response(null, { status: 429, headers: { "retry-after": "60" } }); },
    sleep: async (delay) => { delays.push(delay); },
  });

  // Act / Assert
  await assert.rejects(provider.interpret(INPUT), (error: unknown) => {
    providerError("rate_limit")(error);
    assert.ok(error instanceof LlmProviderError);
    assert.equal(error.retryAfterMs, 60000);
    return true;
  });
  assert.equal(requests, 1);
  assert.deepEqual(delays, []);
});

test("rate limit retry exhaustion preserves a typed error and bounded request count", async () => {
  // Arrange
  let requests = 0;
  const delays: number[] = [];
  const provider = new GroqLanguageInterpreter(config({ maxRetries: 2 }), {
    fetch: async () => { requests++; return new Response(null, { status: 429 }); },
    sleep: async (delay) => { delays.push(delay); },
    random: () => 0,
  });

  // Act / Assert
  await assert.rejects(provider.interpret(INPUT), providerError("rate_limit"));
  assert.equal(requests, 3);
  assert.equal(delays.length, 2);
});

test("transient server failures use exponential equal jitter and stop at maxRetries", async () => {
  // Arrange
  let requests = 0;
  const delays: number[] = [];
  const provider = new GroqLanguageInterpreter(config({ maxRetries: 3 }), {
    fetch: async () => { requests++; return new Response(null, { status: 503 }); },
    sleep: async (delay) => { delays.push(delay); },
    random: () => 0.5,
  });

  // Act / Assert
  await assert.rejects(provider.interpret(INPUT), providerError("provider"));
  assert.equal(requests, 4);
  assert.equal(delays.length, 3);
  for (const [index, delay] of delays.entries()) {
    const ceiling = Math.min(2000, 250 * (2 ** index));
    assert.ok(delay >= ceiling / 2 && delay <= ceiling, `Delay ${index} outside equal-jitter bounds`);
  }
  assert.ok(delays[1] > delays[0]);
  assert.ok(delays[2] > delays[1]);
});

test("transient network failures can recover without preserving the raw exception", async () => {
  // Arrange
  let requests = 0;
  const delays: number[] = [];
  const provider = new GroqLanguageInterpreter(config({ maxRetries: 1 }), {
    fetch: async () => {
      if (++requests === 1) throw new Error(`private-network-diagnostic ${API_KEY} ${INPUT}`);
      return completion();
    },
    sleep: async (delay) => { delays.push(delay); },
    random: () => 0,
  });

  // Act
  const result = await provider.interpret(INPUT);

  // Assert
  assert.deepEqual(result, interpretation());
  assert.equal(requests, 2);
  assert.equal(delays.length, 1);
});

test("exhausted network errors redact cause, prompt, key and provider diagnostics", async () => {
  // Arrange
  const provider = new GroqLanguageInterpreter(config(), {
    fetch: async () => { throw new Error(`private-network-diagnostic ${API_KEY} ${INPUT}`); },
  });

  // Act / Assert
  await assert.rejects(provider.interpret(INPUT), (error: unknown) => {
    providerError("network")(error);
    assert.ok(error instanceof LlmProviderError);
    assert.ok(!JSON.stringify(error).includes("private-network-diagnostic"));
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("timeout aborts a stalled transport and returns a typed error", async () => {
  // Arrange
  let aborted = false;
  const fetchMock: typeof fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
    const abort = () => { aborted = true; reject(new DOMException("private-timeout-detail", "AbortError")); };
    if (init?.signal?.aborted) abort();
    else init?.signal?.addEventListener("abort", abort, { once: true });
  });
  const provider = new GroqLanguageInterpreter(config({ timeoutMs: 25 }), { fetch: fetchMock });

  // Act / Assert
  await assert.rejects(provider.interpret(INPUT), providerError("timeout"));
  assert.equal(aborted, true);
});

test("request timeout remains active while the successful response body is read", async () => {
  // Arrange
  let aborted = false;
  const fetchMock: typeof fetch = async (_url, init) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"choices":['));
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        controller.error(new DOMException("private-body-timeout", "AbortError"));
      }, { once: true });
    },
  }), { status: 200 });
  const provider = new GroqLanguageInterpreter(config({ timeoutMs: 25 }), { fetch: fetchMock });

  // Act / Assert
  await assert.rejects(provider.interpret(INPUT), providerError("timeout"));
  assert.equal(aborted, true);
});

test("an oversized provider response is rejected without parsing or retrying it", async () => {
  // Arrange
  let requests = 0;
  const provider = new GroqLanguageInterpreter(config({ maxRetries: 2 }), {
    fetch: async () => { requests++; return new Response("x".repeat(65537), { status: 200 }); },
  });

  // Act / Assert
  await assert.rejects(provider.interpret(INPUT), providerError("invalid_response"));
  assert.equal(requests, 1);
});

test("blank messages are rejected before making any provider call", async () => {
  // Arrange
  let requests = 0;
  const provider = new GroqLanguageInterpreter(config(), {
    fetch: async () => { requests++; return completion(); },
  });

  // Act / Assert
  await assert.rejects(provider.interpret("   \n\t"), providerError("invalid_input"));
  assert.equal(requests, 0);
});

test("consumer uses an injected fake interpreter and fixed clarification text", async () => {
  // Arrange
  const seen: string[] = [];
  const fake = {
    async interpret(text: string): Promise<Interpretation> {
      seen.push(text);
      return interpretation({ clarification: "medication" });
    },
  };

  // Act
  const result = await interpretMessage(fake, INPUT);

  // Assert
  assert.deepEqual(seen, [INPUT]);
  assert.deepEqual(result.interpretation, interpretation({ clarification: "medication" }));
  assert.equal(typeof result.clarification, "string");
  assert.ok(result.clarification && result.clarification.length > 0);
  assert.doesNotMatch(result.clarification, /submitted|approved|contacted|authenticated/i);
});

test("consumer revalidates even an injected implementation before exposing proposals", async () => {
  // Arrange
  const fake = {
    async interpret(): Promise<Interpretation> {
      return { ...interpretation(), authorized: true } as Interpretation;
    },
  };

  // Act / Assert
  await assert.rejects(interpretMessage(fake, INPUT));
});
