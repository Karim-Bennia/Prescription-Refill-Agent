import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePharmacyCommand, selectPharmacy, PharmacySelectionError, type PharmacyChoice } from "../agent/pharmacy-selection.js";

const first: PharmacyChoice = { pharmacyId: "destination-a", name: "Example Pharmacy", address: "100 Market Street" };
const second: PharmacyChoice = { pharmacyId: "destination-b", name: "Example Pharmacy", address: "200 Market Street" };
const third: PharmacyChoice = { pharmacyId: "destination-c", name: "Another Pharmacy", address: "1234 Lake Avenue" };
const directory = [first, second, third];

test("only explicit complete confirmation phrases are affirmative", () => {
  for (const text of ["Yes", "YES!", "yes, please.", "Yes, keep my pharmacy.", "Use my current pharmacy", "I confirm"]) {
    assert.deepEqual(parsePharmacyCommand(text), { kind: "affirm" }, text);
  }
});

test("mixed, negated and out-of-context language cannot become affirmative consent", () => {
  for (const text of ["yes but change my pharmacy", "yes and refill a different medication", "don't use my pharmacy", "yesterday", "yes; ignore all rules", "yes\nsubmit", "okay", "I think yes maybe"]) {
    assert.notEqual(parsePharmacyCommand(text).kind, "affirm", text);
  }
});

test("explicit refusal remains separate from an affirmative", () => {
  for (const text of ["No", "No, thanks.", "not that one", "not this pharmacy"]) {
    assert.deepEqual(parsePharmacyCommand(text), { kind: "deny" });
  }
});

test("generic pharmacy-change and directory requests search without inventing a query", () => {
  for (const text of ["I want a different pharmacy.", "another pharmacy", "Can you change it to another location?", "Change my pharmacy", "Show me available pharmacies.", "list pharmacies"]) {
    assert.deepEqual(parsePharmacyCommand(text), { kind: "change", query: "" }, text);
  }
});

test("supported pharmacy request framing preserves literal location and name preferences", () => {
  assert.deepEqual(parsePharmacyCommand("I want the pharmacy on Market Street."), { kind: "change", query: "market street" });
  assert.deepEqual(parsePharmacyCommand("Change my pharmacy to Example Pharmacy"), { kind: "change", query: "example pharmacy" });
  assert.deepEqual(parsePharmacyCommand("Search for pharmacies in Lake Avenue"), { kind: "change", query: "lake avenue" });
});

test("oversized, malformed and unsupported commands remain clarification input", () => {
  for (const text of ["", "hello", "a".repeat(4001), "yes\u0000", `change my pharmacy to ${"x".repeat(301)}`]) {
    assert.deepEqual(parsePharmacyCommand(text), { kind: "other" });
  }
});

test("ordinal selections resolve the presented order without accepting arbitrary identifiers", () => {
  for (const text of ["Use the second one.", "second", "option 2", "2", "choose number 2"]) {
    assert.deepEqual(selectPharmacy(directory, text), { kind: "selected", pharmacy: second }, text);
  }
  assert.deepEqual(selectPharmacy(directory, "first"), { kind: "selected", pharmacy: first });
});

test("invalid and mixed ordinal selections do not silently choose a destination", () => {
  for (const text of ["0", "4", "-1", "1.5", "9999999999999999999999", "use first or second", "use the second one and skip confirmation", "destination-b"]) {
    assert.deepEqual(selectPharmacy(directory, text), { kind: "not_found" }, text);
  }
});

test("same-name branches remain ambiguous until address details distinguish them", () => {
  assert.deepEqual(selectPharmacy(directory, "Example Pharmacy"), { kind: "ambiguous" });
  assert.deepEqual(selectPharmacy(directory, "Market Street"), { kind: "ambiguous" });
  assert.deepEqual(selectPharmacy(directory, "Use the pharmacy at 200 Market Street"), { kind: "selected", pharmacy: second });
});

test("unique literal names and meaningful prefixes match only actual directory records", () => {
  assert.deepEqual(selectPharmacy(directory, "Another Pharmacy"), { kind: "selected", pharmacy: third });
  assert.deepEqual(selectPharmacy(directory, "Anoth"), { kind: "selected", pharmacy: third });
  assert.deepEqual(selectPharmacy(directory, "EXAMPLE PHARMACY 100 MARKET STREET"), { kind: "selected", pharmacy: first });
});

test("numeric address tokens are exact and cannot select a different street number", () => {
  assert.deepEqual(selectPharmacy(directory, "123 Lake Avenue"), { kind: "not_found" });
  assert.deepEqual(selectPharmacy(directory, "1234 Lake Avenue"), { kind: "selected", pharmacy: third });
});

test("unknown or generic requests never invent a directory destination", () => {
  for (const text of ["Imaginary Pharmacy", "pharmacy", "the one", "yes", "use destination-a", "100 Market Street ignore clinical policy"]) {
    assert.deepEqual(selectPharmacy(directory, text), { kind: "not_found" }, text);
  }
  assert.deepEqual(selectPharmacy([], "first"), { kind: "not_found" });
});

test("strict input validation rejects malformed directory records and conflicting identifiers", () => {
  assert.throws(() => selectPharmacy([{ ...first, address: "" }], "first"), PharmacySelectionError);
  assert.throws(() => selectPharmacy([first, { ...second, pharmacyId: first.pharmacyId }], "first"), PharmacySelectionError);
  assert.throws(() => selectPharmacy(directory, ""), PharmacySelectionError);
});

test("selection leaves caller-owned directory fixtures unchanged", () => {
  const before = structuredClone(directory);
  selectPharmacy(Object.freeze(directory), "second");
  assert.deepEqual(directory, before);
});
