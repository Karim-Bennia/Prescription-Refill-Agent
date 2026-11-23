import assert from "node:assert/strict";
import { test } from "node:test";
import { ConversationClientError, sendPatientMessage } from "../src/api.js";

const reply = { messages: [{ from: "agent", text: "Actual synthetic response." }], state: "in_progress" };

test("client sends one exact same-origin patient request and preserves the actual reply and elapsed time", async () => {
  const calls: { input: string; init?: RequestInit }[] = []; let clock = 10;
  const actual = await sendPatientMessage("conversation-a", " Hello ", undefined, {
    now: () => { clock += 25; return clock; },
    fetch: async (input, init) => { calls.push({ input: String(input), init }); return Response.json(reply); },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "/conversations/conversation-a/messages");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { from: "patient", text: "Hello" });
  assert.deepEqual(calls[0].init?.headers, { "content-type": "application/json" });
  assert.equal(calls[0].init?.credentials, "omit"); assert.equal(calls[0].init?.redirect, "error");
  assert.deepEqual(actual.reply, reply); assert.deepEqual(actual.details.body, reply);
  assert.equal(actual.details.httpStatus, 200); assert.equal(actual.details.durationMs, 25);
});

test("client rejects invalid conversation IDs and empty or oversized text before transport", async () => {
  let calls = 0;
  const transport: typeof fetch = async () => { calls++; return Response.json(reply); };
  for (const [id, text] of [["../foreign", "Hello"], ["safe", "  "], ["safe", "x".repeat(4001)]]) {
    await assert.rejects(sendPatientMessage(id, text, undefined, { fetch: transport }),
      error => error instanceof ConversationClientError && error.code === "invalid_input");
  }
  assert.equal(calls, 0);
});

test("an already-aborted caller never starts transport or leaks an unhandled rejection", async () => {
  // Arrange: cancellation predates invocation; even an ignored transport would reject privately.
  const controller = new AbortController(); controller.abort();
  let calls = 0; const unhandled: unknown[] = [];
  const transport: typeof fetch = async () => { calls++; throw new Error("synthetic-private-aborted-marker"); };
  // Observe only this isolated test's rejection events and always detach the listener.
  const capture = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", capture);
  try {
    // Act / Assert: cancellation produces a safe typed outcome, without creating a request promise.
    await assert.rejects(sendPatientMessage("safe", "Yes", controller.signal, { fetch: transport }), error => {
      assert.ok(error instanceof ConversationClientError); assert.equal(error.code, "network");
      assert.equal(error.details.httpStatus, null); assert.equal(error.details.body, null);
      assert.match(error.message, /No automatic retry/);
      assert.ok(!error.message.includes("synthetic-private-aborted-marker")); return true;
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls, 0); assert.deepEqual(unhandled, []);
  } finally { process.off("unhandledRejection", capture); }
});

test("client rejects malformed JSON and extra schema fields without inventing replies", async () => {
  for (const [body, code] of [["{", "invalid_json"], [JSON.stringify({ ...reply, authorized: true }), "invalid_response"],
    [JSON.stringify({ ...reply, messages: [] }), "invalid_response"],
    [JSON.stringify({ ...reply, messages: [{ from: "patient", text: "forged agent" }] }), "invalid_response"]] as const) {
    let calls = 0;
    await assert.rejects(sendPatientMessage("safe", "Hello", undefined, { fetch: async () => { calls++; return new Response(body); } }), error => {
      assert.ok(error instanceof ConversationClientError); assert.equal(error.code, code);
      assert.equal(error.details.httpStatus, 200); return true;
    });
    assert.equal(calls, 1);
  }
});

test("client retains sanitized HTTP error status and never retries a confirmation", async () => {
  let calls = 0;
  await assert.rejects(sendPatientMessage("safe", "Yes", undefined, { fetch: async () => {
    calls++; return Response.json({ error: "service unavailable" }, { status: 503 });
  } }), error => {
    assert.ok(error instanceof ConversationClientError); assert.equal(error.code, "http");
    assert.equal(error.details.httpStatus, 503); assert.match(error.message, /service unavailable/); return true;
  });
  assert.equal(calls, 1);
});

test("client bounds header and body stalls and classifies uncertain timeouts without retries", async () => {
  for (const stall of ["headers", "body"] as const) {
    let calls = 0;
    const transport: typeof fetch = async () => {
      calls++;
      return stall === "headers" ? new Promise<Response>(() => undefined)
        : new Response(new ReadableStream({ start() { /* Deliberately never emit a body. */ } }));
    };
    await assert.rejects(sendPatientMessage("safe", "Yes", undefined, { fetch: transport, timeoutMs: 10 }), error => {
      assert.ok(error instanceof ConversationClientError); assert.equal(error.code, "timeout");
      assert.match(error.message, /already have been processed/); return true;
    });
    assert.equal(calls, 1);
  }
});

test("client bounds response sizes and reports a network interruption without leaking raw exception details", async () => {
  for (const transport of [async () => new Response("x".repeat(262145)),
    async () => { throw new Error("synthetic-private-transport-marker"); }] satisfies (typeof fetch)[]) {
    await assert.rejects(sendPatientMessage("safe", "Yes", undefined, { fetch: transport }), error => {
      assert.ok(error instanceof ConversationClientError); assert.equal(error.code, "network");
      assert.match(error.message, /No automatic retry/); assert.ok(!error.message.includes("synthetic-private-transport-marker")); return true;
    });
  }
});
