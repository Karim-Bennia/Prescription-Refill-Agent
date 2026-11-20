import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createInitialState, transition, requireAuthenticatedPatient, publicConversationState,
  validateConversationState, InvalidTransitionError, InvalidConversationStateError,
  UnauthorizedSessionError, MAX_AUTH_ATTEMPTS, type ConversationState,
} from "../agent/conversation-state.js";

const factors = { firstName: "Jordan", lastName: "Example", dob: "1991-02-03", zip: "10001" };
const request = { medicationQuery: "Example medication 5 mg" };

function verifying(requestValue: { medicationQuery: string | null } | null = request): ConversationState {
  const collecting = transition(createInitialState(), { type: "context_updated", factors, request: requestValue });
  return transition(collecting, { type: "verify_requested" });
}

test("initial conversation cannot authorize patient operations", () => {
  const state = createInitialState();
  assert.deepEqual(state, { phase: "collecting_identity", factors: {}, request: null, failures: 0 });
  assert.equal(publicConversationState(state), "in_progress");
  assert.throws(() => requireAuthenticatedPatient(state), UnauthorizedSessionError);
});

test("context updates remain pure and incomplete factors cannot begin matching", () => {
  // Arrange
  const original = createInitialState();
  // Act
  const partial = transition(original, { type: "context_updated", factors: { firstName: "Jordan" }, request });
  // Assert
  assert.deepEqual(original, createInitialState());
  assert.deepEqual(partial, { phase: "collecting_identity", factors: { firstName: "Jordan" }, request, failures: 0 });
  assert.throws(() => transition(partial, { type: "verify_requested" }), InvalidTransitionError);
  assert.throws(() => transition(partial, { type: "match_succeeded", patientId: "patient-a" }), InvalidTransitionError);
});

test("only a verifying state can bind a unique EHR result and demographics are discarded", () => {
  // Arrange
  const pending = verifying();
  // Act
  const authenticated = transition(pending, { type: "match_succeeded", patientId: "patient-a" });
  // Assert
  assert.deepEqual(authenticated, { phase: "ready", patientId: "patient-a", request });
  assert.equal(requireAuthenticatedPatient(authenticated), "patient-a");
  assert.equal(Object.hasOwn(authenticated, "factors"), false);
  assert.equal(publicConversationState(authenticated), "in_progress");
  assert.equal(pending.phase, "verifying_identity");
});

test("authentication can finish before a medication request and later clarification preserves identity", () => {
  const authenticated = transition(verifying(null), { type: "match_succeeded", patientId: "patient-a" });
  assert.deepEqual(authenticated, { phase: "collecting_request", patientId: "patient-a", request: null });
  const ready = transition(authenticated, { type: "request_updated", request });
  assert.deepEqual(ready, { phase: "ready", patientId: "patient-a", request });
  const clarification = transition(ready, { type: "request_updated", request: { medicationQuery: null } });
  assert.deepEqual(clarification, authenticated);
});

test("failed matching permits correction with bounded attempts and preserves the original request", () => {
  let state = createInitialState();
  for (let attempt = 1; attempt <= MAX_AUTH_ATTEMPTS; attempt++) {
    state = transition(state, { type: "context_updated", factors, request });
    state = transition(state, { type: "verify_requested" });
    state = transition(state, { type: "match_rejected" });
    if (attempt < MAX_AUTH_ATTEMPTS) {
      assert.deepEqual(state, { phase: "collecting_identity", factors: {}, request, failures: attempt });
    }
  }
  assert.deepEqual(state, { phase: "escalated", reason: "authentication_failed" });
  assert.equal(publicConversationState(state), "escalated");
  assert.throws(() => requireAuthenticatedPatient(state), UnauthorizedSessionError);
  assert.throws(() => transition(state, { type: "verify_requested" }), InvalidTransitionError);
});

test("an unavailable EHR is recoverable and does not consume a patient matching attempt", () => {
  const pending = verifying();
  const state = transition(pending, { type: "verification_unavailable" });
  assert.deepEqual(state, { phase: "collecting_identity", factors, request, failures: 0 });
  assert.equal(transition(state, { type: "verify_requested" }).phase, "verifying_identity");
});

test("a bound patient cannot be reassigned or sent back through identity collection", () => {
  const authenticated = transition(verifying(), { type: "match_succeeded", patientId: "patient-a" });
  assert.throws(() => transition(authenticated, { type: "match_succeeded", patientId: "patient-b" }), InvalidTransitionError);
  assert.throws(() => transition(authenticated, { type: "context_updated", factors, request }), InvalidTransitionError);
  assert.throws(() => transition(authenticated, { type: "verify_requested" }), InvalidTransitionError);
  const stopped = transition(authenticated, { type: "identity_change" });
  assert.deepEqual(stopped, { phase: "escalated", reason: "identity_change" });
  assert.throws(() => requireAuthenticatedPatient(stopped), UnauthorizedSessionError);
});

test("cancellation stops further transitions without inventing refill or handoff results", () => {
  const stopped = transition(createInitialState(), { type: "cancel" });
  assert.deepEqual(stopped, { phase: "closed", reason: "cancelled" });
  assert.equal(publicConversationState(stopped), "complete");
  assert.throws(() => transition(stopped, { type: "cancel" }), InvalidTransitionError);
  assert.throws(() => transition(stopped, { type: "match_succeeded", patientId: "patient-a" }), InvalidTransitionError);
});

test("runtime state validation rejects model authority fields and invalid authentication states", () => {
  for (const state of [
    { ...createInitialState(), patientId: "patient-a" },
    { phase: "ready", patientId: "", request },
    { phase: "ready", patientId: "patient-a", request: { medicationQuery: null } },
    { phase: "verifying_identity", factors: {}, request: null, failures: 0 },
    { ...createInitialState(), failures: MAX_AUTH_ATTEMPTS },
    { phase: "ready", patientId: "patient-a", request, authorized: true },
  ]) assert.throws(() => validateConversationState(state), InvalidConversationStateError);
});

test("unknown events and events in the wrong phase fail explicitly", () => {
  const initial = createInitialState();
  for (const event of [
    { type: "approve_refill", authorized: true },
    { type: "match_rejected" },
    { type: "verification_unavailable" },
    { type: "identity_change" },
    { type: "request_updated", request },
    { type: "cancel", patientId: "patient-b" },
  ]) assert.throws(() => transition(initial, event as Parameters<typeof transition>[1]), InvalidTransitionError);
});
