import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildLiveScenarios, liveDatasetSchema } from "../evaluation/live-scenarios.js";
import { runMockScenario } from "../evaluation/live-runner.js";
import type { Interpretation, LanguageInterpreter } from "../agent/intent.js";

const dataset = liveDatasetSchema.parse(JSON.parse(readFileSync(new URL("../mock/dataset.json", import.meta.url), "utf8")));
test("all labeled synthetic conversations execute through real HTTP and isolated unchanged mock services", async t => {
  // This validates the evaluation infrastructure and workflow expectations, not live-model accuracy.
  const observations: { scenario: string; passed: boolean; turns: number; refillPosts: number; pharmacyPuts: number }[] = [];
  for (const input of buildLiveScenarios(dataset)) await t.test(input.id, async () => {
    // Arrange: labels drive a fake interpreter; backend service responses remain real.
    let currentTurn = -1; const turnLabels: number[] = [];
    const interpreter: LanguageInterpreter = { interpret: async (): Promise<Interpretation> => {
      const label = input.modelExpected.find(expected => expected.turnIndex === currentTurn);
      return { intent: label?.expectedIntent ?? "other",
        identity: { firstName: null, lastName: null, dob: null, phoneLast4: null, zip: null, ...label?.identity },
        medicationQuery: label?.medicationQuery ?? null, pharmacyQuery: label?.pharmacyQuery ?? null, clarification: "none" };
    } };
    // Act
    const result = await runMockScenario(input, { interpreter, timeoutMs: 15_000,
      onTurnStart: index => { currentTurn = index; turnLabels.push(index); } });
    observations.push({ scenario: input.id, passed: result.passed, turns: result.transcript.length,
      refillPosts: result.effects.refillPosts, pharmacyPuts: result.effects.pharmacyUpdates });
    // Assert: actual requests, validated replies, backend effects, and trusted terminal evidence.
    assert.equal(result.passed, true, result.checkpointFailures.join("; "));
    assert.deepEqual(turnLabels, input.turns.map((_, index) => index));
    assert.equal(result.transcript.length, input.turns.length);
    assert.ok(result.transcript.every(turn => turn.httpStatus === 200 && turn.response && "messages" in turn.response));
    assert.equal(result.finalState, input.expectations.state);
    assert.equal(result.effects.refillPosts, input.expectations.refills);
    assert.equal(result.effects.pharmacyUpdates, input.expectations.pharmacyUpdates);
    assert.ok(result.calls.every(call => !Object.hasOwn(call, "body") && !Object.hasOwn(call, "query")));
    const original = dataset.patients.find(patient => patient.patientId === input.expectations.patientId); assert.ok(original);
    assert.equal(result.effects.currentPharmacyId, input.expectations.pharmacyUpdates
      ? input.expectations.destinationPharmacyId : original.currentPharmacyId);
    if (input.expectations.refills) {
      assert.deepEqual(result.effects.refillMedIds, [input.expectations.medId]);
      assert.equal(result.sessionEvidence.receipt?.status, "submitted");
      assert.ok(result.calls.some(call => call.path === `/ehr/patients/${input.expectations.patientId}/refills` && call.medId === input.expectations.medId));
    } else assert.equal(result.sessionEvidence.receipt, undefined);
    if (input.expectations.pharmacyUpdates) {
      assert.deepEqual(result.effects.updatedPharmacyIds, [input.expectations.destinationPharmacyId]);
      assert.ok(result.calls.some(call => call.path === "/pharmacy/directory"));
      const update = result.calls.findIndex(call => call.method === "PUT");
      const refill = result.calls.findIndex(call => call.medId !== undefined);
      assert.ok(update >= 0 && refill > update);
    }
  });
  t.diagnostic(`actual isolated-mock evaluation: ${JSON.stringify({ scenarios: observations.length,
    passed: observations.filter(result => result.passed).length,
    turns: observations.reduce((total, result) => total + result.turns, 0),
    refillPosts: observations.reduce((total, result) => total + result.refillPosts, 0),
    pharmacyPuts: observations.reduce((total, result) => total + result.pharmacyPuts, 0), observations })}`);
});
