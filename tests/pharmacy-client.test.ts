import assert from "node:assert/strict";
import { test } from "node:test";
import { ClinicalEhrError } from "../agent/clinical-http.js";
import { HttpPharmacyService, type PharmacyServiceConfig } from "../agent/pharmacy-client.js";

const EHR_KEY = "synthetic-ehr-token";
const DIRECTORY_KEY = "synthetic-directory-token";
const PRIVATE = "sensitive-provider-detail";
const PATIENT = "synthetic-patient";
const PHARMACY = { pharmacyId: "branch-A", name: "Example Pharmacy", address: "10 Example Street" };
const config = (overrides: Partial<PharmacyServiceConfig> = {}): PharmacyServiceConfig => ({
  ehrBaseUrl: "http://127.0.0.1:4010", ehrApiKey: EHR_KEY,
  pharmacyBaseUrl: "http://127.0.0.1:4011", pharmacyApiKey: DIRECTORY_KEY,
  timeoutMs: 1000, maxRetries: 0, ...overrides,
});

function failure(code: string, uncertain = false) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ClinicalEhrError);
    assert.equal(error.code, code);
    assert.equal(error.uncertain, uncertain);
    const exposed = String(error) + JSON.stringify(error) + error.stack;
    for (const secret of [EHR_KEY, DIRECTORY_KEY, PRIVATE, PATIENT]) assert.ok(!exposed.includes(secret));
    assert.equal(error.cause, undefined);
    return true;
  };
}

test("pharmacy adapter uses documented endpoints, methods and distinct service credentials", async () => {
  // Arrange
  const requests: { url: string; init?: RequestInit }[] = [];
  const service = new HttpPharmacyService(config(), { fetch: async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json(init?.method === "PUT" ? { ok: true } : [PHARMACY]);
  } });
  // Act
  assert.deepEqual(await service.search("Market & Main"), [PHARMACY]);
  assert.equal(await service.update("patient/one?", "branch/A?"), undefined);
  // Assert
  assert.deepEqual(requests.map(request => request.url), [
    "http://127.0.0.1:4011/pharmacy/directory?q=Market%20%26%20Main",
    "http://127.0.0.1:4010/ehr/patients/patient%2Fone%3F/pharmacy",
  ]);
  assert.deepEqual(requests.map(request => request.init?.method), ["GET", "PUT"]);
  assert.equal(new Headers(requests[0].init?.headers).get("authorization"), `Bearer ${DIRECTORY_KEY}`);
  assert.equal(new Headers(requests[1].init?.headers).get("authorization"), `Bearer ${EHR_KEY}`);
  assert.equal(requests[0].init?.body, undefined);
  assert.equal(requests[1].init?.body, JSON.stringify({ pharmacyId: "branch/A?" }));
  assert.equal(new Headers(requests[1].init?.headers).get("content-type"), "application/json");
  for (const request of requests) {
    assert.equal(request.init?.redirect, "error");
    assert.equal(request.init?.cache, "no-store");
    assert.ok(request.init?.signal);
  }
  assert.equal(JSON.stringify(service), "{}");
});

test("empty directory query lists all supported pharmacies and empty results remain empty", async () => {
  let url = "";
  const service = new HttpPharmacyService(config(), { fetch: async input => {
    url = String(input); return Response.json([]);
  } });
  assert.deepEqual(await service.search(""), []);
  assert.equal(url, "http://127.0.0.1:4011/pharmacy/directory?q=");
});

test("pharmacy request validation rejects malformed queries and identifiers before HTTP", async () => {
  let calls = 0;
  const service = new HttpPharmacyService(config(), { fetch: async () => {
    calls++; return Response.json({ ok: true });
  } });
  for (const query of [" trailing ", "line\nbreak", "\u0000", "x".repeat(201), "\ud800"]) {
    await assert.rejects(service.search(query), failure("invalid_request"));
  }
  for (const id of ["", ".", "..", "with space", "with\nnewline", "x".repeat(201), "\ud800"]) {
    await assert.rejects(service.update(id, PHARMACY.pharmacyId), failure("invalid_request"));
    await assert.rejects(service.update(PATIENT, id), failure("invalid_request"));
  }
  assert.equal(calls, 0);
});

test("pharmacy configuration rejects unsafe origins, missing tokens and invalid limits", () => {
  for (const changes of [
    { pharmacyBaseUrl: "http://remote.example.test" }, { ehrBaseUrl: "https://example.test/path" },
    { pharmacyBaseUrl: "https://user:password@example.test" }, { pharmacyApiKey: "" },
    { ehrApiKey: "with spaces" }, { timeoutMs: 0 }, { maxRetries: 4 },
  ]) assert.throws(() => new HttpPharmacyService(config(changes)), failure("invalid_request"));
});

test("malformed directory entries and conflicting IDs fail closed without retry", async () => {
  const responses = [
    null, {}, [{ pharmacyId: "", name: "Name", address: "Address" }],
    [{ ...PHARMACY, address: "" }], [{ ...PHARMACY, selected: true }],
    [PHARMACY, PHARMACY], [PHARMACY, { ...PHARMACY, address: "Other address" }],
  ];
  for (const response of responses) {
    let calls = 0;
    const service = new HttpPharmacyService(config({ maxRetries: 3 }), {
      fetch: async () => { calls++; return Response.json(response); },
      sleep: async () => assert.fail("Invalid data must not be retried."),
    });
    await assert.rejects(service.search("Example"), failure("invalid_response"));
    assert.equal(calls, 1);
  }
});

test("directory transient failures use bounded read retries and honor rate-limit delay", async () => {
  let calls = 0;
  const delays: number[] = [];
  const service = new HttpPharmacyService(config({ maxRetries: 2 }), {
    fetch: async () => {
      calls++;
      if (calls === 1) return new Response(PRIVATE, { status: 429, headers: { "retry-after": "1" } });
      if (calls === 2) return new Response(PRIVATE, { status: 503 });
      return Response.json([PHARMACY]);
    },
    random: () => 0, sleep: async ms => { delays.push(ms); },
  });
  assert.deepEqual(await service.search("Example"), [PHARMACY]);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1125, 250]);
});

test("pharmacy update rejects malformed success receipts as uncertain and never retries", async () => {
  for (const response of [{ ok: false }, null, {}, { ok: true, refillId: "invented" }]) {
    let calls = 0;
    const service = new HttpPharmacyService(config({ maxRetries: 3 }), {
      fetch: async () => { calls++; return Response.json(response); },
      sleep: async () => assert.fail("A mutation must never be retried."),
    });
    await assert.rejects(service.update(PATIENT, PHARMACY.pharmacyId), failure("invalid_response", true));
    assert.equal(calls, 1);
  }
});

test("pharmacy error statuses are sanitized and all updates remain single-attempt", async () => {
  const statuses = [
    [401, "authentication", false], [403, "authentication", false], [404, "not_found", false],
    [400, "rejected", false], [408, "timeout", false], [429, "rate_limit", false],
    [500, "unavailable", true], [503, "unavailable", true],
  ] as const;
  for (const [status, code, uncertain] of statuses) {
    let calls = 0;
    const service = new HttpPharmacyService(config({ maxRetries: 3 }), {
      fetch: async () => { calls++; return new Response(PRIVATE, { status }); },
      sleep: async () => assert.fail("A mutation must never be retried."),
    });
    await assert.rejects(service.update(PATIENT, PHARMACY.pharmacyId), failure(code, uncertain));
    assert.equal(calls, 1);
  }
});

test("pharmacy network failures and body deadlines retain uncertainty without duplicate PUT", async () => {
  let networkCalls = 0;
  const network = new HttpPharmacyService(config({ maxRetries: 3 }), {
    fetch: async () => { networkCalls++; throw new Error(PRIVATE); },
  });
  await assert.rejects(network.update(PATIENT, PHARMACY.pharmacyId), failure("network", true));
  assert.equal(networkCalls, 1);
  let timeoutCalls = 0;
  const timeout = new HttpPharmacyService(config({ timeoutMs: 10, maxRetries: 3 }), {
    fetch: async () => {
      timeoutCalls++;
      return new Response(new ReadableStream({ start() { /* never completes */ } }));
    },
  });
  await assert.rejects(timeout.update(PATIENT, PHARMACY.pharmacyId), failure("timeout", true));
  assert.equal(timeoutCalls, 1);
});

test("directory errors are sanitized and permanent failures never retry", async () => {
  let calls = 0;
  const service = new HttpPharmacyService(config({ maxRetries: 3 }), {
    fetch: async () => { calls++; return new Response(PRIVATE, { status: 403 }); },
    sleep: async () => assert.fail("Permanent errors must not be retried."),
  });
  await assert.rejects(service.search("Example"), failure("authentication"));
  assert.equal(calls, 1);
});
