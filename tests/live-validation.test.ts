import assert from "node:assert/strict";
import { test } from "node:test";
import { assessLiveProvider } from "../evaluation/live-validation.js";
import type { LiveInterpretationMetric, LiveRequestMetric } from "../evaluation/live-observer.js";

const response = (changes: Partial<LiveRequestMetric> = {}): LiveRequestMetric => ({
  attempt: 1, durationMs: 12, outcome: "response", status: 200,
  modelMatchesExpected: true, returnedModel: "openai/gpt-oss-120b", ...changes,
});
const interpretation = (changes: Partial<LiveInterpretationMetric> = {}): LiveInterpretationMetric => ({
  durationMs: 13, structuredOutputValid: true, intent: "refill_request", clarification: "medication", ...changes,
});

test("HTTP 200 refusal and timeout fail model validation even when a later deterministic workflow succeeds", () => {
  // Arrange: both failures were accepted by the former CLI predicate because neither is HTTP failure nor malformed output.
  for (const errorCode of ["refused", "timeout"] as const) {
    const requests = [response()];
    const interpretations = [interpretation({ structuredOutputValid: null, errorCode })];
    const workflowPassed = true;
    assert.equal(workflowPassed && requests.every(request => request.status === 200)
      && !interpretations.some(metric => metric.structuredOutputValid === false), true);

    // Act
    const actual = assessLiveProvider(requests, interpretations);

    // Assert: transaction recovery must not turn a provider failure into a successful model evaluation.
    assert.equal(actual.interpretationFailures, 1);
    assert.equal(actual.successfulProviderResponses, 1);
    assert.equal(actual.passed, false, errorCode);
  }
});

test("missing model metadata has an explicit denominator and cannot prove the expected model responded", () => {
  // Arrange / Act
  const actual = assessLiveProvider([response({ modelMatchesExpected: undefined, returnedModel: undefined })], [interpretation()]);

  // Assert
  assert.equal(actual.successfulProviderResponses, 1);
  assert.equal(actual.matchingModelResponses, 0);
  assert.equal(actual.missingModelMetadataResponses, 1);
  assert.equal(actual.passed, false);
});

test("an HTTP response without an observed schema validation cannot pass live provider evaluation", () => {
  assert.equal(assessLiveProvider([response()], []).passed, false);
  assert.equal(assessLiveProvider([], []).passed, false);
});

test("matching model responses and validated interpretations pass with safe aggregate counters", () => {
  // Arrange / Act
  const actual = assessLiveProvider([response(), response({ attempt: 2 })], [interpretation(), interpretation()]);

  // Assert
  assert.deepEqual(actual, { interpretationFailures: 0, matchingModelResponses: 2, mismatchedModelResponses: 0,
    missingModelMetadataResponses: 0, successfulProviderResponses: 2, passed: true });
});

test("failed and pending attempts remain failures regardless of earlier successful model evidence", () => {
  const failed: LiveRequestMetric[] = [
    response({ outcome: "network_error", status: undefined, errorCode: "network" }),
    response({ status: 429 }), response({ status: 503 }), response({ outcome: "pending" }),
  ];
  for (const request of failed) {
    // Arrange / Act
    const actual = assessLiveProvider([response(), { ...request, attempt: 2 }], [interpretation()]);

    // Assert
    assert.equal(actual.successfulProviderResponses, 1);
    assert.equal(actual.passed, false);
  }
});

test("malformed output, contradictory error evidence and model mismatch fail without exposing strings", () => {
  // Arrange
  const requests = [response({ modelMatchesExpected: false, returnedModel: "arbitrary-provider-marker" }),
    response({ attempt: 2, modelMatchesExpected: undefined, returnedModel: undefined }), response({ attempt: 3 })];
  const interpretations = [interpretation({ structuredOutputValid: false, errorCode: "invalid_response" }),
    interpretation({ errorCode: "provider" }), interpretation()];

  // Act
  const actual = assessLiveProvider(requests, interpretations);

  // Assert
  assert.deepEqual(actual, { interpretationFailures: 2, matchingModelResponses: 1, mismatchedModelResponses: 1,
    missingModelMetadataResponses: 1, successfulProviderResponses: 3, passed: false });
  assert.ok(!JSON.stringify(actual).includes("arbitrary-provider-marker"));
});
