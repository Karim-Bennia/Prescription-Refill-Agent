import { z } from "zod";
import { medicationListSchema, type Medication } from "./clinical-types.js";

export type SelectionResult =
  | { readonly kind: "selected"; readonly medication: Medication }
  | { readonly kind: "clarify"; readonly candidates: readonly Medication[] }
  | { readonly kind: "not_found" };

export class SelectionError extends Error {
  readonly code = "invalid_selection_input";

  /** Represent invalid medication selection inputs without retaining patient records. */
  constructor() {
    super("Medication selection input is invalid.");
    this.name = "SelectionError";
  }
}

const querySchema = z.string().trim().min(1).max(200)
  .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value))
  .nullable();

// These remove conversational framing, never substitute a medication or indication.
const requestWords = new Set([
  "i", "me", "my", "the", "a", "an", "please", "can", "could", "would", "you",
  "get", "need", "want", "like", "have", "for", "of", "to", "some", "this", "that",
  "refill", "refills", "renew", "renewal", "medication", "medications", "medicine",
  "medicines", "prescription", "prescriptions",
]);
const genericMedicationWords = new Set([
  "medication", "medications", "medicine", "medicines", "prescription", "prescriptions",
]);

// A unit or dosage-form token alone is not sufficient evidence of medication identity.
// No equivalence is inferred between these tokens (for example, XR and extended release).
const attributes = new Set([
  "mg", "mcg", "g", "ml", "l", "iu", "unit", "units", "meq", "mmol", "percent",
  "tablet", "tablets", "capsule", "capsules", "solution", "suspension", "cream",
  "ointment", "patch", "patches", "gel", "spray", "extended", "release", "delayed",
  "immediate", "oral", "topical", "injection", "injectable", "er", "xr", "sr", "cr",
  "dr", "ir",
]);

/** Normalize medication name and dosage tokens without rounding distinct numeric strengths. */
function tokens(value: string): string[] {
  const normalized = value.normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[\u2010-\u2015\u2212]/gu, "-")
    .replace(/([-+])\s+(?=\d|\.\d)/gu, "$1");
  return (normalized.match(/[\p{L}]+|[-+]?(?:\d+(?:\.\d+)?|\.\d+)|%/gu) ?? [])
    .map((token) => {
      if (!/^[-+]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(token)) return token;
      // String arithmetic avoids rounding distinct long numeric strings into the same dose.
      const sign = /^[+-]/u.test(token) ? token[0] : "";
      const unsigned = sign ? token.slice(1) : token;
      const [whole, fraction] = unsigned.split(".");
      const integer = whole.replace(/^0+/u, "") || "0";
      const decimal = fraction?.replace(/0+$/u, "");
      return `${sign}${integer}${decimal ? `.${decimal}` : ""}`;
    });
}

/** Identify meaningful medication-name tokens while excluding framing and dosage attributes. */
function substantive(token: string): boolean {
  return /^\p{L}{3,}$/u.test(token) && !attributes.has(token) && !requestWords.has(token);
}

/** Match exact tokens or substantive name prefixes without weakening dosage constraints. */
function tokenMatches(query: string, candidate: string): boolean {
  if (query === candidate) return true;
  // Prefixes apply only to substantive name tokens, never strength, unit or formulation.
  return substantive(query) && substantive(candidate) && candidate.startsWith(query);
}

/** Require ordered name constraints and exact numeric dosage sequences. */
function matchesInOrder(query: readonly string[], candidate: readonly string[], allowPrefixes = true): boolean {
  /** Extract numeric dosage tokens while preserving their order and signs. */
  const numbers = (values: readonly string[]) => values.filter(value => /^[+-]?\d/u.test(value));
  const constraints = numbers(query);
  if (constraints.length > 0 && constraints.join("/") !== numbers(candidate).join("/")) return false;
  let index = 0;
  for (const token of candidate) {
    if (index < query.length && (query[index] === token || allowPrefixes && tokenMatches(query[index], token))) index++;
  }
  return index === query.length;
}

/** Return a selected owned prescription only when exactly one candidate remains. */
function result(matches: Medication[]): SelectionResult {
  return matches.length === 1
    ? { kind: "selected", medication: matches[0] }
    : { kind: "clarify", candidates: matches };
}

/** Resolve only records supplied by an authenticated EHR lookup; never invent an ID. */
export function selectMedication(medications: readonly Medication[], query: string | null): SelectionResult {
  let records: Medication[];
  let parsedQuery: string | null;
  try {
    records = medicationListSchema.parse(medications);
    parsedQuery = querySchema.parse(query);
  } catch {
    throw new SelectionError();
  }

  if (records.length === 0) return { kind: "not_found" };
  if (parsedQuery === null) return { kind: "clarify", candidates: records };

  const originalTokens = tokens(parsedQuery);
  const queryTokens = originalTokens.filter((token) => !requestWords.has(token));
  if (queryTokens.length === 0) return { kind: "clarify", candidates: records };
  if (!queryTokens.some(substantive)) return { kind: "not_found" };

  const namedRecords = records.map((medication) => ({ medication, tokens: tokens(medication.name) }));
  // Prefer exact complete names. This does not collapse different strengths or formulations.
  const normalizedQuery = queryTokens.join(" ");
  const exact = namedRecords.filter((record) => record.tokens.join(" ") === normalizedQuery);
  if (exact.length > 0) {
    // A complete shorter label does not disambiguate another strength/formulation of the same name.
    return result(namedRecords.filter(record => matchesInOrder(queryTokens, record.tokens, false)).map(record => record.medication));
  }

  const matches = namedRecords.filter((record) => matchesInOrder(queryTokens, record.tokens));
  if (matches.length > 0) return result(matches.map((record) => record.medication));

  // A description such as "my <description> medication" needs a real name/strength.
  // It never maps an indication to a drug, even if the patient has only one record.
  if (originalTokens.some((token) => genericMedicationWords.has(token))
    && !queryTokens.some((token) => /^\d/u.test(token))) {
    return { kind: "clarify", candidates: records };
  }
  return { kind: "not_found" };
}
