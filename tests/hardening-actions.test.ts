import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemorySessionRepository, type SessionRepository } from "../agent/sessions.js";
import { ClinicalEhrError } from "../agent/clinical-ehr.js";
import { evaluationFixture, medication } from "./evaluation-fixtures.js";

test("a retained refill receipt must not be reported as a submission to a subsequently changed pharmacy", async () => {
  // Arrange: the EHR accepts the refill but the local conversation commit fails once.
  const repository = new InMemorySessionRepository();
  let rejectCommit = false;
  const sessions: SessionRepository = { run: (id, operation) => repository.run(id, async (state, context) => {
    const update = await operation(state, context);
    if (rejectCommit) { rejectCommit = false; throw new Error("Synthetic commit interruption"); }
    return update;
  }) };
  const initial = { pharmacyId: "synthetic-destination-a", name: "Synthetic Alpha Pharmacy", address: "10 Example Road" };
  const replacement = { pharmacyId: "synthetic-destination-b", name: "Synthetic Beta Pharmacy", address: "20 Example Road" };
  const fixture = evaluationFixture({ sessions, pharmacy: { pharmacyId: initial.pharmacyId, name: initial.name },
    directory: [initial, replacement] });
  await fixture.authenticate(); rejectCommit = true;
  await assert.rejects(fixture.turn("Yes, keep my pharmacy."));
  assert.equal(fixture.mutations().filter(call => call.operation === "submit").length, 1);
  assert.equal(fixture.mutations().filter(call => call.operation === "update").length, 0,
    "A retained refill outcome must be recovered before allowing a new pharmacy mutation");

  // Act: after the interrupted response, a new pharmacy request must not relabel old evidence.
  await fixture.turn("Show me available pharmacies.");
  await fixture.turn("Use the second one.");
  await fixture.turn("Yes");
  const recovered = await fixture.turn("Yes, keep my pharmacy.");

  // Assert both actual effects and the destination represented by the retained receipt.
  assert.equal(recovered.state, "complete");
  assert.equal(fixture.mutations().filter(call => call.operation === "submit").length, 1);
  assert.equal(fixture.mutations().filter(call => call.operation === "update").length, 0);
  const stored = await fixture.state();
  assert.equal(stored.phase, "refill_submitted");
  if (stored.phase === "refill_submitted") assert.equal(stored.pharmacyId, initial.pharmacyId);
  assert.ok(!recovered.messages.some(message => message.text.includes(`at ${replacement.name}:`)),
    "An original-destination receipt must not be described as submission to the replacement pharmacy");
});

test("the upstream contract cannot make clinical rereads atomic with refill submission", async t => {
  // This deliberately documents the unsupported compare-and-submit guarantee, not desired production behavior.
  const fixture = evaluationFixture(); await fixture.authenticate();
  let pharmacyReads = 0;
  fixture.hooks.ehr.pharmacy = async () => {
    pharmacyReads++;
    // First read confirms consent; the second is the final pharmacy check after the clinical read.
    if (pharmacyReads === 2) fixture.records.medications = [medication({ refillsRemaining: 0 })];
    return fixture.records.pharmacy;
  };
  const reply = await fixture.turn("Yes");
  assert.equal(reply.state, "complete");
  assert.equal(fixture.records.medications[0].refillsRemaining, 0);
  assert.equal(fixture.mutations().filter(call => call.operation === "submit").length, 1);
  t.diagnostic("Residual contract limitation: a clinical change after the last clinical snapshot can race POST; the API supplies no version, conditional write, or atomic eligibility operation.");
});

test("terminal receipt replay rejects a forged pharmacy scope", async () => {
  const fixture = evaluationFixture(); await fixture.authenticate(); await fixture.turn("Yes");
  await fixture.sessions.run("evaluation-a", async (state, context) => {
    if (state.phase !== "refill_submitted") throw new Error("Expected submitted receipt");
    await assert.rejects(fixture.actions.submit({ ...state, pharmacyId: "forged-destination" }, context));
    return { state, result: undefined };
  });
  assert.equal(fixture.mutations().length, 1);
});

test("interrupted action commits recover their outcome before cancellation or a new medication/pharmacy intent", async () => {
  for (const unknown of [false, true]) for (const message of ["cancel", "Refill Othermed 20mg.", "Show me available pharmacies."]) {
    const inner = new InMemorySessionRepository(); let failCommit = false;
    const sessions: SessionRepository = { run: (id, operation) => inner.run(id, async (state, context) => {
      const update = await operation(state, context);
      if (failCommit) { failCommit = false; throw new Error("Synthetic interrupted commit"); }
      return update;
    }) };
    const fixture = evaluationFixture({ sessions, medications: [medication(), medication({ medId: "other-owned", name: "Othermed 20mg" })],
      ehr: unknown ? { submitRefill: async () => { throw new ClinicalEhrError("timeout", { uncertain: true }); } } : undefined });
    await fixture.authenticate(); failCommit = true; await assert.rejects(fixture.turn("Yes"));
    const before = fixture.calls.length;
    const reply = await fixture.turn(message);
    assert.equal(reply.state, unknown ? "escalated" : "complete", `${unknown}; ${message}`);
    assert.match(reply.messages[0].text, unknown ? /outcome is unknown/i : /request was submitted/i);
    assert.doesNotMatch(reply.messages[0].text, /No refill has been submitted/i);
    assert.equal(fixture.calls.length, before, "Recovery cannot initiate a fresh protected operation");
    assert.deepEqual(fixture.mutations().map(call => call.operation), ["submit"]);
  }
});
