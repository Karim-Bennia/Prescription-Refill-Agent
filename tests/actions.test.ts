import assert from "node:assert/strict";
import { test } from "node:test";
import { clinicalFixture, medication } from "./clinical-fixtures.js";
import { ClinicalEhrError } from "../agent/clinical-ehr.js";
import { transition } from "../agent/conversation-state.js";

test("a missing pharmacy confirmation blocks the real action boundary before any write", async () => {
  const fixture = clinicalFixture();
  await fixture.authenticate();
  const before = fixture.calls.length;
  assert.deepEqual(await fixture.submit(), { kind: "blocked", reason: "pharmacy_confirmation_required" });
  assert.equal(fixture.calls.length, before);
});

test("normal domain confirmation plus fresh checks permits exactly one validated submission", async () => {
  const fixture = clinicalFixture();
  await fixture.authenticate();
  assert.equal(await fixture.confirm(), true);
  const outcome = await fixture.submit();
  assert.equal(outcome.kind, "submitted");
  assert.equal((await fixture.state()).phase, "refill_submitted");
  assert.deepEqual(fixture.calls.filter(call => call.operation === "submit"), [{ operation: "submit", patientId: "synthetic-patient-a", medId: "owned-med-a" }]);
  const replay = await fixture.engine.handleTurn("clinical-a", "Please submit it again");
  assert.equal(replay.state, "complete");
  assert.match(replay.messages[0].text, /was submitted/);
  assert.equal(fixture.calls.filter(call => call.operation === "submit").length, 1);
});

test("concurrent duplicate submissions share the receipt and never repeat the POST", async () => {
  const fixture = clinicalFixture();
  await fixture.authenticate(); await fixture.confirm();
  const outcomes = await Promise.all([fixture.submit(), fixture.submit()]);
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.equal(fixture.calls.filter(call => call.operation === "submit").length, 1);
});

test("confirmation cannot transfer to a changed medication request", async () => {
  const fixture = clinicalFixture({ medications: [medication(), medication({ medId: "owned-med-b", name: "Othermed 5mg" })] });
  await fixture.authenticate(); await fixture.confirm();
  await fixture.engine.handleTurn("clinical-a", "refill my Othermed 5mg");
  assert.deepEqual(await fixture.submit(), { kind: "blocked", reason: "pharmacy_confirmation_required" });
  assert.equal(fixture.calls.some(call => call.operation === "submit"), false);
});

test("fresh EHR ownership and clinical failures stop a previously eligible selection", async () => {
  for (const change of ["missing", "no_refills", "stale_lab"] as const) {
    const initial = change === "stale_lab" ? medication({ requiresRecentLab: { type: "ExampleLab", withinDays: 30 } }) : medication();
    const fixture = clinicalFixture({ medications: [initial], labs: [{ type: "ExampleLab", value: "any value", takenDate: "2031-06-30T12:00:00Z" }] });
    await fixture.authenticate(); await fixture.confirm();
    if (change === "missing") fixture.records.medications = [];
    if (change === "no_refills") fixture.records.medications = [medication({ refillsRemaining: 0 })];
    if (change === "stale_lab") fixture.records.labs = [];
    assert.equal((await fixture.submit()).kind, "blocked");
    assert.equal(fixture.calls.some(call => call.operation === "submit"), false);
  }
});

test("changed or absent pharmacy identity invalidates prior confirmation", async () => {
  for (const pharmacy of [null, { pharmacyId: "pharmacy-b", name: "Other Synthetic Pharmacy" }]) {
    const fixture = clinicalFixture();
    await fixture.authenticate(); await fixture.confirm();
    fixture.records.pharmacy = pharmacy;
    assert.deepEqual(await fixture.submit(), { kind: "blocked", reason: "pharmacy_confirmation_required" });
    assert.equal(fixture.calls.some(call => call.operation === "submit"), false);
  }
});

test("wrong pharmacy choice or missing current pharmacy cannot establish consent", async () => {
  const fixture = clinicalFixture();
  await fixture.authenticate();
  assert.equal(await fixture.confirm("clinical-a", "pharmacy-foreign"), false);
  fixture.records.pharmacy = null;
  assert.equal(await fixture.confirm(), false);
  assert.equal((await fixture.submit()).kind, "blocked");
});

test("expired or cancelled sessions cannot start or continue a refill write", async () => {
  let now = 0;
  let expireDuringRead = false;
  const fixture = clinicalFixture({ now: () => now, ttlMs: 100, hooks: { medications: async () => {
    if (expireDuringRead) now = 101;
    return [medication()];
  } } });
  await fixture.authenticate(); await fixture.confirm();
  expireDuringRead = true;
  await assert.rejects(fixture.submit());
  assert.equal(fixture.calls.some(call => call.operation === "submit"), false);
  const cancelled = clinicalFixture();
  await cancelled.authenticate(); await cancelled.confirm();
  await cancelled.engine.handleTurn("clinical-a", "cancel");
  await assert.rejects(cancelled.submit());
  assert.equal(cancelled.calls.some(call => call.operation === "submit"), false);
});

test("foreign session and forged lease fail before protected writes", async () => {
  const fixture = clinicalFixture();
  await fixture.authenticate(); await fixture.confirm();
  const state = await fixture.state();
  await assert.rejects(fixture.actions.submit(state, { conversationId: "clinical-a" }));
  await fixture.engine.handleTurn("clinical-b", "refill my Examplemed 10mg");
  await fixture.engine.handleTurn("clinical-b", "Dana Reed, DOB 1985-04-05, phone ending 9876.");
  await fixture.within(async (_current, context) => { await assert.rejects(fixture.actions.submit(state, context)); }, "clinical-b");
  assert.equal(fixture.calls.some(call => call.operation === "submit"), false);
});

test("non-idempotent write failures retain a lock and report only supported outcomes", async t => {
  for (const [name, error, expected] of [
    ["timeout", new ClinicalEhrError("timeout", { uncertain: true }), "unknown"],
    ["network", new Error("private-transport-detail"), "unknown"],
    ["5xx", new ClinicalEhrError("unavailable", { status: 503, uncertain: true }), "unknown"],
    ["4xx", new ClinicalEhrError("rejected", { status: 400, uncertain: false }), "rejected"],
  ] as const) await t.test(name, async () => {
    let writes = 0;
    const fixture = clinicalFixture({ hooks: { submitRefill: async () => { writes++; throw error; } } });
    await fixture.authenticate(); await fixture.confirm();
    assert.equal((await fixture.submit()).kind, expected);
    const reply = await fixture.engine.handleTurn("clinical-a", "try again");
    assert.equal(reply.state, "escalated");
    assert.doesNotMatch(JSON.stringify(reply), /private-transport-detail|was submitted to/);
    assert.equal(writes, 1);
  });
});

test("invalid fulfilled refill receipt produces unknown outcome and no fabricated success", async () => {
  let writes = 0;
  const fixture = clinicalFixture({ hooks: { submitRefill: async () => { writes++; return { refillId: "invented", status: "accepted" } as never; } } });
  await fixture.authenticate(); await fixture.confirm();
  assert.equal((await fixture.submit()).kind, "unknown");
  assert.equal(writes, 1);
});

test("action-time selection must still match the patient's requested medication", async () => {
  const fixture = clinicalFixture({ medications: [medication(), medication({ medId: "owned-med-b", name: "Othermed 5mg" })] });
  await fixture.authenticate();
  await fixture.sessions.run("clinical-a", async (state, context) => {
    // Adversarial internal stale state: an owned ID alone is insufficient authorization.
    const inconsistent = transition(state, { type: "prescription_eligible", medId: "owned-med-b", medicationName: "Othermed 5mg", request: { medicationQuery: "Examplemed 10mg" } });
    assert.equal(await fixture.actions.confirmCurrentPharmacy(inconsistent, context, "pharmacy-a"), false);
    const result = await fixture.actions.submit(inconsistent, context);
    assert.equal(result.outcome.kind, "blocked");
    return { state, result: undefined };
  });
  assert.equal(fixture.calls.some(call => call.operation === "submit"), false);
});

test("submitted receipt evidence cannot be changed by the caller", async () => {
  const fixture = clinicalFixture();
  await fixture.authenticate(); await fixture.confirm();
  const outcome = await fixture.submit();
  assert.equal(outcome.kind, "submitted");
  if (outcome.kind !== "submitted") return assert.fail();
  assert.equal(Object.isFrozen(outcome.receipt), true);
});

test("confirmation cannot authorize a forged selection that was never saved in the session", async () => {
  const fixture = clinicalFixture({ medications: [medication(), medication({ medId: "owned-med-b", name: "Othermed 5mg" })] });
  await fixture.authenticate();
  await fixture.sessions.run("clinical-a", async (state, context) => {
    const forged = transition(state, { type: "prescription_eligible", medId: "owned-med-b",
      medicationName: "Othermed 5mg", request: { medicationQuery: "Othermed 5mg" } });
    assert.equal(await fixture.actions.confirmCurrentPharmacy(forged, context, "pharmacy-a"), false);
    return { state, result: undefined };
  });
  assert.equal(fixture.calls.some(call => call.operation === "submit"), false);
});

test("a session commit failure after submission cannot cause a duplicate write", async () => {
  for (const uncertain of [false, true]) {
    let writes = 0;
    const fixture = clinicalFixture({ hooks: { submitRefill: async () => {
      writes++;
      if (uncertain) throw new ClinicalEhrError("network", { uncertain: true });
      return { refillId: "retained-service-receipt", status: "submitted" };
    } } });
    await fixture.authenticate(); await fixture.confirm();
    await assert.rejects(fixture.sessions.run("clinical-a", async (state, context) => {
      await fixture.actions.submit(state, context);
      throw new Error("Synthetic failure before session commit");
    }));
    const recovered = await fixture.submit();
    assert.equal(recovered.kind, uncertain ? "unknown" : "submitted");
    assert.equal(writes, 1);
  }
});

test("A to B to A medication changes cannot revive old confirmation", async () => {
  const fixture = clinicalFixture({ medications: [medication(), medication({ medId: "owned-med-b", name: "Othermed 5mg" })] });
  await fixture.authenticate(); await fixture.confirm();
  await fixture.engine.handleTurn("clinical-a", "refill my Othermed 5mg");
  await fixture.engine.handleTurn("clinical-a", "refill my Examplemed 10mg");
  assert.equal((await fixture.submit()).kind, "blocked");
  assert.equal(fixture.calls.some(call => call.operation === "submit"), false);
});

test("same-lease concurrent actions cannot produce duplicate non-idempotent writes", async () => {
  const fixture = clinicalFixture(); await fixture.authenticate(); await fixture.confirm();
  await fixture.sessions.run("clinical-a", async (state, context) => {
    const results = await Promise.all([fixture.actions.submit(state, context), fixture.actions.submit(state, context)]);
    assert.deepEqual(results[0].outcome, results[1].outcome);
    return { state: results[0].state, result: undefined };
  });
  assert.equal(fixture.calls.filter(call => call.operation === "submit").length, 1);
});

test("a delayed confirmation cannot overwrite a completed action record", async () => {
  let delay = false;
  let release!: () => void;
  const fixture = clinicalFixture({ hooks: { pharmacy: async () => {
    if (delay) await new Promise<void>(resolve => { release = resolve; });
    return { pharmacyId: "pharmacy-a", name: "Synthetic Pharmacy" };
  } } });
  await fixture.authenticate(); await fixture.confirm();
  await fixture.sessions.run("clinical-a", async (state, context) => {
    delay = true;
    const confirmation = fixture.actions.confirmCurrentPharmacy(state, context, "pharmacy-a");
    delay = false;
    const submitted = await fixture.actions.submit(state, context);
    release(); await confirmation;
    const replayed = await fixture.actions.submit(state, context);
    assert.deepEqual(replayed.outcome, submitted.outcome);
    return { state: submitted.state, result: undefined };
  });
  assert.equal(fixture.calls.filter(call => call.operation === "submit").length, 1);
});
