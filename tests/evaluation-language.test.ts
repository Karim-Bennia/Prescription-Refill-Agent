import assert from "node:assert/strict";
import { test } from "node:test";
import { GroqLanguageInterpreter } from "../agent/llm-client.js";
import { interpretMessage } from "../agent/interpretation.js";
import type { Interpretation } from "../agent/intent.js";
import { evaluationFixture, EVALUATION_ENV } from "./evaluation-fixtures.js";

const proposal = (changes: Partial<Interpretation> = {}): Interpretation => ({
  intent: "other", identity: { firstName: null, lastName: null, dob: null, phoneLast4: null, zip: null },
  medicationQuery: null, pharmacyQuery: null, clarification: "request", ...changes,
});
const envelope = (content: unknown) => Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }] });
const config = { apiKey: EVALUATION_ENV.GROQ_API_KEY, model: "openai/gpt-oss-120b", timeoutMs: 100, maxRetries: 0 };

test("labeled offline interpretation replay measures adapter agreement, not live model accuracy", async t => {
  const cases: { text: string; expected: Interpretation["intent"]; response: Interpretation }[] = [
    { text: "Could I renew Examplemed 10mg?", expected: "refill_request", response: proposal({ intent: "refill_request", medicationQuery: "Examplemed 10mg", clarification: "identity" }) },
    { text: "My surname is Vale", expected: "identity_information", response: proposal({ intent: "identity_information", identity: { ...proposal().identity, lastName: "Vale" }, clarification: "identity" }) },
    { text: "Please keep my pharmacy", expected: "keep_pharmacy", response: proposal({ intent: "keep_pharmacy", clarification: "none" }) },
    { text: "I want the pharmacy on Lake Road", expected: "change_pharmacy", response: proposal({ intent: "change_pharmacy", pharmacyQuery: "Lake Road", clarification: "pharmacy" }) },
    { text: "Yes, please", expected: "affirm", response: proposal({ intent: "affirm", clarification: "none" }) },
    { text: "No, thanks", expected: "deny", response: proposal({ intent: "deny", clarification: "pharmacy" }) },
    { text: "Cancel this request", expected: "cancel", response: proposal({ intent: "cancel", clarification: "none" }) },
    { text: "What are your opening hours?", expected: "other", response: proposal() },
  ];
  let matches = 0;
  for (const entry of cases) {
    let requests = 0;
    const adapter = new GroqLanguageInterpreter(config, { fetch: async (_url, init) => {
      requests++;
      const request = JSON.parse(String(init?.body));
      assert.equal(request.messages.find((item: { role: string }) => item.role === "user").content, entry.text);
      assert.equal(request.tools, undefined);
      return envelope(entry.response);
    } });
    const result = await interpretMessage(adapter, entry.text);
    matches += Number(result.interpretation.intent === entry.expected);
    assert.equal(requests, 1);
  }
  assert.equal(matches, cases.length);
  t.diagnostic(`Offline labeled replay: ${matches}/${cases.length} adapter-label agreements; genuine model classification accuracy not measured (responses are fixed synthetic fixtures).`);
});

test("invalid and unavailable model completions fail safely through the complete conversation engine", async t => {
  const responses: [string, () => Promise<Response>][] = [
    ["missing fields", async () => envelope({ intent: "affirm" })],
    ["invalid JSON", async () => new Response("truncated-json", { status: 200 })],
    ["unsupported intent", async () => envelope({ ...proposal(), intent: "submit_refill" })],
    ["conflicting intent type", async () => envelope({ ...proposal(), intent: ["affirm", "deny"] })],
    ["fabricated prescription ID", async () => envelope({ ...proposal(), medId: "not-owned" })],
    ["fabricated pharmacy ID", async () => envelope({ ...proposal(), pharmacyId: "not-listed" })],
    ["empty model content", async () => Response.json({ choices: [{ finish_reason: "stop", message: { content: "" } }] })],
    ["truncated completion", async () => Response.json({ choices: [{ finish_reason: "length", message: { content: JSON.stringify(proposal()) } }] })],
    ["unexpected success body", async () => Response.json({ ok: true })],
    ["rate limit", async () => new Response("synthetic diagnostic", { status: 429 })],
    ["unavailable model", async () => new Response("synthetic diagnostic", { status: 404 })],
    ["provider unavailable", async () => new Response("synthetic diagnostic", { status: 503 })],
    ["timeout", () => new Promise<Response>(() => {})],
  ];
  let rejected = 0;
  for (const [name, response] of responses) await t.test(name, async () => {
    let requests = 0;
    const adapter = new GroqLanguageInterpreter({ ...config, timeoutMs: 10 }, { fetch: async () => { requests++; return response(); } });
    const fixture = evaluationFixture({ interpreter: adapter });
    const reply = await fixture.turn("Help me with a prescription renewal please");
    assert.equal(reply.state, "in_progress");
    assert.match(reply.messages[0].text, /could not interpret.*safely/i);
    assert.deepEqual(fixture.calls.map(call => call.operation), ["model"]);
    assert.deepEqual(fixture.mutations(), []);
    assert.equal(requests, 1);
    assert.ok(!reply.messages[0].text.includes(EVALUATION_ENV.GROQ_API_KEY));
    // A fresh deterministic turn remains usable after the rejected model output.
    await fixture.authenticate();
    assert.equal((await fixture.state()).phase, "awaiting_pharmacy_confirmation");
    rejected++;
  });
  t.diagnostic(`Model fault evaluation: ${rejected}/${responses.length} failures safely handled, zero protected operations before authentication, zero unauthorized mutations.`);
});

test("every supported explicit confirmation phrase reaches the guarded production refill workflow", async () => {
  for (const text of ["Yes", "Yes, please", "Yes, keep my pharmacy.", "I confirm", "confirm"]) {
    const fixture = evaluationFixture(); await fixture.authenticate();
    const reply = await fixture.turn(text);
    assert.equal(reply.state, "complete", text);
    assert.deepEqual(fixture.mutations().map(call => call.operation), ["submit"], text);
    assert.equal(fixture.calls.filter(call => call.operation === "model").length, 0);
  }
});
