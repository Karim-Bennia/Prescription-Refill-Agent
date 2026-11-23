import assert from "node:assert/strict";
import { test } from "node:test";
import { redactReport, scoreModelProposal, summarizeModelScores } from "../evaluation/live-report.js";
import type { Interpretation } from "../agent/intent.js";

const proposal: Interpretation = { intent: "refill_request", medicationQuery: "Example medication 10 mg", pharmacyQuery: null,
  identity: { firstName: null, lastName: null, dob: null, phoneLast4: null, zip: null }, clarification: "none" };

test("model scoring separates interpretation agreement from omitted cases and query correctness", () => {
  // Arrange: two observed labels out of three planned labels, with one incomplete query.
  const expected = { turnIndex: 0, expectedIntent: "refill_request" as const, medicationQuery: "Example medication 10 mg" };
  // Act
  const correct = scoreModelProposal(expected, { ...proposal, medicationQuery: "  EXAMPLE medication   10 mg  " });
  const partial = scoreModelProposal(expected, { ...proposal, medicationQuery: "Example medication" });
  const result = summarizeModelScores([correct, partial], 3);
  // Assert: intent correctness cannot conceal incomplete extraction, or count unobserved data as correct.
  assert.deepEqual(result.intent, { correct: 2, total: 2 });
  assert.deepEqual(result.medicationQueryExact, { correct: 1, total: 2 });
  assert.deepEqual(result.pharmacyQueryExact, { correct: 0, total: 0 });
  assert.deepEqual(result.allLabeledFields, { correct: 1, total: 2 });
  assert.equal(result.unobservedLabels, 1);
  assert.throws(() => summarizeModelScores([correct], 0), /denominator/u);
  assert.deepEqual(summarizeModelScores([], 13).intent, { correct: 0, total: 0 });
});

test("invalid structured output cannot enter scores and identity extraction has its own denominator", () => {
  const label = { turnIndex: 2, expectedIntent: "identity_information" as const, identity: { firstName: "Sample", lastName: "Person" } };
  assert.throws(() => scoreModelProposal(label, { ...proposal, patientId: "forged" }), /Invalid interpretation metric/u);
  const score = scoreModelProposal(label, { ...proposal, intent: "identity_information",
    identity: { ...proposal.identity, firstName: "Sample", lastName: "Incorrect" } });
  assert.deepEqual(score.identityFields, { correct: 1, total: 2 }); assert.equal(score.allLabeledFieldsCorrect, false);
  assert.ok(!JSON.stringify(score).includes("Incorrect"));
});

test("persisted reports redact exact secret occurrences, nested values, property names, and sensitive fields", () => {
  const marker = "synthetic-marker-never-a-real-key";
  const original = { transcript: [{ text: `before ${marker} after`, authorization: "must-never-be-persisted" }],
    [marker]: marker, nested: { apiKey: "another-sensitive-value", healthy: true, count: 2 }, absent: undefined };
  const snapshot = structuredClone(original);
  const output = redactReport(original, [marker, "", marker]);
  const json = JSON.stringify(output);
  for (const forbidden of [marker, "must-never-be-persisted", "another-sensitive-value"]) assert.ok(!json.includes(forbidden));
  assert.ok(json.includes("[REDACTED]")); assert.ok(json.includes('"count":2'));
  assert.deepEqual(original, snapshot);
  const circular: Record<string, unknown> = {}; circular.self = circular;
  assert.throws(() => redactReport(circular, []), /Invalid evaluation report/u);
  assert.throws(() => redactReport({ nonfinite: Infinity }, []), /Invalid evaluation report/u);
});
