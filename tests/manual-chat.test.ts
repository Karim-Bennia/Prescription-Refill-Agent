import assert from "node:assert/strict";
import { test } from "node:test";
import { request as httpRequest } from "node:http";
import { EventEmitter } from "node:events";
import { createFrontendServer } from "../frontend/server.js";
import { serviceEnvironment, agentServiceEnvironment, startLocalServices, type LocalServiceDependencies } from "../scripts/local-services.js";

const reply = { messages: [{ from: "agent", text: "Synthetic transport fixture." }], state: "in_progress" };

test("paired development services never inherit real keys, auth tokens or injected Node flags into the mock", () => {
  const original = { PATH: "synthetic-path", GROQ_API_KEY: "synthetic-private-marker", EHR_API_KEY: "old-ehr-marker",
    PHARMACY_API_KEY: "old-pharmacy-marker", NODE_OPTIONS: "--synthetic-private-flag", SIM_NOW: "unexpected-clock" };
  const actual = serviceEnvironment(original, "temporary-ehr", "temporary-pharmacy");
  assert.deepEqual(actual, { PATH: "synthetic-path", EHR_API_KEY: "temporary-ehr", PHARMACY_API_KEY: "temporary-pharmacy" });
  assert.equal(original.GROQ_API_KEY, "synthetic-private-marker");
});

test("the paired launcher supports caller model configuration only in the agent child", () => {
  const original = { GROQ_API_KEY: "synthetic-model-marker", LLM_MODEL: "synthetic/model", REQUEST_TIMEOUT_MS: "12000",
    LLM_MAX_RETRIES: "0", EHR_API_KEY: "old-service-marker", NODE_OPTIONS: "--private-test-marker" };
  const agent = agentServiceEnvironment(original, "temporary-ehr", "temporary-pharmacy");
  const mock = serviceEnvironment(original, "temporary-ehr", "temporary-pharmacy");
  assert.equal(agent.GROQ_API_KEY, original.GROQ_API_KEY);
  assert.equal(agent.LLM_MODEL, original.LLM_MODEL);
  assert.equal(agent.REQUEST_TIMEOUT_MS, "12000");
  assert.equal(agent.EHR_API_KEY, "temporary-ehr");
  assert.equal(agent.NODE_OPTIONS, undefined);
  assert.equal(mock.GROQ_API_KEY, undefined);
  assert.equal(mock.LLM_MODEL, undefined);
});

class LauncherChild extends EventEmitter {
  readonly pid = 100;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killCalls = 0;
  /** Simulate termination of an owned fixture child without starting a real process. */
  kill(): boolean { this.killCalls++; this.exitCode = 0; this.emit("exit", 0, null); return true; }
}

/** Supply isolated lifecycle effects so launcher regressions need no fixed ports, processes or credentials. */
function launcherFixture(onLaunch?: (child: LauncherChild, file: string) => void) {
  const children: LauncherChild[] = [];
  const dependencies: LocalServiceDependencies = {
    checkPort: async () => undefined,
    launch: file => { const child = new LauncherChild(); children.push(child); onLaunch?.(child, file); return child; },
    fetch: async () => Response.json({ ok: true }),
  };
  return { children, dependencies };
}

test("launcher rejects a startup child error without exposing its original message", async () => {
  // Arrange: emit after launch listeners attach, while the readiness request is in progress.
  const fixture = launcherFixture(child => queueMicrotask(() => child.emit("error", new Error("synthetic-private-spawn-marker"))));
  // Act / Assert
  await assert.rejects(startLocalServices({}, fixture.dependencies), error => {
    assert.ok(error instanceof Error); assert.match(error.message, /service.*unexpectedly/iu);
    assert.ok(!error.message.includes("synthetic-private-spawn-marker")); return true;
  });
  assert.equal(fixture.children.length, 1); assert.equal(fixture.children[0].killCalls, 1);
});

test("launcher rejects an unexpected runtime child exit and stops its other owned service", async () => {
  // Arrange
  const fixture = launcherFixture();
  // Act / Assert
  await assert.rejects(startLocalServices({ onReady: () => {
    fixture.children[0].exitCode = 23; fixture.children[0].emit("exit", 23, null);
  } }, fixture.dependencies), /service.*unexpectedly/iu);
  assert.equal(fixture.children.length, 2); assert.equal(fixture.children[1].killCalls, 1);
});

test("launcher treats explicit cancellation as a clean shutdown and stops both owned services", async () => {
  // Arrange
  const fixture = launcherFixture(); const controller = new AbortController();
  // Act
  await startLocalServices({ signal: controller.signal, onReady: () => controller.abort() }, fixture.dependencies);
  // Assert
  assert.equal(fixture.children.length, 2); assert.ok(fixture.children.every(child => child.killCalls === 1));
});

async function fixture(t: { after(fn: () => Promise<void>): unknown }, transport: typeof fetch, timeoutMs = 1000) {
  const server = createFrontendServer({ fetch: transport, upstreamTimeoutMs: timeoutMs });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const send = (body: unknown, id = "manual-test", headers: Record<string, string> = {}) => fetch(`${base}/conversations/${id}/messages`, {
    method: "POST", headers: { "content-type": "application/json", origin: base, ...headers }, body: JSON.stringify(body),
  });
  return { server, base, send };
}

test("manual proxy preserves the exact conversation route, identity continuity, body and actual agent response", async t => {
  // Arrange
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = await fixture(t, async (url, init) => { calls.push({ url: String(url), init }); return Response.json(reply); });
  // Act
  const first = await f.send({ from: "patient", text: "Hello" }, "session-a");
  const second = await f.send({ from: "patient", text: "Follow-up" }, "session-a");
  const independent = await f.send({ from: "patient", text: "New patient conversation" }, "session-b");
  // Assert: the tester never rewrites a patient's session or makes another request on their behalf.
  assert.deepEqual(await first.json(), reply); assert.equal(second.status, 200); assert.equal(independent.status, 200);
  assert.deepEqual(calls.map(call => call.url), ["http://127.0.0.1:5050/conversations/session-a/messages",
    "http://127.0.0.1:5050/conversations/session-a/messages", "http://127.0.0.1:5050/conversations/session-b/messages"]);
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { from: "patient", text: "Follow-up" });
  assert.equal(first.headers.get("access-control-allow-origin"), null);
});

test("manual proxy never forwards client credentials, cookies or privileged request fields", async t => {
  let init: RequestInit | undefined;
  const f = await fixture(t, async (_url, options) => { init = options; return Response.json(reply); });
  const response = await f.send({ from: "patient", text: "Hi" }, "credential-boundary", {
    authorization: "synthetic-client-marker", cookie: "synthetic-cookie-marker", "x-forwarded-host": "untrusted.invalid",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(init?.headers, { "content-type": "application/json" });
  assert.equal(init?.redirect, "error");
  const rejected = await f.send({ from: "patient", text: "Hi", patientId: "forged" });
  assert.equal(rejected.status, 400);
});

test("manual proxy rejects foreign Host, Origin, null origin and cross-site requests before forwarding", async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return Response.json(reply); });
  const forbiddenHeaders: Record<string, string>[] = [{ host: "untrusted.invalid" }, { origin: "https://untrusted.invalid" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }];
  for (const headers of forbiddenHeaders) {
    // Node's fetch may normalize forbidden browser headers such as Host. Raw HTTP tests the actual wire boundary.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${f.base}/conversations/origin-boundary/messages`, { method: "POST",
        headers: { "content-type": "application/json", origin: f.base, ...headers } }, response => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
      request.once("error", reject); request.end(JSON.stringify({ from: "patient", text: "Hi" }));
    });
    assert.equal(status, 403, JSON.stringify(headers));
  }
  assert.equal(calls, 0);
});

test("manual proxy exposes no environment, EHR, reset, directory or arbitrary destination routes", async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return Response.json(reply); });
  for (const path of ["/.env", "/server.ts", "/ehr/patients/patient", "/__reset", "/pharmacy/directory", "/?url=https://untrusted.invalid"]) {
    assert.equal((await fetch(f.base + path)).status, 404);
  }
  assert.equal((await fetch(`${f.base}/conversations/a/messages`)).status, 405);
  assert.equal(calls, 0);
});

test("manual proxy validates malformed, oversized and incorrect patient messages without upstream calls", async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return Response.json(reply); });
  assert.equal((await f.send({ from: "agent", text: "Hi" })).status, 400);
  assert.equal((await f.send({ from: "patient", text: "" })).status, 400);
  assert.equal((await f.send({ from: "patient", text: "a".repeat(17_000) })).status, 413);
  assert.equal((await f.send({ from: "patient", text: "Hi" }, "bad%2Fidentifier")).status, 400);
  const malformed = await fetch(`${f.base}/conversations/a/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  assert.equal(malformed.status, 400);
  const unsupported = await fetch(`${f.base}/conversations/a/messages`, { method: "POST", body: "text" });
  assert.equal(unsupported.status, 415); assert.equal(calls, 0);
});

test("manual proxy preserves sanitized actual agent HTTP errors rather than claiming conversation success", async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return Response.json({ error: "service unavailable" }, { status: 503 }); });
  const response = await f.send({ from: "patient", text: "Yes" });
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "service unavailable" }); assert.equal(calls, 1);
});

test("invalid and oversized upstream data is not reflected and never triggers another POST", async t => {
  const cases = [() => Response.json({ ...reply, secret: "synthetic-sensitive-marker" }),
    () => Response.json({ error: "synthetic-sensitive-marker" }, { status: 500 }),
    () => new Response("synthetic-sensitive-marker".repeat(30_000))];
  for (const result of cases) {
    let calls = 0;
    const f = await fixture(t, async () => { calls++; return result(); });
    const response = await f.send({ from: "patient", text: "Yes" });
    assert.equal(response.status, 502);
    const body = await response.text(); assert.ok(!body.includes("synthetic-sensitive-marker")); assert.ok(body.includes("unknown"));
    assert.equal(calls, 1);
  }
});

test("upstream timeout remains an explicitly unknown outcome with one attempt", async t => {
  let calls = 0;
  const f = await fixture(t, async (_url, init) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("Synthetic timeout")), { once: true }));
  }, 25);
  const response = await f.send({ from: "patient", text: "Yes" });
  assert.equal(response.status, 504); assert.equal((await response.json()).outcome, "unknown"); assert.equal(calls, 1);
});

test("agent connection failures are sanitized and not retried", async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; throw new Error("synthetic-private-network-marker"); });
  const response = await f.send({ from: "patient", text: "Yes" });
  assert.equal(response.status, 502); const body = await response.json(); assert.equal(body.outcome, "unknown");
  assert.ok(!JSON.stringify(body).includes("synthetic-private-network-marker")); assert.equal(calls, 1);
});

test("service status distinguishes agent and mock reachability without accessing patient data", async t => {
  const calls: string[] = [];
  const f = await fixture(t, async url => { calls.push(String(url)); if (String(url).includes(":4010/")) throw new Error("Synthetic offline mock"); return Response.json({ ok: true }); });
  const response = await fetch(`${f.base}/status`);
  assert.deepEqual(await response.json(), { agent: { ok: true, status: 200 }, mock: { ok: false, status: null } });
  assert.deepEqual(calls.sort(), ["http://127.0.0.1:4010/healthz", "http://127.0.0.1:5050/healthz"]);
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/u);
  assert.equal(response.headers.get("cache-control"), "no-store");
});
