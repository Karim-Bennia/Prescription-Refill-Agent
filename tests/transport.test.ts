import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { test, type TestContext } from "node:test";
import { createAgentServer, type TurnHandler } from "../agent/http-server.js";
import { parseConversationId, replySchema, requestSchema, type AgentReply } from "../agent/validation.js";

const REPLY: AgentReply = {
  messages: [{ from: "agent", text: "Please provide your identity information." }], state: "in_progress",
};

async function fixture(t: TestContext, handler: TurnHandler, bodyTimeoutMs?: number): Promise<string> {
  const server = createAgentServer(handler, { bodyTimeoutMs });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

function post(base: string, body: unknown, id = "conversation-1"): Promise<Response> {
  return fetch(`${base}/conversations/${id}/messages`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

test("conversation schemas accept only exact documented literals and bounded identifiers", () => {
  assert.deepEqual(requestSchema.parse({ from: "patient", text: " Hello " }), { from: "patient", text: "Hello" });
  assert.deepEqual(replySchema.parse(REPLY), REPLY);
  assert.equal(parseConversationId("conformance-1"), "conformance-1");
  assert.equal(parseConversationId("A".repeat(128)), "A".repeat(128));
  for (const id of ["", "A".repeat(129), "../patient", "patient/name", "__proto__", "patient name", "患者"]) {
    assert.throws(() => parseConversationId(id), /Invalid conversation input/);
  }
});

test("HTTP route validates patient input and returns the exact conversation response", async t => {
  // Arrange
  const calls: [string, string][] = [];
  const base = await fixture(t, { handleTurn: async (id, text) => { calls.push([id, text]); return REPLY; } });
  // Act
  const response = await post(base, { from: "patient", text: "  A refill request  " }, "thread.42_1");
  // Assert
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), REPLY);
  assert.deepEqual(calls, [["thread.42_1", "A refill request"]]);
});

test("health route is ready without invoking conversation or model dependencies", async t => {
  let calls = 0;
  const base = await fixture(t, { handleTurn: async () => { calls++; return REPLY; } });
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(calls, 0);
});

test("malformed patient requests are rejected without executing a turn", async t => {
  let calls = 0;
  const base = await fixture(t, { handleTurn: async () => { calls++; return REPLY; } });
  const bodies: unknown[] = [
    {}, null, [], "message", { from: "agent", text: "hello" }, { from: "patient" },
    { from: "patient", text: "" }, { from: "patient", text: " \n\t " },
    { from: "patient", text: 123 }, { from: "patient", text: "x".repeat(4001) },
    { from: "patient", text: "hello", patientId: "foreign-patient" },
    { from: "patient", text: "hello", state: "complete" },
  ];
  for (const body of bodies) {
    const response = await post(base, body);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid request" });
  }
  assert.equal(calls, 0);
});

test("malformed JSON does not crash the listener or echo sensitive request content", async t => {
  let calls = 0;
  const base = await fixture(t, { handleTurn: async () => { calls++; return REPLY; } });
  const response = await fetch(`${base}/conversations/conversation-1/messages`, {
    method: "POST", body: '{"from":"patient","text":"synthetic-private-marker"',
  });
  assert.equal(response.status, 400);
  const body = await response.text();
  assert.ok(!body.includes("synthetic-private-marker"));
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal(calls, 0);
});

test("oversized bodies are bounded before reaching conversation processing", async t => {
  let calls = 0;
  const base = await fixture(t, { handleTurn: async () => { calls++; return REPLY; } });
  const response = await post(base, { from: "patient", text: "x".repeat(17_000) });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "request too large" });
  assert.equal(calls, 0);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test("invalid encoded conversation identifiers fail before a turn is executed", async t => {
  let calls = 0;
  const base = await fixture(t, { handleTurn: async () => { calls++; return REPLY; } });
  for (const id of ["", "%ZZ", "%2Fforeign", "%5Fprivate", "foreign%20patient", "x".repeat(129)]) {
    const response = await post(base, { from: "patient", text: "hello" }, id);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid request" });
  }
  assert.equal(calls, 0);
});

test("unsupported routes and methods have deterministic status and Allow headers", async t => {
  let calls = 0;
  const base = await fixture(t, { handleTurn: async () => { calls++; return REPLY; } });
  const unknown = await fetch(`${base}/unimplemented`);
  assert.equal(unknown.status, 404);
  const wrongConversationMethod = await fetch(`${base}/conversations/conversation-1/messages`);
  assert.equal(wrongConversationMethod.status, 405);
  assert.equal(wrongConversationMethod.headers.get("allow"), "POST");
  const wrongHealthMethod = await fetch(`${base}/healthz`, { method: "POST" });
  assert.equal(wrongHealthMethod.status, 405);
  assert.equal(wrongHealthMethod.headers.get("allow"), "GET");
  assert.equal(calls, 0);
});

test("unexpected handler failures return sanitized errors and keep the listener available", async t => {
  const base = await fixture(t, { handleTurn: async () => {
    throw new Error("synthetic-secret-token and patient demographics must stay private");
  } });
  const response = await post(base, { from: "patient", text: "hello" });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "service unavailable" });
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test("invalid handler output is never sent to the patient", async t => {
  const invalid = {
    messages: [{ from: "agent", text: "private-marker" }], state: "authenticated", patientId: "foreign-patient",
  } as unknown as AgentReply;
  const base = await fixture(t, { handleTurn: async () => invalid });
  const response = await post(base, { from: "patient", text: "hello" });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "service unavailable" });
});

test("a stalled request body reaches its deadline without invoking the handler", async t => {
  let calls = 0;
  const base = await fixture(t, { handleTurn: async () => { calls++; return REPLY; } }, 25);
  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const pending = httpRequest(`${base}/conversations/conversation-1/messages`, { method: "POST" }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    pending.on("error", reject);
    t.after(() => pending.destroy());
    pending.write('{"from":"patient",');
  });
  assert.equal(response.status, 408);
  assert.deepEqual(JSON.parse(response.body), { error: "request timed out" });
  assert.equal(calls, 0);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test("an interrupted request body does not cause an unhandled error or execute a turn", async t => {
  let calls = 0;
  const base = await fixture(t, { handleTurn: async () => { calls++; return REPLY; } });
  await new Promise<void>(resolve => {
    const pending = httpRequest(`${base}/conversations/interrupted/messages`, { method: "POST" });
    pending.on("error", () => undefined);
    pending.once("socket", socket => {
      socket.once("connect", () => {
        pending.write('{"from":"patient","text":"partial');
        setTimeout(() => pending.destroy(), 20);
      });
    });
    pending.once("close", () => resolve());
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls, 0);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});
