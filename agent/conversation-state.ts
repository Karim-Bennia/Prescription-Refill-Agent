import { z } from "zod";
import { hasRequiredIdentity, identityFactorsSchema } from "./identity.js";
import { refillReceiptSchema } from "./clinical-types.js";
import { policyReasonSchema } from "./policy.js";

export const MAX_AUTH_ATTEMPTS = 5;

const medicationQuerySchema = z.string().trim().min(1).max(200);
export const refillRequestSchema = z.strictObject({ medicationQuery: medicationQuerySchema.nullable() });
export type RefillRequest = z.infer<typeof refillRequestSchema>;

const identityContext = {
  factors: identityFactorsSchema,
  request: refillRequestSchema.nullable(),
  failures: z.number().int().min(0).max(MAX_AUTH_ATTEMPTS - 1),
};
const patientIdSchema = z.string().trim().min(1).max(256);
const selectedRequestSchema = z.strictObject({ medicationQuery: medicationQuerySchema });
const candidateSchema = z.strictObject({ medId: z.string().min(1).max(200), name: z.string().min(1).max(300) });

export const conversationStateSchema = z.discriminatedUnion("phase", [
  z.strictObject({ phase: z.literal("collecting_identity"), ...identityContext }),
  z.strictObject({ phase: z.literal("verifying_identity"), ...identityContext })
    .refine(state => hasRequiredIdentity(state.factors)),
  z.strictObject({ phase: z.literal("collecting_request"), patientId: patientIdSchema, request: z.null() }),
  z.strictObject({
    phase: z.literal("ready"), patientId: patientIdSchema,
    request: z.strictObject({ medicationQuery: medicationQuerySchema }),
  }),
  z.strictObject({
    phase: z.literal("escalated"),
    reason: z.enum(["authentication_failed", "identity_change", "expired"]),
  }),
  z.strictObject({ phase: z.literal("closed"), reason: z.literal("cancelled") }),
  z.strictObject({
    phase: z.literal("medication_clarification"), patientId: patientIdSchema,
    request: refillRequestSchema.nullable(), candidates: z.array(candidateSchema).max(1000),
  }),
  z.strictObject({
    phase: z.literal("awaiting_pharmacy_confirmation"), patientId: patientIdSchema,
    request: selectedRequestSchema, medId: z.string().min(1).max(200), medicationName: z.string().min(1).max(300),
  }),
  z.strictObject({
    phase: z.literal("clinical_escalated"), patientId: patientIdSchema,
    reason: z.enum(["policy_blocked", "invalid_data", "no_prescriptions", "refill_unknown", "refill_rejected"]),
    policyReasons: z.array(policyReasonSchema).max(6),
  }),
  z.strictObject({
    phase: z.literal("refill_submitted"), patientId: patientIdSchema,
    medId: z.string().min(1).max(200), pharmacyId: z.string().min(1).max(200),
    receipt: refillReceiptSchema,
  }),
]);

export type ConversationState = z.infer<typeof conversationStateSchema>;
export type AuthenticatedState = Extract<ConversationState, {
  phase: "collecting_request" | "ready" | "medication_clarification" | "awaiting_pharmacy_confirmation";
}>;

const eventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("context_updated"), factors: identityFactorsSchema, request: refillRequestSchema.nullable() }),
  z.strictObject({ type: z.literal("verify_requested") }),
  z.strictObject({ type: z.literal("match_succeeded"), patientId: patientIdSchema }),
  z.strictObject({ type: z.literal("match_rejected") }),
  z.strictObject({ type: z.literal("verification_unavailable") }),
  z.strictObject({ type: z.literal("request_updated"), request: refillRequestSchema }),
  z.strictObject({ type: z.literal("cancel") }),
  z.strictObject({ type: z.literal("identity_change") }),
  z.strictObject({ type: z.literal("medication_clarification"), request: refillRequestSchema.nullable(), candidates: z.array(candidateSchema).max(1000) }),
  z.strictObject({ type: z.literal("prescription_eligible"), request: selectedRequestSchema, medId: z.string().min(1).max(200), medicationName: z.string().min(1).max(300) }),
  z.strictObject({
    type: z.literal("clinical_stop"),
    reason: z.enum(["policy_blocked", "invalid_data", "no_prescriptions", "refill_unknown", "refill_rejected"]),
    policyReasons: z.array(policyReasonSchema).max(6),
  }),
  z.strictObject({ type: z.literal("refill_submitted"), pharmacyId: z.string().min(1).max(200), receipt: refillReceiptSchema }),
]);
export type ConversationEvent = z.infer<typeof eventSchema>;

export class InvalidTransitionError extends Error {
  constructor() { super("Invalid conversation state transition."); this.name = "InvalidTransitionError"; }
}

export class InvalidConversationStateError extends Error {
  constructor() { super("Invalid conversation state."); this.name = "InvalidConversationStateError"; }
}

export class UnauthorizedSessionError extends Error {
  constructor() { super("Patient authentication is required."); this.name = "UnauthorizedSessionError"; }
}

export function validateConversationState(value: unknown): ConversationState {
  const parsed = conversationStateSchema.safeParse(value);
  if (!parsed.success) throw new InvalidConversationStateError();
  return parsed.data;
}

export function createInitialState(): ConversationState {
  return { phase: "collecting_identity", factors: {}, request: null, failures: 0 };
}

export function isAuthenticated(state: ConversationState): state is AuthenticatedState {
  return state.phase === "collecting_request" || state.phase === "ready"
    || state.phase === "medication_clarification" || state.phase === "awaiting_pharmacy_confirmation";
}

export function isTerminal(state: ConversationState): state is Extract<ConversationState, {
  phase: "escalated" | "closed" | "clinical_escalated" | "refill_submitted";
}> {
  return state.phase === "escalated" || state.phase === "closed"
    || state.phase === "clinical_escalated" || state.phase === "refill_submitted";
}

export function requireAuthenticatedPatient(state: ConversationState): string {
  const validated = validateConversationState(state);
  if (!isAuthenticated(validated)) throw new UnauthorizedSessionError();
  return validated.patientId;
}

export function publicConversationState(state: ConversationState): "in_progress" | "complete" | "escalated" {
  switch (state.phase) {
    case "collecting_identity":
    case "verifying_identity":
    case "collecting_request":
    case "ready":
    case "medication_clarification":
    case "awaiting_pharmacy_confirmation": return "in_progress";
    case "escalated": return "escalated";
    case "clinical_escalated": return "escalated";
    case "closed":
    case "refill_submitted": return "complete";
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

function authenticatedRequest(patientId: string, request: RefillRequest | null): ConversationState {
  return request?.medicationQuery
    ? { phase: "ready", patientId, request: { medicationQuery: request.medicationQuery } }
    : { phase: "collecting_request", patientId, request: null };
}

/** Pure transition evaluation. EHR and model calls belong in the orchestrator. */
export function transition(state: ConversationState, event: ConversationEvent): ConversationState {
  const current = validateConversationState(state);
  const parsedEvent = eventSchema.safeParse(event);
  if (!parsedEvent.success || isTerminal(current)) throw new InvalidTransitionError();
  const input = parsedEvent.data;
  switch (input.type) {
    case "context_updated":
      if (current.phase !== "collecting_identity") throw new InvalidTransitionError();
      return { ...current, factors: input.factors, request: input.request };
    case "verify_requested":
      if (current.phase !== "collecting_identity" || !hasRequiredIdentity(current.factors)) throw new InvalidTransitionError();
      return { ...current, phase: "verifying_identity" };
    case "match_succeeded":
      if (current.phase !== "verifying_identity") throw new InvalidTransitionError();
      return authenticatedRequest(input.patientId, current.request);
    case "match_rejected": {
      if (current.phase !== "verifying_identity") throw new InvalidTransitionError();
      const failures = current.failures + 1;
      if (failures >= MAX_AUTH_ATTEMPTS) return { phase: "escalated", reason: "authentication_failed" };
      // Discard rejected factors rather than reusing a mixed identity on correction.
      return { phase: "collecting_identity", factors: {}, request: current.request, failures };
    }
    case "verification_unavailable":
      if (current.phase !== "verifying_identity") throw new InvalidTransitionError();
      return { ...current, phase: "collecting_identity" };
    case "request_updated":
      if (!isAuthenticated(current)) throw new InvalidTransitionError();
      return authenticatedRequest(current.patientId, input.request);
    case "cancel":
      return { phase: "closed", reason: "cancelled" };
    case "identity_change":
      if (!isAuthenticated(current)) throw new InvalidTransitionError();
      return { phase: "escalated", reason: "identity_change" };
    case "medication_clarification":
      if (!isAuthenticated(current)) throw new InvalidTransitionError();
      return { phase: "medication_clarification", patientId: current.patientId, request: input.request, candidates: input.candidates };
    case "prescription_eligible":
      if (!isAuthenticated(current)) throw new InvalidTransitionError();
      return { phase: "awaiting_pharmacy_confirmation", patientId: current.patientId,
        request: input.request, medId: input.medId, medicationName: input.medicationName };
    case "clinical_stop":
      if (!isAuthenticated(current)) throw new InvalidTransitionError();
      return { phase: "clinical_escalated", patientId: current.patientId, reason: input.reason, policyReasons: input.policyReasons };
    case "refill_submitted":
      if (current.phase !== "awaiting_pharmacy_confirmation") throw new InvalidTransitionError();
      return { phase: "refill_submitted", patientId: current.patientId, medId: current.medId,
        pharmacyId: input.pharmacyId, receipt: input.receipt };
    default: {
      const exhaustive: never = input;
      throw new InvalidTransitionError();
    }
  }
}
