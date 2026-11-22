import { createHmac, randomBytes } from "node:crypto";
import {
  isAuthenticated, isTerminal, publicConversationState, requireAuthenticatedPatient, transition, validateConversationState,
  type ConversationState, type RefillRequest,
} from "./conversation-state.js";
import { matchResultSchema, type IdentityMatcher } from "./ehr-client.js";
import {
  extractIdentityFactors, groundIdentityFactors, hasRequiredIdentity, missingIdentityFields,
  validateIdentityFactors, type IdentityFactors,
} from "./identity.js";
import { interpretMessage } from "./interpretation.js";
import type { LanguageInterpreter, Interpretation } from "./intent.js";
import { bindSessionPatient, SessionError, type SessionRepository, type SessionUpdate } from "./sessions.js";
import { InputValidationError, requestSchema, type AgentReply } from "./validation.js";
import { clinicalReply, type PrescriptionWorkflow } from "./clinical-workflow.js";
import { pharmacyReply, type PharmacyWorkflow } from "./pharmacy-workflow.js";
import { parsePharmacyCommand } from "./pharmacy-selection.js";

interface Dependencies {
  readonly matcher: IdentityMatcher;
  readonly interpreter: LanguageInterpreter;
  readonly sessions: SessionRepository;
  readonly clinical?: PrescriptionWorkflow;
  readonly pharmacy?: PharmacyWorkflow;
}
interface Replay { digest: string; stateDigest: string; reply: AgentReply }

const normalize = (value: string): string => value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const isCancel = (text: string): boolean => /^(?:cancel(?:\s+(?:(?:my|this|the)\s+)?(?:request|refill|conversation))?|stop|never\s*mind)[.!]?$/i.test(text);
const isRetry = (text: string): boolean => /^(?:retry|try again|please try again)[.!]?$/i.test(text);
const isSimple = (text: string): boolean => /^(?:yes|no|ok|okay|hello|hi|thanks|thank you)[.!]?$/i.test(text)
  || /^(?:yes[, ]+)?keep my pharmacy[.!]?$/i.test(text);
const mentionsIdentitySwitch = (text: string): boolean => /\b(?:patient\s*id|switch\s+(?:the\s+)?patient|change\s+(?:my\s+)?identity|another\s+patient)\b/i.test(text);
const negativeRefill = (text: string): boolean => /\b(?:do\s+not|don't|dont|never|no\s+longer)\b[\s\S]{0,60}\b(?:refill|renew)\b/i.test(text);

function refillRequest(text: string): RefillRequest | null {
  if (!/\b(?:refill|renew)\b/i.test(text) || /\b(?:do not|don't|not to)\s+(?:refill|renew)\b/i.test(text)) return null;
  const literal = /\b(?:refill|renew)\s+(?:(?:my|the)\s+)?([\s\S]+)$/i.exec(text)?.[1]?.trim().replace(/[.!?]+$/, "");
  const name = literal && literal.length <= 200 ? literal : undefined;
  return { medicationQuery: name && !/^(?:a\s+)?(?:prescription|medication|medicine|request|please)$/i.test(name) ? name : null };
}

function groundedQuery(query: string | null, text: string): string | null {
  return query && normalize(text).includes(normalize(query)) ? query : null;
}

function identityPrompt(factors: IdentityFactors): string {
  const labels: Record<string, string> = {
    firstName: "first name", lastName: "last name", dob: "date of birth (YYYY-MM-DD)",
    "phoneLast4 or zip": "phone ending (last four digits) or ZIP code",
  };
  const missing = missingIdentityFields(factors).map(name => labels[name]);
  return `To verify your identity, please provide your ${missing.length ? missing.join(", ") : "identity details again"}.`;
}

function replyFor(state: ConversationState): string {
  switch (state.phase) {
    case "collecting_identity": return identityPrompt(state.factors);
    case "verifying_identity": return "Identity verification is in progress. No refill has been submitted.";
    case "collecting_request": return "Your details were verified. Which medication would you like to request a refill for? Please include its name and strength.";
    case "ready": return "Your details were verified and your medication request is saved for prescription review. Prescription processing is not available in this phase. No refill has been submitted.";
    case "medication_clarification":
    case "awaiting_pharmacy_confirmation":
    case "clinical_escalated":
    case "refill_submitted": return clinicalReply(state);
    case "closed": return "This conversation has been closed at your request. No further refill will be submitted in this conversation. Please verify any earlier pending request with your care team.";
    case "escalated":
      switch (state.reason) {
        case "authentication_failed": return "I could not verify your identity after several attempts. Please contact your care team directly. No one has been contacted on your behalf.";
        case "identity_change": return "The verified identity cannot be changed in this conversation. Please start a new conversation to verify different details. No one has been contacted on your behalf.";
        case "expired": return "This conversation has expired. Please start a new conversation and verify your identity again. No further refill will be submitted here; please verify any earlier pending request with your care team.";
        default: { const exhaustive: never = state; return exhaustive; }
      }
    default: { const exhaustive: never = state; return exhaustive; }
  }
}

/** Coordinates conversation effects; protected operations stay behind session and action guards. */
export class ConversationEngine {
  readonly #dependencies: Dependencies;
  readonly #replays = new Map<string, Replay>();
  readonly #replayKey = randomBytes(32);

  constructor(dependencies: Dependencies) { this.#dependencies = dependencies; }

  async handleTurn(conversationId: string, patientText: string): Promise<AgentReply> {
    const input = requestSchema.safeParse({ from: "patient", text: patientText });
    if (!input.success) throw new InputValidationError();
    const text = input.data.text;
    const digest = createHmac("sha256", this.#replayKey).update(text).digest("hex");
    const stateDigest = (state: ConversationState): string => createHmac("sha256", this.#replayKey)
      .update(JSON.stringify(validateConversationState(state))).digest("hex");
    return this.#dependencies.sessions.run(conversationId, async (current, context) => {
      const finish = (state: ConversationState, message = replyFor(state), cache = true): SessionUpdate<AgentReply> => {
        const reply: AgentReply = { messages: [{ from: "agent", text: message }], state: publicConversationState(state) };
        if (cache) this.#replays.set(conversationId, { digest, stateDigest: stateDigest(state), reply: structuredClone(reply) });
        else this.#replays.delete(conversationId);
        return { state, result: reply };
      };
      const finishClinical = async (state: ConversationState): Promise<SessionUpdate<AgentReply>> => {
        if (!this.#dependencies.clinical || !isAuthenticated(state)) return finish(state);
        const progress = await this.#dependencies.clinical.advance(state, context);
        if (this.#dependencies.pharmacy && progress.state.phase === "awaiting_pharmacy_confirmation") {
          const pharmacy = await this.#dependencies.pharmacy.prepare(progress.state, context);
          return finish(pharmacy.state, pharmacy.message, pharmacy.cache);
        }
        return finish(progress.state, progress.message, progress.cache);
      };
      // Terminal/expiry rules take precedence over any cached authenticated response.
      if (isTerminal(current)) return finish(current);
      if (this.#dependencies.pharmacy && isAuthenticated(current)) {
        const recovered = await this.#dependencies.pharmacy.recover(current, context);
        if (recovered) return finish(recovered.state, recovered.message, recovered.cache);
      }
      const replay = this.#replays.get(conversationId);
      // A failed repository commit must not make an uncommitted reply authoritative.
      if (replay?.digest === digest && replay.stateDigest === stateDigest(current)) {
        return { state: current, result: structuredClone(replay.reply) };
      }
      if (isCancel(text) || negativeRefill(text)) return finish(transition(current, { type: "cancel" }));
      if (current.phase === "verifying_identity") {
        // A restored/injected unfinished state must not be trusted as authenticated.
        return finish(transition(current, { type: "verification_unavailable" }),
          "Identity verification was interrupted. Please retry your identity details.", false);
      }

      const direct = isSimple(text) || isRetry(text) ? {} : extractIdentityFactors(text,
        current.phase === "collecting_identity" ? current.factors : {});
      const directRequest = refillRequest(text);
      const pharmacyLocation = current.phase === "awaiting_pharmacy_confirmation" && this.#dependencies.pharmacy
        && Object.keys(direct).every(key => key === "zip")
        && (parsePharmacyCommand(text).kind === "change"
          || current.pharmacyContext?.stage === "search" && /^\d{5}(?:-\d{4})?$/.test(text.trim()));
      if (isAuthenticated(current) && (Object.keys(direct).length > 0 && !pharmacyLocation || mentionsIdentitySwitch(text))) {
        return finish(transition(current, { type: "identity_change" }));
      }
      if (current.phase === "medication_clarification" || current.phase === "awaiting_pharmacy_confirmation") {
        if (current.phase === "awaiting_pharmacy_confirmation" && this.#dependencies.pharmacy && !directRequest) {
          // Only a pending pharmacy question can consume affirmative consent. Medication corrections
          // invalidate the entire selection and are re-evaluated by the clinical workflow below.
          const pharmacyTurn = parsePharmacyCommand(text).kind !== "other"
            || /\b(?:pharmacy|pharmacies|location|street|avenue|address)\b|\?|^(?:yes|no|ok|okay|use\b|the\b|retry\b|try again\b|\d+\b)/i.test(text)
            || current.pharmacyContext?.stage === "search";
          if (pharmacyTurn) {
            const progress = await this.#dependencies.pharmacy.handle(current, text, context);
            return finish(progress.state, progress.message, progress.cache);
          }
        }
        // Clinical-only injected compositions have no public write/consent capability.
        if (current.phase === "awaiting_pharmacy_confirmation" && !directRequest
          && (isSimple(text) || /\bpharmacy\b/i.test(text))) return finish(current,
            current.pharmacyContext ? pharmacyReply(current) : replyFor(current));
        if (isSimple(text)) return finish(current);
        const query = directRequest ? directRequest.medicationQuery
          : isRetry(text) ? current.request?.medicationQuery ?? null : text.length <= 200 ? text : null;
        const next = transition(current, { type: "request_updated", request: { medicationQuery: query } });
        return finishClinical(next);
      }
      // Ready means intake is complete, not clinical eligibility or permission to prescribe.
      if (current.phase === "ready") {
        requireAuthenticatedPatient(current);
        const changed = directRequest ?? (this.#dependencies.clinical && !isSimple(text) && !isRetry(text)
          ? { medicationQuery: text.length <= 200 ? text : null } : null);
        return finishClinical(changed ? transition(current, { type: "request_updated", request: changed }) : current);
      }
      if (this.#dependencies.clinical && current.phase === "collecting_request") {
        const query = directRequest ? directRequest.medicationQuery : !isSimple(text) && !isRetry(text) && text.length <= 200 ? text : null;
        return finishClinical(transition(current, { type: "request_updated", request: { medicationQuery: query } }));
      }

      let proposal: Interpretation | undefined;
      const unresolvedName = current.phase === "collecting_identity"
        && !hasRequiredIdentity({ ...current.factors, ...direct })
        && /\b(?:legal name|full name|called|given name|surname)\b/i.test(text);
      const needsModel = (Object.keys(direct).length === 0 || unresolvedName) && directRequest === null
        && !isSimple(text) && !isRetry(text) && !mentionsIdentitySwitch(text);
      if (needsModel) {
        try { proposal = (await interpretMessage(this.#dependencies.interpreter, text)).interpretation; }
        catch {
          return finish(current, "I could not interpret that message safely. Please try again using clear identity details or a medication name.", false);
        }
      }
      const grounded = proposal ? groundIdentityFactors(proposal.identity, text) : {};
      const supplied = validateIdentityFactors({ ...grounded, ...direct });
      const proposedRequest: RefillRequest | null = proposal?.intent === "refill_request"
        ? { medicationQuery: this.#dependencies.clinical ? text.length <= 200 ? text : null
          : groundedQuery(proposal.medicationQuery, text) } : null;
      const request = directRequest ?? proposedRequest;

      if (current.phase === "collecting_request") {
        requireAuthenticatedPatient(current);
        if (Object.keys(supplied).length > 0) return finish(transition(current, { type: "identity_change" }));
        const query = request?.medicationQuery ?? (proposal ? groundedQuery(proposal.medicationQuery, text) : null);
        return finishClinical(query ? transition(current, { type: "request_updated", request: { medicationQuery: query } }) : current);
      }

      let state = transition(current, {
        type: "context_updated", factors: validateIdentityFactors({ ...current.factors, ...supplied }),
        request: this.#dependencies.clinical && request ? request : request?.medicationQuery ? request : current.request ?? request,
      });
      if (!hasRequiredIdentity(state.phase === "collecting_identity" ? state.factors : {})) return finish(state);
      // Do not re-submit retained data on an unrelated turn following a dependency error.
      if (Object.keys(supplied).length === 0 && !isRetry(text)) return finish(state);
      state = transition(state, { type: "verify_requested" });
      if (state.phase !== "verifying_identity") throw new Error("Unexpected authentication transition.");
      try {
        // Revalidate even fake/injected implementations. Only this service result binds the ID.
        const result = matchResultSchema.safeParse(await this.#dependencies.matcher.match(state.factors));
        if (!result.success) throw new Error("Invalid identity service result.");
        if (result.data.count === 1 && result.data.patientId !== null) {
          const matched = transition(state, { type: "match_succeeded", patientId: result.data.patientId });
          if (context) bindSessionPatient(context, matched);
          return finishClinical(matched);
        }
        const rejected = transition(state, { type: "match_rejected" });
        return finish(rejected, rejected.phase === "escalated" ? replyFor(rejected)
          : "I could not verify those details. Please check and provide your first and last name, date of birth, and phone ending or ZIP code again.");
      } catch {
        return finish(transition(state, { type: "verification_unavailable" }),
          "Identity verification is temporarily unavailable. Please retry; no identity has been verified.", false);
      }
    }).catch((error: unknown) => {
      if (!(error instanceof SessionError) || error.code !== "expired") throw error;
      this.#replays.delete(conversationId);
      const expired: ConversationState = { phase: "escalated", reason: "expired" };
      const reply: AgentReply = { messages: [{ from: "agent", text: replyFor(expired) }], state: "escalated" };
      return reply;
    });
  }
}
