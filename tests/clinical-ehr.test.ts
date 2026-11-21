import assert from "node:assert/strict";
import { test } from "node:test";
import { ClinicalEhrError, HttpClinicalEhr, type ClinicalEhrConfig } from "../agent/clinical-ehr.js";

const KEY = "synthetic-clinical-service-token";
const PRIVATE = "private-provider-detail";
const PATIENT = "synthetic-record";
const MEDICATION = {
  medId: "synthetic-med", name: "Example medicine 5 mg", isControlled: false, schedule: null,
  lastFilledDate: "2026-01-01", daysSupply: 30, refillsRemaining: 2,
  rxExpirationDate: "2027-01-01", requiresRecentLab: null,
};
const config = (overrides: Partial<ClinicalEhrConfig> = {}): ClinicalEhrConfig => ({
  baseUrl: "http://127.0.0.1:4010", apiKey: KEY, timeoutMs: 1000, maxRetries: 0, ...overrides,
});

function failure(code: string, uncertain = false) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ClinicalEhrError);
    assert.equal(error.code, code);
    assert.equal(error.uncertain, uncertain);
    const exposed = String(error) + JSON.stringify(error) + error.stack;
    for (const secret of [KEY, PRIVATE, PATIENT]) assert.ok(!exposed.includes(secret));
    assert.equal(error.cause, undefined);
    return true;
  };
}

test("clinical adapter calls only exact documented endpoints with service authentication", async () => {
  // Arrange
  const requests: { url: string; init?: RequestInit }[] = [];
  const responses = [
    [MEDICATION], { now: "2026-02-01T12:00:00.000Z" },
    [{ type: "test lab", value: "normal", takenDate: "2026-01-31" }],
    { pharmacyId: "synthetic-pharmacy", name: "Example pharmacy" }, { refillId: "synthetic-refill", status: "submitted" },
  ];
  const client = new HttpClinicalEhr(config(), { fetch: async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json(responses[requests.length - 1]);
  } });
  // Act
  assert.deepEqual(await client.medications(PATIENT), [MEDICATION]);
  assert.equal(await client.time(), "2026-02-01T12:00:00.000Z");
  assert.deepEqual(await client.labs(PATIENT, "test lab"), responses[2]);
  assert.deepEqual(await client.pharmacy(PATIENT), responses[3]);
  assert.deepEqual(await client.submitRefill(PATIENT, MEDICATION.medId), responses[4]);
  // Assert
  assert.deepEqual(requests.map(request => request.url), [
    `http://127.0.0.1:4010/ehr/patients/${PATIENT}/medications`,
    "http://127.0.0.1:4010/ehr/time",
    `http://127.0.0.1:4010/ehr/patients/${PATIENT}/labs?type=test%20lab`,
    `http://127.0.0.1:4010/ehr/patients/${PATIENT}/pharmacy`,
    `http://127.0.0.1:4010/ehr/patients/${PATIENT}/refills`,
  ]);
  for (const [index, request] of requests.entries()) {
    assert.equal(request.init?.method, index === 4 ? "POST" : "GET");
    assert.equal(request.init?.redirect, "error");
    assert.equal(request.init?.cache, "no-store");
    const headers = new Headers(request.init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${KEY}`);
    assert.deepEqual(Array.from(headers.keys()).sort(), index === 4 ? ["authorization", "content-type"] : ["authorization"]);
    assert.equal(request.init?.body, index === 4 ? JSON.stringify({ medId: MEDICATION.medId }) : undefined);
  }
  assert.ok(!JSON.stringify(client).includes(KEY));
});

test("clinical IDs and lab queries are encoded without changing origin or route", async () => {
  const urls: string[] = [];
  const client = new HttpClinicalEhr(config(), { fetch: async url => {
    urls.push(String(url)); return Response.json([]);
  } });
  await client.medications("id/with?#%chars");
  await client.labs("record/second", "A/B & value=other");
  assert.deepEqual(urls, [
    "http://127.0.0.1:4010/ehr/patients/id%2Fwith%3F%23%25chars/medications",
    "http://127.0.0.1:4010/ehr/patients/record%2Fsecond/labs?type=A%2FB%20%26%20value%3Dother",
  ]);
});

test("empty prescription lists, empty labs and absent pharmacy are valid results", async () => {
  const client = new HttpClinicalEhr(config(), { fetch: async url => Response.json(String(url).endsWith("pharmacy") ? null : []) });
  assert.deepEqual(await client.medications(PATIENT), []);
  assert.deepEqual(await client.labs(PATIENT, "test"), []);
  assert.equal(await client.pharmacy(PATIENT), null);
});

test("invalid patient IDs, medication IDs and lab labels are rejected before HTTP", async () => {
  let calls = 0;
  const client = new HttpClinicalEhr(config(), { fetch: async () => { calls++; return Response.json([]); } });
  for (const id of ["", ".", "..", "record with spaces", "record\n", "x".repeat(201), "\ud800"]) {
    await assert.rejects(client.medications(id), failure("invalid_request"));
    await assert.rejects(client.labs(id, "test"), failure("invalid_request"));
    await assert.rejects(client.pharmacy(id), failure("invalid_request"));
    await assert.rejects(client.submitRefill(id, "med"), failure("invalid_request"));
    await assert.rejects(client.submitRefill(PATIENT, id), failure("invalid_request"));
  }
  for (const type of ["", " leading", "trailing ", "test\nother", "x".repeat(101), "\ud800"]) {
    await assert.rejects(client.labs(PATIENT, type), failure("invalid_request"));
  }
  assert.equal(calls, 0);
});

test("constructor rejects unsafe origins, credentials and retry/deadline limits with redacted errors", () => {
  for (const baseUrl of [
    "http://remote.example.test", "https://user:password@example.test", "https://example.test/path",
    "https://example.test/one/..", "https://example.test?key=private-provider-detail",
    "https://example.test#fragment", "file:///tmp/test", " https://example.test",
  ]) assert.throws(() => new HttpClinicalEhr(config({ baseUrl })), failure("invalid_request"));
  for (const apiKey of ["", "with spaces", "with\nnewline", "with\u0000null", "x".repeat(4097)]) {
    assert.throws(() => new HttpClinicalEhr(config({ apiKey })), failure("invalid_request"));
  }
  for (const maxRetries of [-1, 4, 0.5, NaN]) {
    assert.throws(() => new HttpClinicalEhr(config({ maxRetries })), failure("invalid_request"));
  }
  for (const timeoutMs of [0, 60001, 0.5, NaN]) {
    assert.throws(() => new HttpClinicalEhr(config({ timeoutMs })), failure("invalid_request"));
  }
  for (const baseUrl of ["https://example.test", "http://localhost:4010", "http://[::1]:4010", "http://127.0.0.1:4010/"]) {
    assert.doesNotThrow(() => new HttpClinicalEhr(config({ baseUrl })));
  }
});

test("invalid medication fields, duplicate IDs and unauthorized response properties fail closed", async t => {
  const responses = [
    [{ ...MEDICATION, medId: "" }], [{ ...MEDICATION, daysSupply: 0 }],
    [{ ...MEDICATION, refillsRemaining: -1 }], [{ ...MEDICATION, rxExpirationDate: "2026-02-30" }],
    [{ ...MEDICATION, schedule: "CVI" }], [{ ...MEDICATION, authenticated: true }],
    [MEDICATION, MEDICATION], {}, null,
  ];
  for (const [index, response] of responses.entries()) await t.test(`medication response ${index + 1}`, async () => {
    let calls = 0;
    const client = new HttpClinicalEhr(config({ maxRetries: 3 }), {
      fetch: async () => { calls++; return Response.json(response); },
      sleep: async () => { assert.fail("Malformed records must not be retried."); },
    });
    await assert.rejects(client.medications(PATIENT), failure("invalid_response"));
    assert.equal(calls, 1);
  });
});

test("time, lab and pharmacy response schemas reject malformed service records", async () => {
  const cases = [
    { response: { now: "not-a-date" }, call: (client: HttpClinicalEhr) => client.time() },
    { response: { now: "2026-01-01", trusted: true }, call: (client: HttpClinicalEhr) => client.time() },
    { response: [{ type: "test", value: "normal", takenDate: "bad" }], call: (client: HttpClinicalEhr) => client.labs(PATIENT, "test") },
    { response: [{ type: "test", value: 1, takenDate: "2026-01-01" }], call: (client: HttpClinicalEhr) => client.labs(PATIENT, "test") },
    { response: { pharmacyId: "", name: "Example" }, call: (client: HttpClinicalEhr) => client.pharmacy(PATIENT) },
    { response: { pharmacyId: "pharmacy", name: "Example", authorized: true }, call: (client: HttpClinicalEhr) => client.pharmacy(PATIENT) },
  ];
  for (const { response, call } of cases) {
    const client = new HttpClinicalEhr(config(), { fetch: async () => Response.json(response) });
    await assert.rejects(call(client), failure("invalid_response"));
  }
});

test("non-JSON, invalid UTF-8, empty and oversized bodies are sanitized", async () => {
  for (const body of [PRIVATE, "x".repeat(256 * 1024 + 1), new Uint8Array([0xc3, 0x28]), null]) {
    const client = new HttpClinicalEhr(config(), { fetch: async () => new Response(body) });
    await assert.rejects(client.medications(PATIENT), failure("invalid_response"));
  }
});

test("read failures classify authentication, not-found, rate-limit and rejection without leaking body", async () => {
  for (const [status, code] of [[400, "rejected"], [401, "authentication"], [403, "authentication"], [404, "not_found"], [429, "rate_limit"], [503, "unavailable"]] as const) {
    let calls = 0;
    const client = new HttpClinicalEhr(config(), { fetch: async () => {
      calls++; return new Response(`${KEY} ${PRIVATE} ${PATIENT}`, { status });
    } });
    await assert.rejects(client.medications(PATIENT), error => {
      failure(code)(error);
      assert.ok(error instanceof ClinicalEhrError);
      assert.equal(error.status, status);
      assert.equal(error.retryable, status === 429 || status === 503);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("permanent read errors never retry even when retry configuration permits", async () => {
  for (const [status, code] of [[400, "rejected"], [401, "authentication"], [403, "authentication"], [404, "not_found"]] as const) {
    let calls = 0;
    const client = new HttpClinicalEhr(config({ maxRetries: 3 }), {
      fetch: async () => { calls++; return new Response(null, { status }); },
      sleep: async () => { assert.fail("Permanent failure must not retry."); },
    });
    await assert.rejects(client.medications(PATIENT), failure(code));
    assert.equal(calls, 1);
  }
});

test("safe GET reads retry only bounded transient failures with exponential jitter", async () => {
  let calls = 0;
  const delays: number[] = [];
  const client = new HttpClinicalEhr(config({ maxRetries: 2 }), {
    fetch: async () => ++calls < 3 ? new Response(null, { status: 503 }) : Response.json([MEDICATION]),
    random: () => 0, sleep: async delay => { delays.push(delay); },
  });
  assert.deepEqual(await client.medications(PATIENT), [MEDICATION]);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [125, 250]);
});

test("GET retries honor Retry-After seconds and dates with jitter after the minimum", async () => {
  for (const retryAfter of ["2", "Thu, 01 Jan 2026 00:00:02 GMT"]) {
    let calls = 0;
    const delays: number[] = [];
    const client = new HttpClinicalEhr(config({ maxRetries: 1 }), {
      fetch: async () => ++calls === 1
        ? new Response(null, { status: 429, headers: { "retry-after": retryAfter } }) : Response.json([]),
      now: () => Date.parse("2026-01-01T00:00:00Z"), random: () => 0,
      sleep: async delay => { delays.push(delay); },
    });
    await client.medications(PATIENT);
    assert.equal(calls, 2);
    assert.deepEqual(delays, [2125]);
  }
});

test("excessive Retry-After returns a typed rate-limit error without retrying early", async () => {
  let calls = 0;
  const client = new HttpClinicalEhr(config({ maxRetries: 3 }), {
    fetch: async () => { calls++; return new Response(null, { status: 429, headers: { "retry-after": "60" } }); },
    sleep: async () => { assert.fail("Must not ignore upstream minimum delay."); },
  });
  await assert.rejects(client.medications(PATIENT), failure("rate_limit"));
  assert.equal(calls, 1);
});

test("network read errors are sanitized and retry exhaustion has an exact call bound", async () => {
  let calls = 0;
  const client = new HttpClinicalEhr(config({ maxRetries: 2 }), {
    fetch: async () => { calls++; throw new Error(`${PRIVATE} ${KEY} ${PATIENT}`); }, sleep: async () => undefined,
  });
  await assert.rejects(client.medications(PATIENT), failure("network"));
  assert.equal(calls, 3);
});

test("GET deadlines abort both stalled headers and stalled body reading", async () => {
  for (const bodyStall of [false, true]) {
    let aborted = false;
    const client = new HttpClinicalEhr(config({ timeoutMs: 20 }), { fetch: async (_url, init) => {
      if (!bodyStall) return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error(PRIVATE)); }, { once: true });
      });
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode("["));
        init?.signal?.addEventListener("abort", () => { aborted = true; controller.error(new Error(PRIVATE)); }, { once: true });
      } }));
    } });
    await assert.rejects(client.medications(PATIENT), failure("timeout"));
    assert.equal(aborted, true);
  }
});

test("successful refill submission returns only a validated submitted receipt and never retries", async () => {
  let calls = 0;
  const receipt = { refillId: "synthetic-refill", status: "submitted" };
  const client = new HttpClinicalEhr(config({ maxRetries: 3 }), {
    fetch: async () => { calls++; return Response.json(receipt); },
    sleep: async () => { assert.fail("Refill writes must never retry."); },
  });
  assert.deepEqual(await client.submitRefill(PATIENT, MEDICATION.medId), receipt);
  assert.equal(calls, 1);
});

test("known refill 4xx rejections are certain, classified and never retried", async () => {
  for (const [status, code] of [[400, "rejected"], [401, "authentication"], [403, "authentication"], [404, "not_found"], [408, "timeout"], [409, "rejected"], [429, "rate_limit"]] as const) {
    let calls = 0;
    const client = new HttpClinicalEhr(config({ maxRetries: 3 }), {
      fetch: async () => { calls++; return new Response(`${PRIVATE} ${KEY}`, { status, headers: { "retry-after": "1" } }); },
      sleep: async () => { assert.fail("Write must not be retried."); },
    });
    await assert.rejects(client.submitRefill(PATIENT, MEDICATION.medId), error => {
      failure(code)(error);
      assert.ok(error instanceof ClinicalEhrError);
      assert.equal(error.status, status);
      assert.equal(error.retryable, false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("refill 5xx results have unknown write outcome and are never retried", async () => {
  for (const status of [500, 502, 503, 504]) {
    let calls = 0;
    const client = new HttpClinicalEhr(config({ maxRetries: 3 }), {
      fetch: async () => { calls++; return new Response(PRIVATE, { status }); },
      sleep: async () => { assert.fail("Uncertain write must not be retried."); },
    });
    await assert.rejects(client.submitRefill(PATIENT, MEDICATION.medId), failure("unavailable", true));
    assert.equal(calls, 1);
  }
});

test("refill network errors have unknown write outcome and make one attempt", async () => {
  let calls = 0;
  const client = new HttpClinicalEhr(config({ maxRetries: 3 }), {
    fetch: async () => { calls++; throw new Error(`${PRIVATE} ${KEY}`); },
    sleep: async () => { assert.fail("Uncertain write must not be retried."); },
  });
  await assert.rejects(client.submitRefill(PATIENT, MEDICATION.medId), failure("network", true));
  assert.equal(calls, 1);
});

test("refill timeout through headers or body is uncertain and never automatically retried", async () => {
  for (const bodyStall of [false, true]) {
    let calls = 0;
    let aborted = false;
    const client = new HttpClinicalEhr(config({ timeoutMs: 20, maxRetries: 3 }), {
      fetch: async (_url, init) => {
        calls++;
        if (!bodyStall) return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error(PRIVATE)); }, { once: true });
        });
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(new TextEncoder().encode('{"refillId":'));
          init?.signal?.addEventListener("abort", () => { aborted = true; controller.error(new Error(PRIVATE)); }, { once: true });
        } }));
      }, sleep: async () => { assert.fail("Uncertain write must not be retried."); },
    });
    await assert.rejects(client.submitRefill(PATIENT, MEDICATION.medId), failure("timeout", true));
    assert.equal(calls, 1);
    assert.equal(aborted, true);
  }
});

test("malformed successful refill receipts are uncertain without retry or invented completion", async t => {
  const candidates = [
    {}, { refillId: "", status: "submitted" }, { refillId: "refill", status: "completed" },
    { refillId: "refill", status: "accepted" }, { refillId: "refill", status: "submitted", authorized: true },
    null,
  ];
  for (const [index, response] of candidates.entries()) await t.test(`receipt ${index + 1}`, async () => {
    let calls = 0;
    const client = new HttpClinicalEhr(config({ maxRetries: 3 }), {
      fetch: async () => { calls++; return Response.json(response); },
      sleep: async () => { assert.fail("Invalid receipt must not cause another write."); },
    });
    await assert.rejects(client.submitRefill(PATIENT, MEDICATION.medId), failure("invalid_response", true));
    assert.equal(calls, 1);
  });
});

test("non-JSON or oversized refill success bodies preserve unknown write outcome", async () => {
  for (const body of [PRIVATE, "x".repeat(256 * 1024 + 1), null]) {
    let calls = 0;
    const client = new HttpClinicalEhr(config({ maxRetries: 3 }), {
      fetch: async () => { calls++; return new Response(body); },
    });
    await assert.rejects(client.submitRefill(PATIENT, MEDICATION.medId), failure("invalid_response", true));
    assert.equal(calls, 1);
  }
});
