import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import type { Root } from "react-dom/client";
import App from "../src/App.js";
import type { ConversationOptions } from "../src/useConversation.js";
import { ConversationClientError } from "../src/api.js";
import type { AgentResponse, ConversationReply, SendMessage } from "../src/types.js";

/** Build a synthetic successful transport result without pretending it came from the live agent. */
function response(state: ConversationReply["state"] = "in_progress", text = "Synthetic test reply."): AgentResponse {
  const reply: ConversationReply = { state, messages: [{ from: "agent", text }] };
  return { reply, details: { httpStatus: 200, durationMs: 42, body: reply } };
}

/** Control asynchronous completion to exercise real pending and stale-response behavior. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

/** Mount the real React tree with isolated DOM globals and deterministic external transport. */
async function fixture(t: TestContext, options: ConversationOptions = {}) {
  const window = new Window({ url: "http://127.0.0.1:5173" });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals: Record<string, unknown> = { window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, HTMLTextAreaElement: window.HTMLTextAreaElement, Node: window.Node,
    Event: window.Event, MouseEvent: window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async () => Response.json({ agent: { ok: true }, mock: { ok: true } }) };
  for (const [key, value] of Object.entries(globals)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const container = window.document.createElement("div"); window.document.body.append(container);
  let root: Root = createRoot(container as unknown as HTMLElement);
  t.after(async () => {
    await act(async () => { root.unmount(); }); await window.happyDOM.abort();
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(globalThis, key, original); else Reflect.deleteProperty(globalThis, key);
    }
  });
  await act(async () => { root.render(<App conversationOptions={options} />); });
  /** Enter text through the DOM input event rather than mutating React state directly. */
  async function type(text: string) {
    const input = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  }
  /** Submit the actual form so production event handlers and mutexes are exercised. */
  async function submit(text: string) {
    await type(text);
    await act(async () => { container.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
  }
  /** Activate a rendered control using an ordinary bubbling click. */
  async function click(selector: string) {
    await act(async () => { container.querySelector(selector)!.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
  }
  /** Recreate the screen while an old ignored transport is still pending. */
  async function remount(nextOptions: ConversationOptions) {
    await act(async () => { root.unmount(); });
    root = createRoot(container as unknown as HTMLElement);
    await act(async () => { root.render(<App conversationOptions={nextOptions} />); });
  }
  return { window, container, type, submit, click, remount };
}

test("React renders an empty real-data interface and sends actual typed messages with stable conversation ID", async t => {
  const calls: { id: string; text: string }[] = [];
  const send: SendMessage = async (id, text) => { calls.push({ id, text }); return response(); };
  const f = await fixture(t, { send, createId: () => "test-conversation" });
  assert.match(f.container.textContent!, /Start with a patient message/);
  assert.equal(f.container.querySelectorAll(".message").length, 0);
  assert.equal(f.container.querySelector("#send-message")?.hasAttribute("disabled"), true);
  await f.submit("Hello, synthetic patient request."); await f.submit("A follow-up message.");
  assert.deepEqual(calls, [{ id: "test-conversation", text: "Hello, synthetic patient request." },
    { id: "test-conversation", text: "A follow-up message." }]);
  assert.equal(f.container.querySelectorAll(".message.patient").length, 2);
  assert.equal(f.container.querySelectorAll(".message.agent").length, 2);
  assert.match(f.container.querySelector(".developer-panel")!.textContent!, /HTTP 200 · 42 ms/);
});

test("clear local display preserves session and state; new conversation replaces ID without making an API call", async t => {
  let ids = 0; const calls: string[] = [];
  const f = await fixture(t, { createId: () => `conversation-${++ids}`, send: async id => { calls.push(id); return response("complete"); } });
  await f.submit("Synthetic request"); await f.click("#clear-display");
  assert.equal(f.container.querySelectorAll(".message").length, 0);
  assert.equal(f.container.querySelector("#conversation-id")!.textContent, "conversation-1");
  assert.equal(f.container.querySelector("#conversation-state")!.textContent, "Complete");
  assert.match(f.container.textContent!, /backend session are preserved/);
  await f.submit("Continue existing context"); assert.deepEqual(calls, ["conversation-1", "conversation-1"]);
  await f.click("#new-conversation");
  assert.equal(f.container.querySelector("#conversation-id")!.textContent, "conversation-2");
  assert.equal(f.container.querySelector("#conversation-state")!.textContent, "Not started");
  assert.equal(calls.length, 2);
});

test("pending duplicate submissions and pending reset controls cannot create overlapping requests", async t => {
  const pending = deferred<AgentResponse>(); let calls = 0;
  const f = await fixture(t, { send: async () => { calls++; return pending.promise; } });
  const id = f.container.querySelector("#conversation-id")!.textContent;
  await f.type("Yes, keep my pharmacy.");
  await act(async () => {
    const form = f.container.querySelector("form")!;
    // Two events before React commits a new pending render still reach one transport call.
    form.dispatchEvent(new f.window.Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new f.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  await f.submit("Yes, keep my pharmacy."); await f.click("#new-conversation"); await f.click("#clear-display");
  assert.equal(calls, 1); assert.equal(f.container.querySelector("#conversation-id")!.textContent, id);
  for (const selector of ["#send-message", "#new-conversation", "#clear-display"]) assert.equal(f.container.querySelector(selector)!.hasAttribute("disabled"), true);
  await act(async () => { pending.resolve(response("complete")); });
  assert.equal(f.container.querySelector("#conversation-state")!.textContent, "Complete");
  assert.equal(f.container.querySelectorAll(".message.agent").length, 1);
});

test("an obsolete response cannot contaminate a remounted fresh conversation", async t => {
  const old = deferred<AgentResponse>();
  const f = await fixture(t, { createId: () => "old-id", send: async () => old.promise });
  await f.submit("Old synthetic turn");
  await f.remount({ createId: () => "fresh-id", send: async () => response("in_progress", "Fresh response") });
  await f.submit("Fresh synthetic turn");
  await act(async () => { old.resolve(response("complete", "Obsolete reply must never be shown")); });
  assert.equal(f.container.querySelector("#conversation-id")!.textContent, "fresh-id");
  assert.equal(f.container.querySelector("#conversation-state")!.textContent, "In progress");
  assert.ok(!f.container.textContent!.includes("Obsolete reply")); assert.match(f.container.textContent!, /Fresh response/);
});

test("HTTP, invalid response and network failures render UI notices rather than fabricated agent replies", async t => {
  let next: Error = new Error("synthetic-private-exception");
  const f = await fixture(t, { send: async () => { throw next; } });
  await f.submit("First synthetic turn");
  assert.equal(f.container.querySelectorAll(".message.agent").length, 0);
  assert.match(f.container.textContent!, /already have been processed/); assert.ok(!f.container.textContent!.includes("synthetic-private-exception"));
  for (const code of ["http", "invalid_json", "invalid_response"] as const) {
    next = new ConversationClientError(code, { httpStatus: 502, durationMs: 11, body: { error: "Safe synthetic failure" } }, "Safe synthetic failure; verify before resending.");
    await f.submit(`Synthetic failure ${code}`);
  }
  assert.equal(f.container.querySelectorAll(".message.agent").length, 0);
  assert.equal(f.container.querySelectorAll(".message.notice").length, 4);
  assert.match(f.container.querySelector(".developer-panel")!.textContent!, /HTTP 502/);
});

test("actual complete and escalated states render without interpreting submission or human-contact outcomes", async t => {
  let result = response("complete", "Synthetic cancellation response");
  const f = await fixture(t, { send: async () => result });
  await f.submit("Synthetic cancellation");
  assert.equal(f.container.querySelector("#conversation-state")!.textContent, "Complete");
  assert.match(f.container.textContent!, /Synthetic cancellation response/);
  await f.click("#new-conversation"); result = response("escalated", "Synthetic clinical restriction");
  await f.submit("Synthetic blocked request");
  assert.equal(f.container.querySelector("#conversation-state")!.textContent, "Escalated");
  assert.match(f.container.textContent!, /clinician contact is not assumed/);
});

test("patient and agent markup remain escaped text and empty or oversized sends are rejected by the hook", async t => {
  const markup = "<img src=x onerror=alert(1)>"; let calls = 0;
  const f = await fixture(t, { send: async () => { calls++; return response("in_progress", markup); } });
  await f.submit("   "); assert.equal(calls, 0);
  await f.submit("x".repeat(4001)); assert.equal(calls, 0);
  await f.submit(markup); assert.equal(calls, 1);
  assert.equal(f.container.querySelector("img"), null);
  assert.equal(f.container.querySelector(".message.patient .bubble")!.textContent, markup);
  assert.equal(f.container.querySelector(".message.agent .bubble")!.textContent, markup);
  assert.equal(f.container.querySelector("textarea")!.maxLength, 4000);
});
