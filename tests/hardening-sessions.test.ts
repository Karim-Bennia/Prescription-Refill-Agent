import assert from "node:assert/strict";
import { test } from "node:test";
import { ClinicalEhrError } from "../agent/clinical-ehr.js";
import { InMemorySessionRepository, type SessionRepository } from "../agent/sessions.js";
import { evaluationFixture } from "./evaluation-fixtures.js";
import { createAgentServer } from "../agent/http-server.js";
import { replySchema } from "../agent/validation.js";

test("expiry after a failed action-result commit never denies an earlier accepted or uncertain refill", async t => {
  for (const outcome of ["accepted", "uncertain"] as const) await t.test(outcome, async () => {
    let now = 0;
    let failCommit = false;
    const inner = new InMemorySessionRepository({ now: () => now, ttlMs: 100 });
    const sessions: SessionRepository = { run: (id, operation) => inner.run(id, async (state, context) => {
      const update = await operation(state, context);
      if (failCommit) { failCommit = false; throw new Error("Synthetic interrupted session commit"); }
      return update;
    }) };
    const f = evaluationFixture({ sessions, ehr: outcome === "uncertain" ? {
      submitRefill: async () => { throw new ClinicalEhrError("timeout", { uncertain: true }); },
    } : undefined });
    await f.authenticate();
    failCommit = true;
    await assert.rejects(f.turn("Yes"));
    assert.equal(f.calls.filter(call => call.operation === "submit").length, 1);
    now = 100;

    const reply = await f.turn("Yes, keep my pharmacy.");

    assert.equal(reply.state, "escalated");
    assert.doesNotMatch(reply.messages.map(message => message.text).join(" "), /No refill has been submitted/i);
    assert.equal(f.calls.filter(call => call.operation === "submit").length, 1);
  });
});

test("a second HTTP client can continue a known routing ID because the contract has no caller principal", async t => {
  const fixture = evaluationFixture(); const server = createAgentServer(fixture.engine);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const send = async (client: string, text: string) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/conversations/known-routing-id/messages`, { method: "POST",
      headers: { "content-type": "application/json", "user-agent": client }, body: JSON.stringify({ from: "patient", text }) });
    assert.equal(response.status, 200); return replySchema.parse(await response.json());
  };
  await send("synthetic-client-a", "Refill Examplemed 10mg.");
  await send("synthetic-client-a", "Morgan Vale, DOB 1990-01-02, phone ending 4321.");
  const continuation = await send("synthetic-client-b", "Yes, keep my pharmacy.");
  assert.equal(continuation.state, "complete");
  assert.equal(fixture.calls.filter(call => call.operation === "match").length, 1);
  assert.deepEqual(fixture.mutations(), [{ operation: "submit", patientId: "synthetic-patient-a", medId: "owned-med-a" }]);
  t.diagnostic("Residual API limitation: routing-ID possession permits continuation; patient binding does not prove independently authenticated caller ownership.");
});
