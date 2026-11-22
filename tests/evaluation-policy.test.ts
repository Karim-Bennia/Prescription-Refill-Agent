import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateEligibility } from "../agent/policy.js";
import { selectMedication } from "../agent/selection.js";
import type { Lab, Medication } from "../agent/clinical-types.js";
import { clinicalFixture, medication, TEST_NOW } from "./clinical-fixtures.js";

const DAY = 86_400_000;
const anchors = [
  "2028-02-28T23:30:00.000Z", // Leap day follows this instant.
  "2031-03-08T12:00:00.000Z", // Fixed UTC arithmetic across the spring transition.
  "2031-11-01T12:00:00.000Z", // Fixed UTC arithmetic across the autumn transition.
  "2031-12-31T23:59:59.000Z", // Year boundary.
];
const offsets = [-480, 0, 330];
function atOffset(milliseconds: number, offsetMinutes: number): string {
  const shifted = new Date(milliseconds + offsetMinutes * 60_000).toISOString().slice(0, -1);
  const magnitude = Math.abs(offsetMinutes);
  return `${shifted}${offsetMinutes < 0 ? "-" : "+"}${String(Math.floor(magnitude / 60)).padStart(2, "0")}:${String(magnitude % 60).padStart(2, "0")}`;
}
function recordAt(now: number, changes: Partial<Medication> = {}): Medication {
  return medication({ lastFilledDate: new Date(now - 100 * DAY).toISOString(),
    rxExpirationDate: new Date(now + 400 * DAY).toISOString(), ...changes });
}

test("R1 remains prohibitive across independent valid time, supply, refill and lab variations", t => {
  let cases = 0;
  for (const anchor of anchors) for (const daysSupply of [3, 30, 90]) for (const refillsRemaining of [0, 1]) {
    const now = Date.parse(anchor);
    const record = recordAt(now, { isControlled: true, schedule: "CII", daysSupply, refillsRemaining,
      requiresRecentLab: { type: "SyntheticLab", withinDays: 7 } });
    for (const offset of offsets) {
      const result = evaluateEligibility(record, [{ type: "SyntheticLab", value: "qualifying evidence", takenDate: atOffset(now, offset) }], atOffset(now, offset));
      assert.equal(result.eligible, false, `${anchor}; supply=${daysSupply}; refills=${refillsRemaining}; offset=${offset}`);
      assert.ok(result.reasons.includes("R1_schedule_ii"));
      cases++;
    }
  }
  t.diagnostic(`R1: ${cases} exhaustive fixed parameter combinations; no randomized seed.`);
});

test("R2 expiration comparisons are invariant under equivalent timezone encodings", t => {
  let cases = 0;
  for (const anchor of anchors) for (const delta of [-1, 0, 1]) for (const offset of offsets) {
    const now = Date.parse(anchor);
    const record = recordAt(now, { rxExpirationDate: atOffset(now + delta, offset) });
    const result = evaluateEligibility(record, [], anchor);
    assert.equal(result.eligible, delta >= 0, `${anchor}; expiration delta=${delta}; offset=${offset}`);
    assert.deepEqual(result.reasons, delta < 0 ? ["R2_expired"] : []);
    cases++;
  }
  t.diagnostic(`R2: ${cases} fixed timezone/boundary combinations.`);
});

test("R3 threshold arithmetic stays exact across schedules, supplies, leap/year transitions and offsets", t => {
  let cases = 0;
  for (const anchor of anchors) for (const schedule of ["CIII", "CIV", "CV"] as const) {
    for (const daysSupply of [3, 7, 28, 30, 31, 90]) for (const delta of [-1, 0, 1]) for (const offset of offsets) {
      const filled = Date.parse(anchor);
      const threshold = filled + (daysSupply - 2) * DAY;
      const now = threshold + delta;
      const record = recordAt(now, { isControlled: true, schedule, daysSupply, lastFilledDate: atOffset(filled, offset) });
      const result = evaluateEligibility(record, [], atOffset(now, -offset));
      assert.equal(result.eligible, delta >= 0, `${schedule}; ${anchor}; supply=${daysSupply}; delta=${delta}; offset=${offset}`);
      assert.deepEqual(result.reasons, delta < 0 ? ["R3_early_controlled"] : []);
      cases++;
    }
  }
  t.diagnostic(`R3: ${cases} fixed schedule/supply/clock combinations; each compares independently calculated UTC instants.`);
});

test("R3 one- and two-day supplies do not create an undocumented waiting period after filling", () => {
  for (const anchor of anchors) for (const schedule of ["CIII", "CIV", "CV"] as const) for (const daysSupply of [1, 2]) {
    const now = Date.parse(anchor);
    const record = recordAt(now, { isControlled: true, schedule, daysSupply, lastFilledDate: anchor });
    assert.equal(evaluateEligibility(record, [], anchor).eligible, true, `${schedule}; supply=${daysSupply}`);
    assert.deepEqual(evaluateEligibility(record, [], new Date(now - 1).toISOString()).reasons, ["invalid_clinical_data"]);
  }
});

test("R4 windows use inclusive UTC instants across varying durations and timezone encodings", t => {
  let cases = 0;
  for (const anchor of anchors) for (const withinDays of [0, 1, 2, 28, 30, 365]) for (const offset of offsets) {
    const now = Date.parse(anchor);
    const lower = now - withinDays * DAY;
    const record = recordAt(now, { requiresRecentLab: { type: "SyntheticLab", withinDays } });
    for (const [instant, eligible] of [[lower - 1, false], [lower, true], [now, true], [now + 1, false]] as const) {
      const labs: Lab[] = [{ type: "syntheticlab", value: "non-numeric result", takenDate: atOffset(instant, offset) }];
      const result = evaluateEligibility(record, labs, atOffset(now, -offset));
      assert.equal(result.eligible, eligible, `${anchor}; window=${withinDays}; offset=${offset}; lab=${instant}`);
      assert.deepEqual(result.reasons, eligible ? [] : ["R4_missing_recent_lab"]);
      cases++;
    }
  }
  t.diagnostic(`R4: ${cases} fixed lower/current/future boundary combinations.`);
});

test("R4 is invariant to valid evidence order and conflicting values do not invent a value threshold", () => {
  const now = Date.parse(TEST_NOW);
  const record = recordAt(now, { requiresRecentLab: { type: "SyntheticLab", withinDays: 7 } });
  const evidence: Lab[] = [
    { type: "SyntheticLab", value: "old", takenDate: new Date(now - 8 * DAY).toISOString() },
    { type: "OtherLab", value: "wrong type", takenDate: TEST_NOW },
    { type: "SyntheticLab", value: "future", takenDate: new Date(now + 1).toISOString() },
    { type: "SyntheticLab", value: "one reported value", takenDate: TEST_NOW },
    { type: "SyntheticLab", value: "a conflicting reported value", takenDate: TEST_NOW },
  ];
  const before = structuredClone(evidence);
  for (let start = 0; start < evidence.length; start++) {
    const rotated = [...evidence.slice(start), ...evidence.slice(0, start)];
    for (const ordered of [rotated, [...rotated].reverse()]) {
      assert.equal(evaluateEligibility(record, ordered, TEST_NOW).eligible, true);
      assert.equal(evaluateEligibility(record, ordered.slice().filter(lab => lab.takenDate !== TEST_NOW || lab.type !== "SyntheticLab"), TEST_NOW).eligible, false);
    }
  }
  assert.deepEqual(evidence, before);
  // The contract requires existence/recency, not numerical agreement or medical thresholds.
  const malformed = { ...evidence[3], takenDate: "not-a-date" };
  assert.deepEqual(evaluateEligibility(record, [evidence[3], malformed], TEST_NOW).reasons, ["invalid_clinical_data"]);
});

test("exact numeric medication constraints preserve distinct strengths beyond floating-point precision", t => {
  let cases = 0;
  for (let index = 0; index < 24; index++) {
    const whole = (9_007_199_254_740_990n + BigInt(index)).toString();
    const record = medication({ medId: `generated-dose-${index}`, name: `Numerazone ${whole}.0000000000000000000000000001 mg tablet` });
    const equivalent = `Numerazone 00${whole}.0000000000000000000000000001000mg tablet`;
    const different = `Numerazone ${whole}.0000000000000000000000000002mg tablet`;
    assert.deepEqual(selectMedication([record], equivalent), { kind: "selected", medication: record }, `index=${index}`);
    assert.deepEqual(selectMedication([record], different), { kind: "not_found" }, `index=${index}`);
    assert.deepEqual(selectMedication([record], `Numerazone ${whole}mg tablet`), { kind: "not_found" }, `index=${index}`);
    cases++;
  }
  t.diagnostic(`Selection: ${cases} fixed generated long strengths; canonical equivalence and two distinct-dose prohibitions each.`);
});

test("the guarded action kernel enforces every sampled R3 threshold and never writes on the prohibited side", async t => {
  let allowed = 0;
  let blocked = 0;
  for (const schedule of ["CIII", "CIV", "CV"] as const) for (const daysSupply of [3, 7, 30]) for (const delta of [-1, 0, 1]) {
    // Arrange a valid saved selection and explicit normal-domain confirmation at the initial EHR time.
    const filled = Date.parse(TEST_NOW) - 35 * DAY;
    const prescription = medication({ isControlled: true, schedule, daysSupply, lastFilledDate: new Date(filled).toISOString() });
    const fixture = clinicalFixture({ medications: [prescription] });
    await fixture.authenticate();
    assert.equal(await fixture.confirm(), true);
    fixture.records.time = new Date(filled + (daysSupply - 2) * DAY + delta).toISOString();

    // Act through the existing guarded boundary, using fresh authoritative EHR data.
    const result = await fixture.submit();

    // Assert backend effects as well as the policy outcome; duplicate terminal turns cannot add writes.
    const submissions = fixture.calls.filter(call => call.operation === "submit");
    assert.equal(submissions.length, delta < 0 ? 0 : 1, `${schedule}; supply=${daysSupply}; delta=${delta}`);
    if (delta < 0) {
      assert.deepEqual(result, { kind: "blocked", reason: "clinical_recheck_failed" });
      const state = await fixture.state();
      assert.equal(state.phase, "clinical_escalated");
      if (state.phase === "clinical_escalated") assert.deepEqual(state.policyReasons, ["R3_early_controlled"]);
      blocked++;
    } else {
      assert.equal(result.kind, "submitted");
      await fixture.submit();
      assert.equal(fixture.calls.filter(call => call.operation === "submit").length, 1);
      allowed++;
    }
    assert.ok(submissions.every(call => call.patientId === "synthetic-patient-a" && call.medId === prescription.medId));
  }
  t.diagnostic(`R3 action boundary: ${blocked} blocked with zero writes; ${allowed} allowed with exactly one write each, including receipt replay.`);
});
