import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemorySessionRepository, SessionError } from "../agent/sessions.js";
import { createInitialState, requireAuthenticatedPatient, transition, type ConversationState } from "../agent/conversation-state.js";

const factors = { firstName: "Jordan", lastName: "Example", dob: "1991-02-03", zip: "10001" };
const request = { medicationQuery: "Example medication" };
function authenticated(patientId: string): ConversationState {
  let state = transition(createInitialState(), { type: "context_updated", factors, request });
  state = transition(state, { type: "verify_requested" });
  return transition(state, { type: "match_succeeded", patientId });
}
function sessionError(code: string) {
  return (error: unknown) => error instanceof SessionError && error.code === code;
}

test("a missing session starts unauthenticated and can restore its context on later turns", async () => {
  const sessions = new InMemorySessionRepository();
  await sessions.run("session-a", async state => {
    assert.deepEqual(state, createInitialState());
    assert.throws(() => requireAuthenticatedPatient(state));
    return { state: transition(state, { type: "context_updated", factors: { firstName: "Jordan" }, request }), result: undefined };
  });
  const restored = await sessions.run("session-a", async state => ({ state, result: state }));
  assert.deepEqual(restored, { phase: "collecting_identity", factors: { firstName: "Jordan" }, request, failures: 0 });
});

test("separate conversations keep independent patient bindings", async () => {
  const sessions = new InMemorySessionRepository();
  await Promise.all([
    sessions.run("session-a", async () => ({ state: authenticated("patient-a"), result: undefined })),
    sessions.run("session-b", async () => ({ state: authenticated("patient-b"), result: undefined })),
  ]);
  assert.equal(await sessions.run("session-a", async state => ({ state, result: requireAuthenticatedPatient(state) })), "patient-a");
  assert.equal(await sessions.run("session-b", async state => ({ state, result: requireAuthenticatedPatient(state) })), "patient-b");
});

test("repository rejects patient switching and authentication reset even through a trusted callback", async () => {
  const sessions = new InMemorySessionRepository();
  await sessions.run("session-a", async () => ({ state: authenticated("patient-a"), result: undefined }));
  for (const state of [authenticated("patient-b"), createInitialState()]) {
    await assert.rejects(sessions.run("session-a", async () => ({ state, result: undefined })), sessionError("invalid_state"));
  }
  const patientId = await sessions.run("session-a", async state => ({ state, result: requireAuthenticatedPatient(state) }));
  assert.equal(patientId, "patient-a");
});

test("snapshots cannot be mutated and returned state is cloned before storage", async () => {
  const sessions = new InMemorySessionRepository();
  const mutable = authenticated("patient-a");
  await sessions.run("session-a", async () => ({ state: mutable, result: undefined }));
  if (mutable.phase !== "ready") throw new Error("Expected ready fixture.");
  mutable.request.medicationQuery = "Changed outside the repository";
  await sessions.run("session-a", async state => {
    assert.equal(Object.isFrozen(state), true);
    if (state.phase !== "ready") throw new Error("Expected ready state.");
    assert.equal(state.request.medicationQuery, request.medicationQuery);
    assert.equal(Object.isFrozen(state.request), true);
    assert.throws(() => { state.request.medicationQuery = "Mutation attempt"; }, TypeError);
    return { state, result: undefined };
  });
});

test("same-session turns are serialized and the next turn observes the committed state", async () => {
  // Arrange
  const sessions = new InMemorySessionRepository();
  const order: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const firstEntered = new Promise<void>(resolve => { entered = resolve; });
  // Act
  const first = sessions.run("session-a", async state => {
    order.push("first-enter"); entered(); await pending;
    order.push("first-exit");
    return { state: transition(state, { type: "context_updated", factors, request }), result: "first" };
  });
  await firstEntered;
  const second = sessions.run("session-a", async state => {
    order.push("second-enter");
    assert.equal(state.phase, "collecting_identity");
    if (state.phase !== "collecting_identity") throw new Error("Unexpected state.");
    assert.deepEqual(state.factors, factors);
    return { state: transition(state, { type: "verify_requested" }), result: "second" };
  });
  await Promise.resolve();
  assert.deepEqual(order, ["first-enter"]);
  release();
  // Assert
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(order, ["first-enter", "first-exit", "second-enter"]);
});

test("an independent session is not blocked by another session's pending request", async () => {
  const sessions = new InMemorySessionRepository();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const first = sessions.run("session-a", async state => { await pending; return { state, result: "a" }; });
  const second = await sessions.run("session-b", async state => ({ state, result: "b" }));
  assert.equal(second, "b");
  release();
  assert.equal(await first, "a");
});

test("failed operations release their queue and leave the previous state intact", async () => {
  const sessions = new InMemorySessionRepository();
  const failed = sessions.run("session-a", async () => { throw new Error("Synthetic operation failure."); });
  const later = sessions.run("session-a", async state => ({ state, result: state }));
  await assert.rejects(failed, /Synthetic operation failure/);
  assert.deepEqual(await later, createInitialState());
});

test("invalid updated state fails closed without changing stored state or revealing its values", async () => {
  const sessions = new InMemorySessionRepository();
  const marker = "private-demographic-marker";
  await assert.rejects(sessions.run("session-a", async () => ({
    state: { phase: "ready", patientId: marker, request: null } as unknown as ConversationState,
    result: undefined,
  })), error => {
    assert.ok(error instanceof SessionError);
    assert.equal(error.code, "invalid_state");
    assert.ok(!String(error).includes(marker));
    assert.ok(!JSON.stringify(error).includes(marker));
    return true;
  });
  assert.deepEqual(await sessions.run("session-a", async state => ({ state, result: state })), createInitialState());
});

test("session IDs are validated before invoking the operation", async () => {
  const sessions = new InMemorySessionRepository();
  let calls = 0;
  for (const id of ["", "../patient-a", "bad/path", "bad space", "a".repeat(129)]) {
    await assert.rejects(sessions.run(id, async state => { calls++; return { state, result: undefined }; }), sessionError("invalid_session"));
  }
  assert.equal(calls, 0);
});

test("session capacity is reserved atomically and terminal records are not evicted", async () => {
  const sessions = new InMemorySessionRepository({ maxSessions: 1 });
  await sessions.run("session-a", async state => ({ state: transition(state, { type: "cancel" }), result: undefined }));
  await assert.rejects(sessions.run("session-b", async state => ({ state, result: undefined })), sessionError("capacity"));
  const stopped = await sessions.run("session-a", async state => ({ state, result: state }));
  assert.deepEqual(stopped, { phase: "closed", reason: "cancelled" });
});

test("expiration removes authentication and cannot silently recreate the same session", async () => {
  let now = 1000;
  const sessions = new InMemorySessionRepository({ ttlMs: 100, now: () => now });
  await sessions.run("session-a", async () => ({ state: authenticated("patient-a"), result: undefined }));
  now = 1099;
  const beforeExpiry = await sessions.run("session-a", async state => ({ state, result: requireAuthenticatedPatient(state) }));
  assert.equal(beforeExpiry, "patient-a");
  now = 1199;
  const expired = await sessions.run("session-a", async state => ({ state, result: state }));
  assert.deepEqual(expired, { phase: "escalated", reason: "expired" });
  await assert.rejects(sessions.run("session-a", async () => ({ state: createInitialState(), result: undefined })), sessionError("invalid_state"));
  assert.throws(() => requireAuthenticatedPatient(expired));
});

test("invalid repository limits and clock values fail safely", async () => {
  for (const options of [{ maxSessions: 0 }, { maxSessions: 1.5 }, { ttlMs: 0 }]) {
    assert.throws(() => new InMemorySessionRepository(options), sessionError("invalid_state"));
  }
  const sessions = new InMemorySessionRepository({ now: () => Number.NaN });
  await assert.rejects(sessions.run("session-a", async state => ({ state, result: undefined })), sessionError("invalid_state"));
});

test("an invalid commit timestamp does not partially commit a state update", async () => {
  // Arrange
  let invalidClock = false;
  const sessions = new InMemorySessionRepository({ now: () => invalidClock ? Number.NaN : 1000 });
  // Act
  await assert.rejects(sessions.run("session-a", async state => {
    invalidClock = true;
    return { state: transition(state, { type: "context_updated", factors, request }), result: undefined };
  }), sessionError("invalid_state"));
  invalidClock = false;
  // Assert
  const restored = await sessions.run("session-a", async state => ({ state, result: state }));
  assert.deepEqual(restored, createInitialState());
});

test("per-session pending turns are bounded and released after completion or failure", async () => {
  const sessions = new InMemorySessionRepository();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const pending = Array.from({ length: 32 }, () => sessions.run("bounded-session", async state => {
    calls++;
    await gate;
    return { state, result: undefined };
  }));
  const overflow = sessions.run("bounded-session", async state => {
    calls++;
    return { state, result: undefined };
  }).then(() => null, (error: unknown) => error);
  release();
  await Promise.all(pending);
  const rejected = await overflow;
  assert.ok(rejected instanceof SessionError);
  assert.equal(rejected.code, "capacity");
  assert.equal(calls, 32);
  await assert.rejects(sessions.run("bounded-session", async () => { throw new Error("Synthetic operation failure"); }));
  assert.equal(await sessions.run("bounded-session", async state => ({ state, result: "recovered" })), "recovered");
});
