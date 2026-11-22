import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentServer } from "../agent/http-server.js";
import { createSafeHttpObserver, type HttpObservation } from "../agent/observability.js";

test("HTTP correlation is server-generated and observation contains no patient input or error details", async t => {
  const lines: string[] = [];
  let fail = false;
  const server = createAgentServer({ handleTurn: async () => {
    if (fail) throw new Error("synthetic-private-error-detail");
    return { state: "in_progress", messages: [{ from: "agent", text: "synthetic-private-response" }] };
  } }, { observe: createSafeHttpObserver(line => { lines.push(line); }) });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const send = () => fetch(`${base}/conversations/synthetic-private-routing-id/messages`, { method: "POST",
    headers: { "content-type": "application/json", "x-request-id": "caller-controlled-id", authorization: "Bearer synthetic-private-token" },
    body: JSON.stringify({ from: "patient", text: "synthetic-private-conversation-content" }) });
  const normal = await send(); await normal.json();
  assert.equal(normal.status, 200);
  const requestId = normal.headers.get("x-request-id");
  assert.match(requestId ?? "", /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[\da-f]{4}-[\da-f]{12}$/i);
  assert.notEqual(requestId, "caller-controlled-id");
  fail = true;
  const failure = await send(); await failure.json(); assert.equal(failure.status, 503);
  assert.notEqual(failure.headers.get("x-request-id"), requestId);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(lines.length, 2);
  const events = lines.map(line => JSON.parse(line) as HttpObservation);
  assert.equal(events[0].requestId, requestId);
  assert.deepEqual(events.map(event => [event.status, event.category]), [[200, "conversation"], [503, "service_unavailable"]]);
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), ["event", "requestId", "status", "category", "durationMs"].sort());
    assert.equal(event.event, "http_request"); assert.ok(Number.isFinite(event.durationMs) && event.durationMs >= 0);
  }
  for (const value of ["synthetic-private", "caller-controlled-id", "/conversations", "Bearer"]) assert.ok(!lines.join("\n").includes(value));
});

test("invalid observation metadata cannot introduce sensitive fields into logs", () => {
  const lines: string[] = [];
  const observe = createSafeHttpObserver(line => { lines.push(line); });
  const valid = { event: "http_request", requestId: "a5d7debe-a0d0-478c-9c29-ef4e9729365e", status: 503,
    category: "service_unavailable", durationMs: 12 } as const;
  observe({ ...valid, patientId: "synthetic-private-patient" } as never);
  observe({ ...valid, category: "synthetic-private-error" } as never);
  observe({ ...valid, requestId: "synthetic-private-token" });
  observe({ ...valid, durationMs: Infinity });
  assert.deepEqual(lines, []);
  observe(valid); assert.equal(lines.length, 1);
});

test("an unavailable observation sink never changes HTTP or patient outcomes", async t => {
  const server = createAgentServer({ handleTurn: async () => ({ state: "complete", messages: [{ from: "agent", text: "Synthetic complete outcome" }] }) },
    { observe: () => { throw new Error("synthetic logging outage"); } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const result = await fetch(`http://127.0.0.1:${address.port}/conversations/safe/messages`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "patient", text: "hello" }) });
  assert.equal(result.status, 200); assert.equal((await result.json()).state, "complete");
  assert.doesNotThrow(() => createSafeHttpObserver(() => { throw new Error("sink outage"); })({
    event: "http_request", requestId: "a5d7debe-a0d0-478c-9c29-ef4e9729365e", status: 200, category: "health", durationMs: 0,
  }));
});

test("asynchronous diagnostic failures cannot become unhandled application errors", { timeout: 5000 }, async t => {
  const server = createAgentServer({ handleTurn: async () => ({ state: "in_progress", messages: [{ from: "agent", text: "Synthetic reply" }] }) },
    { observe: async () => { throw new Error("Synthetic asynchronous observer outage"); } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
  assert.equal(response.status, 200); await response.json();
  createSafeHttpObserver(async () => { throw new Error("Synthetic asynchronous log outage"); })({
    event: "http_request", requestId: "a5d7debe-a0d0-478c-9c29-ef4e9729365e", status: 200, category: "health", durationMs: 0,
  });
  await new Promise<void>(resolve => setImmediate(resolve));
});
