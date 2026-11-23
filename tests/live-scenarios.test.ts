import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { buildLiveScenarios, liveDatasetSchema, type LiveModelExpectation } from "../evaluation/live-scenarios.js";
import { interpretationSchema, type Interpretation } from "../agent/intent.js";
import { evaluationFixture } from "./evaluation-fixtures.js";

const dataset = liveDatasetSchema.parse(JSON.parse(await readFile(new URL("../mock/dataset.json", import.meta.url), "utf8")));
const scenarios = buildLiveScenarios(dataset);
const interpreted = (label: LiveModelExpectation): Interpretation => interpretationSchema.parse({
  intent: label.expectedIntent,
  identity: { firstName: null, lastName: null, dob: null, phoneLast4: null, zip: null, ...label.identity },
  medicationQuery: label.medicationQuery ?? null, pharmacyQuery: label.pharmacyQuery ?? null, clarification: "none",
});

test("live evaluation definitions remain bounded, dataset-grounded, and independent", () => {
  const original = structuredClone(dataset);
  const definitions = buildLiveScenarios(dataset);
  assert.equal(definitions.length, 12);
  assert.equal(new Set(definitions.map(scenario => scenario.id)).size, definitions.length);
  assert.equal(definitions.reduce((count, scenario) => count + scenario.modelExpected.length, 0), 13);
  for (const scenario of definitions) {
    const patient = dataset.patients.find(record => record.patientId === scenario.expectations.patientId);
    assert.ok(patient);
    assert.ok(patient.medications.some(record => record.medId === scenario.expectations.medId));
    if (scenario.expectations.destinationPharmacyId) {
      assert.ok(dataset.pharmacies.some(record => record.pharmacyId === scenario.expectations.destinationPharmacyId));
    }
    assert.ok(scenario.turns.length <= 8);
    assert.ok(scenario.turns.every(text => text.length > 0 && text.length <= 4000));
    assert.ok(scenario.modelExpected.length >= 1);
    assert.equal(scenario.modelExpected[0].turnIndex, 0);
    assert.ok(scenario.checkpoints.every(check => check.afterTurn >= 0 && check.afterTurn < scenario.turns.length));
  }
  assert.deepEqual(dataset, original);
});

test("live definitions reject incomplete fixtures instead of inventing clinical records or destinations", () => {
  const missingRestriction = structuredClone(dataset);
  missingRestriction.patients.forEach(patient => { patient.medications = patient.medications.filter(record => record.schedule !== "CII"); });
  assert.throws(() => buildLiveScenarios(missingRestriction), /lacks a fixture for R1_schedule_ii/u);
  const invalidDirectory = structuredClone(dataset);
  invalidDirectory.pharmacies = [];
  assert.equal(liveDatasetSchema.safeParse(invalidDirectory).success, false);
});

for (const scenario of scenarios) {
  test(`offline rehearsal of live definition: ${scenario.id}`, async () => {
    // Arrange: actual synthetic records, deterministic model labels, production orchestration.
    // This is definition verification; it is not reported as live-model or real-mock evidence.
    const patient = dataset.patients.find(record => record.patientId === scenario.expectations.patientId)!;
    const pharmacy = dataset.pharmacies.find(record => record.pharmacyId === patient.currentPharmacyId);
    const usedLabels: number[] = [];
    const fixture = evaluationFixture({
      medications: structuredClone(patient.medications), labs: structuredClone(patient.labs),
      pharmacy: pharmacy ? { pharmacyId: pharmacy.pharmacyId, name: pharmacy.name } : null,
      directory: structuredClone(dataset.pharmacies), ehr: { time: async () => dataset.now },
      matcher: { match: async factors => {
        const matches = factors.firstName === patient.firstName && factors.lastName === patient.lastName
          && factors.dob === patient.dob && (factors.phoneLast4 === patient.phone.replace(/\D/gu, "").slice(-4) || factors.zip === patient.zip);
        return matches ? { count: 1, patientId: patient.patientId } : { count: 0, patientId: null };
      } },
      interpreter: { interpret: async text => {
        const label = scenario.modelExpected.find(expected => scenario.turns[expected.turnIndex] === text);
        assert.ok(label, `Unexpected model invocation in ${scenario.id}`);
        usedLabels.push(label.turnIndex);
        return interpreted(label);
      } },
    });
    let finalState: string | undefined;

    // Act and assert each checkpoint against real state transitions and recorded effects.
    for (const [turnIndex, text] of scenario.turns.entries()) {
      const response = await fixture.turn(text);
      finalState = response.state;
      for (const checkpoint of scenario.checkpoints.filter(check => check.afterTurn === turnIndex)) {
        assert.equal(fixture.calls.filter(call => call.operation === "submit").length, checkpoint.refills, `refills after turn ${turnIndex}`);
        assert.equal(fixture.calls.filter(call => call.operation === "update").length, checkpoint.pharmacyUpdates, `updates after turn ${turnIndex}`);
        if (checkpoint.state) assert.equal(response.state, checkpoint.state, `state after turn ${turnIndex}`);
        if (checkpoint.replyIncludes) assert.ok(response.messages.some(message => message.text.includes(checkpoint.replyIncludes!)));
        if (checkpoint.maxProtectedReads !== undefined) {
          assert.ok(fixture.calls.filter(call => ["medications", "labs", "pharmacy"].includes(call.operation)).length <= checkpoint.maxProtectedReads);
        }
      }
    }
    assert.equal(finalState, scenario.expectations.state);
    const writes = fixture.calls.filter(call => call.operation === "submit");
    const updates = fixture.calls.filter(call => call.operation === "update");
    assert.equal(writes.length, scenario.expectations.refills);
    assert.equal(updates.length, scenario.expectations.pharmacyUpdates);
    assert.deepEqual(usedLabels, scenario.modelExpected.map(label => label.turnIndex));
    for (const call of fixture.calls.filter(call => call.patientId !== undefined)) assert.equal(call.patientId, patient.patientId);
    for (const call of writes) assert.equal(call.medId, scenario.expectations.medId);
    for (const call of updates) assert.equal(call.pharmacyId, scenario.expectations.destinationPharmacyId);
    if (scenario.expectations.destinationPharmacyId && writes.length > 0) {
      assert.equal(fixture.records.pharmacy?.pharmacyId, scenario.expectations.destinationPharmacyId);
    }
  });
}
