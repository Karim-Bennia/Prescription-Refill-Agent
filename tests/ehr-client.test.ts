import assert from "node:assert/strict";
import { test } from "node:test";
import { EhrError, HttpEhrIdentityMatcher, matchResultSchema } from "../agent/ehr-client.js";
import type { IdentityFactors } from "../agent/identity.js";

const FACTORS = { firstName: "Morgan", lastName: "Reed", dob: "1990-02-28", phoneLast4: "4321" };
const KEY = "synthetic-identity-service-token";
const config = (overrides: Partial<{ timeoutMs: number; maxRetries: number; baseUrl: string }> = {}) => ({
  baseUrl: "http://127.0.0.1:4010", apiKey: KEY, timeoutMs: 1000, maxRetries: 0, ...overrides,
});
function errorCode(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof EhrError);
    assert.equal(error.code, code);
    const exposed = String(error) + JSON.stringify(error) + error.stack;
    assert.ok(!exposed.includes(KEY));
    assert.ok(!exposed.includes(FACTORS.firstName));
    assert.ok(!exposed.includes("private-provider-detail"));
    assert.equal(error.cause, undefined);
    return true;
  };
}

test("EHR identity adapter sends only the documented match contract and bearer token", async () => {
  // Arrange
  const requests: { url: string; init?: RequestInit }[] = [];
  const client = new HttpEhrIdentityMatcher(config(), { fetch: async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json({ count: 1, patientId: "record-one" });
  } });
  // Act
  const result = await client.match(FACTORS);
  // Assert
  assert.deepEqual(result, { count: 1, patientId: "record-one" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:4010/ehr/patients:match");
  assert.equal(requests[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { factors: FACTORS });
  assert.equal(new Headers(requests[0].init?.headers).get("authorization"), `Bearer ${KEY}`);
  assert.equal(requests[0].init?.redirect, "error");
  assert.ok(!String(requests[0].init?.body).includes(KEY));
});

test("EHR no-match and ambiguous responses never return a patient identity", async () => {
  for (const count of [0, 2, 10]) {
    const client = new HttpEhrIdentityMatcher(config(), { fetch: async () => Response.json({ count, patientId: null }) });
    assert.deepEqual(await client.match(FACTORS), { count, patientId: null });
  }
});

test("empty, partial, malformed and injected match requests never reach the service", async () => {
  let requests = 0;
  const client = new HttpEhrIdentityMatcher(config(), { fetch: async () => { requests++; return Response.json({}); } });
  for (const input of [{}, { firstName: "Morgan" }, { ...FACTORS, dob: "1990-02-30" }, { ...FACTORS, patientId: "foreign" }]) {
    await assert.rejects(client.match(input as IdentityFactors), errorCode("invalid_request"));
  }
  assert.equal(requests, 0);
});

test("inconsistent or malformed identity responses fail closed without retries", async t => {
  const candidates = [
    { count: 1, patientId: null }, { count: 0, patientId: "record-one" },
    { count: 2, patientId: "record-one" }, { count: -1, patientId: null },
    { count: 1.5, patientId: null }, { count: "1", patientId: "record-one" },
    { count: 1, patientId: "" }, { count: 1, patientId: "record with spaces" },
    { count: 1, patientId: "record-one", authenticated: true }, {},
  ];
  for (const [index, response] of candidates.entries()) {
    await t.test(`invalid response ${index + 1}`, async () => {
      let requests = 0;
      const client = new HttpEhrIdentityMatcher(config({ maxRetries: 3 }), { fetch: async () => {
        requests++; return Response.json(response);
      }, sleep: async () => { throw new Error("Must not retry invalid response."); } });
      await assert.rejects(client.match(FACTORS), errorCode("invalid_response"));
      assert.equal(requests, 1);
      assert.equal(matchResultSchema.safeParse(response).success, false);
    });
  }
});

test("non-JSON and oversized responses are rejected without exposing body contents", async () => {
  for (const body of ["private-provider-detail", "x".repeat(16385)]) {
    const client = new HttpEhrIdentityMatcher(config(), { fetch: async () => new Response(body) });
    await assert.rejects(client.match(FACTORS), errorCode("invalid_response"));
  }
});

test("permanent EHR service authentication and other client failures are sanitized and not retried", async () => {
  for (const status of [400, 401, 403, 404]) {
    let requests = 0;
    const client = new HttpEhrIdentityMatcher(config({ maxRetries: 3 }), { fetch: async () => {
      requests++; return new Response(`private-provider-detail ${KEY} ${FACTORS.firstName}`, { status });
    } });
    await assert.rejects(client.match(FACTORS), errorCode(status === 401 || status === 403 ? "authentication" : "unavailable"));
    assert.equal(requests, 1);
  }
});

test("safe identity-match requests retry transient failures with bounded jitter", async () => {
  let requests = 0;
  const delays: number[] = [];
  const client = new HttpEhrIdentityMatcher(config({ maxRetries: 2 }), {
    fetch: async () => ++requests < 3 ? new Response(null, { status: 503 }) : Response.json({ count: 1, patientId: "record-one" }),
    sleep: async delay => { delays.push(delay); }, random: () => 0,
  });
  assert.deepEqual(await client.match(FACTORS), { count: 1, patientId: "record-one" });
  assert.equal(requests, 3);
  assert.deepEqual(delays, [125, 250]);
});

test("EHR retries respect Retry-After plus jitter and stop before excessive delays", async () => {
  let requests = 0;
  const delays: number[] = [];
  const client = new HttpEhrIdentityMatcher(config({ maxRetries: 1 }), {
    fetch: async () => ++requests === 1
      ? new Response(null, { status: 429, headers: { "retry-after": "2" } }) : Response.json({ count: 0, patientId: null }),
    random: () => 0, sleep: async delay => { delays.push(delay); },
  });
  await client.match(FACTORS);
  assert.deepEqual(delays, [2125]);
  const limited = new HttpEhrIdentityMatcher(config({ maxRetries: 3 }), {
    fetch: async () => new Response(null, { status: 429, headers: { "retry-after": "60" } }),
    sleep: async () => { throw new Error("Must not ignore Retry-After."); },
  });
  await assert.rejects(limited.match(FACTORS), errorCode("unavailable"));
});

test("transient network errors are sanitized and retry exhaustion is bounded", async () => {
  let requests = 0;
  const client = new HttpEhrIdentityMatcher(config({ maxRetries: 2 }), {
    fetch: async () => { requests++; throw new Error(`private-provider-detail ${KEY}`); },
    sleep: async () => undefined,
  });
  await assert.rejects(client.match(FACTORS), errorCode("network"));
  assert.equal(requests, 3);
});

test("EHR deadline aborts stalled headers and stalled successful body reading", async () => {
  for (const stallBody of [false, true]) {
    let aborted = false;
    const client = new HttpEhrIdentityMatcher(config({ timeoutMs: 20 }), { fetch: async (_url, init) => {
      if (!stallBody) return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("private-provider-detail")); }, { once: true });
      });
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{"count":'));
        init?.signal?.addEventListener("abort", () => { aborted = true; controller.error(new Error("private-provider-detail")); }, { once: true });
      } }));
    } });
    await assert.rejects(client.match(FACTORS), errorCode("timeout"));
    assert.equal(aborted, true);
  }
});

test("EHR constructor rejects unsafe origins and invalid limits without leaking configuration", () => {
  for (const baseUrl of ["https://user:password@example.test", "https://example.test/path", "http://remote.example.test", "https://example.test?key=private-provider-detail"]) {
    assert.throws(() => new HttpEhrIdentityMatcher(config({ baseUrl })), errorCode("invalid_request"));
  }
  assert.throws(() => new HttpEhrIdentityMatcher(config({ maxRetries: 4 })), errorCode("invalid_request"));
});
