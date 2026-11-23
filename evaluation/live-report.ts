import { interpretationSchema } from "../agent/intent.js";
import type { LiveModelExpectation } from "./live-scenarios.js";

/** Normalize labeled synthetic query fields for exact comparison without clinical inference. */
const normalized = (value: string | null | undefined) => value?.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase() ?? null;

/** Strict query agreement is deliberately distinct from successful deterministic medication selection. */
export function scoreModelProposal(expected: LiveModelExpectation, value: unknown) {
  const parsed = interpretationSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid interpretation metric.");
  const proposal = parsed.data;
  const intentCorrect = proposal.intent === expected.expectedIntent;
  const medicationQueryExact = expected.medicationQuery === undefined ? null : normalized(expected.medicationQuery) === normalized(proposal.medicationQuery);
  const pharmacyQueryExact = expected.pharmacyQuery === undefined ? null : normalized(expected.pharmacyQuery) === normalized(proposal.pharmacyQuery);
  const identity = Object.entries(expected.identity ?? {}).map(([field, factor]) =>
    normalized(factor) === normalized(proposal.identity[field as keyof typeof proposal.identity]));
  return { intentCorrect, medicationQueryExact, pharmacyQueryExact,
    identityFields: { correct: identity.filter(Boolean).length, total: identity.length },
    allLabeledFieldsCorrect: intentCorrect && medicationQueryExact !== false && pharmacyQueryExact !== false && identity.every(Boolean) };
}

/** Aggregate labeled interpretation correctness while retaining unobserved-case denominators. */
export function summarizeModelScores(scores: readonly ReturnType<typeof scoreModelProposal>[], plannedLabels: number) {
  if (!Number.isSafeInteger(plannedLabels) || plannedLabels < scores.length) throw new Error("Invalid metric denominator.");
  /** Count correct boolean labels alongside their explicit sample total. */
  const fraction = (values: readonly boolean[]) => ({ correct: values.filter(Boolean).length, total: values.length });
  return { plannedLabels, observedLabels: scores.length, unobservedLabels: plannedLabels - scores.length,
    intent: fraction(scores.map(score => score.intentCorrect)),
    medicationQueryExact: fraction(scores.flatMap(score => score.medicationQueryExact === null ? [] : [score.medicationQueryExact])),
    pharmacyQueryExact: fraction(scores.flatMap(score => score.pharmacyQueryExact === null ? [] : [score.pharmacyQueryExact])),
    identityFields: { correct: scores.reduce((sum, score) => sum + score.identityFields.correct, 0),
      total: scores.reduce((sum, score) => sum + score.identityFields.total, 0) },
    allLabeledFields: fraction(scores.map(score => score.allLabeledFieldsCorrect)) };
}

// Only JSON-compatible reports are accepted; object keys and string values are redacted.
// Secret-bearing property names are never persisted with their original values.
/** Create a JSON-safe report with configured secrets and credential-bearing fields redacted. */
export function redactReport(value: unknown, secrets: readonly string[]): unknown {
  const tokens = [...new Set(secrets.filter(secret => secret.length > 0))].sort((a, b) => b.length - a.length);
  /** Replace every configured secret occurrence before persisting a report string. */
  const redact = (text: string) => tokens.reduce((result, secret) => result.split(secret).join("[REDACTED]"), text);
  const sensitiveName = /^(?:authorization|headers|api[-_]?key|groq[-_]?api[-_]?key|ehr[-_]?api[-_]?key|pharmacy[-_]?api[-_]?key|password|access[-_]?token)$/iu;
  const ancestors = new Set<object>();
  /** Recursively redact supported JSON values while rejecting cycles and excessive nesting. */
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > 30) throw new Error("Evaluation report exceeds its nesting limit.");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string") return redact(item);
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (item === undefined) return null;
    if (typeof item !== "object" || ancestors.has(item)) throw new Error("Invalid evaluation report.");
    ancestors.add(item);
    try {
      if (Array.isArray(item)) return item.map(child => visit(child, depth + 1));
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error("Invalid evaluation report.");
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [redact(key), sensitiveName.test(key) ? "[REDACTED]" : visit(child, depth + 1)]));
    } finally { ancestors.delete(item); }
  };
  return visit(value, 0);
}
