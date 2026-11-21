import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clinicalDate, ehrTimeSchema, labListSchema, medicationListSchema, medicationSchema,
  pharmacySchema, refillReceiptSchema, type Lab, type Medication,
} from "../agent/clinical-types.js";
import { evaluateEligibility } from "../agent/policy.js";

const NOW = "2031-06-30T12:00:00.000Z";
const DAY = 86_400_000;
const medication = (updates: Partial<Medication> = {}): Medication => ({
  medId: "synthetic-medication", name: "Example medicine 5mg", isControlled: false, schedule: null,
  lastFilledDate: "2031-06-01T12:00:00.000Z", daysSupply: 30, refillsRemaining: 3,
  rxExpirationDate: "2032-01-01", requiresRecentLab: null, ...updates,
});
const lab = (updates: Partial<Lab> = {}): Lab => ({ type: "ExampleLab", value: "2.4", takenDate: NOW, ...updates });
const withLab = () => medication({ requiresRecentLab: { type: "ExampleLab", withinDays: 30 } });

test("invalid lab evidence or unrepresentable lookback cannot grant eligibility", async t => {
  await t.test("empty result is missing safety data", () => {
    assert.equal(evaluateEligibility(withLab(), [lab({ value: "" })], NOW).eligible, false);
  });
  await t.test("lookback outside the representable date range fails closed", () => {
    const record = medication({ requiresRecentLab: { type: "ExampleLab", withinDays: 104_000_000 } });
    assert.equal(evaluateEligibility(record, [lab()], NOW).eligible, false);
  });
});

test("clinical dates require real calendar dates or explicit timezone timestamps", () => {
  // Arrange / Act / Assert: parsing never consults the host's current date.
  assert.equal(clinicalDate("2000-02-29"), Date.parse("2000-02-29T00:00:00Z"));
  assert.equal(clinicalDate("2031-06-30T14:00:00+02:00"), clinicalDate(NOW));
  assert.equal(clinicalDate("2031-06-30T07:00:00-05:00"), clinicalDate(NOW));
  for (const value of ["2031-02-29", "2031-02-30T12:00:00Z", "2031-13-01", "2031-06-30T24:00:00Z", "2031-06-30T12:60:00Z", "2031-06-30T12:00:60Z", "2031-06-30T12:00:00", "2031-06-30T12:00:00+24:00", "June 30, 2031", ""]) {
    assert.equal(clinicalDate(value), undefined, value);
  }
});

test("clinical response schemas reject missing/extra fields, duplicate IDs and fabricated statuses", () => {
  const valid = medication();
  assert.equal(medicationSchema.safeParse(valid).success, true);
  assert.equal(medicationListSchema.safeParse([valid, { ...valid, name: "Conflicting medicine" }]).success, false);
  assert.equal(medicationListSchema.safeParse([valid, { ...valid, medId: "second-owned-record" }]).success, true);
  assert.equal(medicationListSchema.safeParse([]).success, true);
  assert.equal(ehrTimeSchema.safeParse({ now: NOW }).success, true);
  assert.equal(ehrTimeSchema.safeParse({ now: "not-a-date" }).success, false);
  assert.equal(ehrTimeSchema.safeParse({ now: NOW, override: true }).success, false);
  assert.equal(pharmacySchema.safeParse(null).success, true);
  assert.equal(pharmacySchema.safeParse({ pharmacyId: "branch-1", name: "Example Pharmacy" }).success, true);
  assert.equal(refillReceiptSchema.safeParse({ refillId: "receipt-1", status: "submitted" }).success, true);
  for (const status of ["accepted", "pending", "approved", "complete", "denied"]) {
    assert.equal(refillReceiptSchema.safeParse({ refillId: "receipt-1", status }).success, false);
  }
});

test("eligible non-controlled medication has an immutable allow decision", () => {
  // Arrange
  const input = medication();
  const before = structuredClone(input);
  // Act
  const result = evaluateEligibility(input, [], NOW);
  // Assert
  assert.deepEqual(result, { eligible: true, reasons: [] });
  assert.deepEqual(input, before);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.reasons), true);
});

test("R1 Schedule II always blocks regardless of remaining refills", () => {
  // R1 has no allowing case for CII; non-CII controls are exercised separately.
  for (const refillsRemaining of [0, 1, 10]) {
    const result = evaluateEligibility(medication({ isControlled: true, schedule: "CII", refillsRemaining }), [], NOW);
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.includes("R1_schedule_ii"));
    assert.equal(result.reasons.includes("R3_early_controlled"), false);
  }
});

test("R2 independently blocks zero refills or expiration strictly before EHR now", () => {
  const expired = new Date(Date.parse(NOW) - 1).toISOString();
  assert.deepEqual(evaluateEligibility(medication({ refillsRemaining: 0 }), [], NOW).reasons, ["R2_no_refills"]);
  assert.deepEqual(evaluateEligibility(medication({ rxExpirationDate: expired }), [], NOW).reasons, ["R2_expired"]);
  assert.deepEqual(evaluateEligibility(medication({ refillsRemaining: 0, rxExpirationDate: expired }), [], NOW).reasons, ["R2_no_refills", "R2_expired"]);
});

test("R2 expiration equality is allowed and date-only expiration is UTC midnight", () => {
  assert.equal(evaluateEligibility(medication({ rxExpirationDate: NOW }), [], NOW).eligible, true);
  assert.equal(evaluateEligibility(medication({ rxExpirationDate: "2031-06-30" }), [], "2031-06-30T00:00:00.000Z").eligible, true);
  assert.deepEqual(evaluateEligibility(medication({ rxExpirationDate: "2031-06-30" }), [], NOW).reasons, ["R2_expired"]);
});

test("R3 controlled early-refill boundary applies to each CIII–CV schedule", () => {
  const boundary = Date.parse("2031-06-29T12:00:00.000Z");
  for (const schedule of ["CIII", "CIV", "CV"] as const) {
    const record = medication({ isControlled: true, schedule });
    const before = evaluateEligibility(record, [], new Date(boundary - 1).toISOString());
    assert.deepEqual(before.reasons, ["R3_early_controlled"], schedule);
    assert.equal(evaluateEligibility(record, [], new Date(boundary).toISOString()).eligible, true, schedule);
    assert.equal(evaluateEligibility(record, [], new Date(boundary + 1).toISOString()).eligible, true, schedule);
  }
});

test("R3 does not impose an undocumented early-refill rule on non-controlled medication", () => {
  assert.equal(evaluateEligibility(medication(), [], "2031-06-02T12:00:00Z").eligible, true);
});

test("R4 required lab must match type and lie inside the inclusive EHR-time window", () => {
  const cutoff = Date.parse(NOW) - 30 * DAY;
  const record = withLab();
  assert.equal(evaluateEligibility(record, [lab({ takenDate: new Date(cutoff).toISOString() })], NOW).eligible, true);
  assert.deepEqual(evaluateEligibility(record, [lab({ takenDate: new Date(cutoff - 1).toISOString() })], NOW).reasons, ["R4_missing_recent_lab"]);
  assert.equal(evaluateEligibility(record, [lab({ type: "examplelab" })], NOW).eligible, true);
  assert.deepEqual(evaluateEligibility(record, [lab({ type: "OtherLab" })], NOW).reasons, ["R4_missing_recent_lab"]);
  assert.deepEqual(evaluateEligibility(record, [], NOW).reasons, ["R4_missing_recent_lab"]);
});

test("R4 rejects future evidence but allows a fresh matching record among stale/future records", () => {
  const future = lab({ takenDate: new Date(Date.parse(NOW) + 1).toISOString() });
  const stale = lab({ takenDate: "2031-01-01" });
  assert.deepEqual(evaluateEligibility(withLab(), [future], NOW).reasons, ["R4_missing_recent_lab"]);
  assert.equal(evaluateEligibility(withLab(), [stale, future, lab()], NOW).eligible, true);
});

test("R4 zero-day window requires an exact current instant and no lab-value threshold is invented", () => {
  const record = medication({ requiresRecentLab: { type: "ExampleLab", withinDays: 0 } });
  assert.equal(evaluateEligibility(record, [lab()], NOW).eligible, true);
  assert.equal(evaluateEligibility(record, [lab({ value: "no numerical interpretation" })], NOW).eligible, true);
  assert.deepEqual(evaluateEligibility(record, [lab({ takenDate: new Date(Date.parse(NOW) - 1).toISOString() })], NOW).reasons, ["R4_missing_recent_lab"]);
});

test("all applicable documented reasons are preserved without a permissive short circuit", () => {
  const record = medication({
    isControlled: true, schedule: "CIV", refillsRemaining: 0,
    lastFilledDate: "2031-06-29T12:00:00Z", rxExpirationDate: "2031-06-29T12:00:00Z",
    requiresRecentLab: { type: "ExampleLab", withinDays: 30 },
  });
  assert.deepEqual(evaluateEligibility(record, [], NOW), {
    eligible: false, reasons: ["R2_no_refills", "R2_expired", "R3_early_controlled", "R4_missing_recent_lab"],
  });
});

test("missing or malformed safety data fails closed for every required medication input", () => {
  const valid = medication();
  for (const field of ["isControlled", "schedule", "lastFilledDate", "daysSupply", "refillsRemaining", "rxExpirationDate", "requiresRecentLab"] as const) {
    const missing: Record<string, unknown> = { ...valid };
    delete missing[field];
    assert.deepEqual(evaluateEligibility(missing, [], NOW), { eligible: false, reasons: ["invalid_clinical_data"] }, field);
  }
  for (const malformed of [
    { ...valid, daysSupply: 0 }, { ...valid, daysSupply: -1 }, { ...valid, daysSupply: 1.5 },
    { ...valid, refillsRemaining: -1 }, { ...valid, refillsRemaining: "3" },
    { ...valid, lastFilledDate: "2031-02-30" }, { ...valid, rxExpirationDate: "2031-06-30T12:00:00" },
    { ...valid, requiresRecentLab: { type: "ExampleLab", withinDays: -1 } },
    { ...valid, requiresRecentLab: { type: "", withinDays: 30 } },
  ]) assert.deepEqual(evaluateEligibility(malformed, [], NOW).reasons, ["invalid_clinical_data"]);
});

test("missing/invalid EHR time or lab response never grants permission", () => {
  for (const now of [undefined, null, "invalid", "2031-02-30", { now: NOW }]) {
    assert.deepEqual(evaluateEligibility(medication(), [], now).reasons, ["invalid_clinical_data"]);
  }
  for (const labs of [undefined, null, {}, [{ ...lab(), takenDate: "not-a-date" }], [{ ...lab(), unexpected: true }]]) {
    assert.deepEqual(evaluateEligibility(withLab(), labs, NOW).reasons, ["invalid_clinical_data"]);
    assert.equal(labListSchema.safeParse(labs).success, false);
  }
});

test("conflicting controlled flags, future fills and arithmetic overflow fail closed", () => {
  for (const record of [
    medication({ isControlled: true, schedule: null }),
    medication({ isControlled: false, schedule: "CII" }),
    medication({ lastFilledDate: "2031-07-01" }),
    medication({ daysSupply: Number.MAX_SAFE_INTEGER }),
    medication({ requiresRecentLab: { type: "ExampleLab", withinDays: Number.MAX_SAFE_INTEGER } }),
  ]) assert.deepEqual(evaluateEligibility(record, [], NOW).reasons, ["invalid_clinical_data"]);
});

test("untrusted extra status/approval/policy fields cannot override clinical evaluation", () => {
  for (const extra of [{ eligible: true }, { approved: true }, { status: "active" }, { policyOverride: "allow" }]) {
    const candidate = { ...medication({ refillsRemaining: 0 }), ...extra };
    assert.deepEqual(evaluateEligibility(candidate, [], NOW), { eligible: false, reasons: ["invalid_clinical_data"] });
  }
});

test("policy decisions depend only on supplied EHR time and do not mutate lab records", () => {
  const input = [lab()];
  const before = structuredClone(input);
  const record = withLab();
  const actual = evaluateEligibility(record, input, NOW);
  assert.equal(actual.eligible, true);
  assert.equal(evaluateEligibility(record, input, "2032-06-30T12:00:00Z").eligible, false);
  assert.deepEqual(evaluateEligibility(record, input, NOW), actual);
  assert.deepEqual(input, before);
});
