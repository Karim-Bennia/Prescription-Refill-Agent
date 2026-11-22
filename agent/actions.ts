import { ClinicalEhrError, type ClinicalEhr } from "./clinical-ehr.js";
import { refillReceiptSchema, type RefillReceipt } from "./clinical-types.js";
import { transition, type ConversationState } from "./conversation-state.js";
import { assertSavedPharmacyPrompt, assertSessionEvidence, assertSessionPatient, sessionSelectionVersion, SessionError, type SessionContext } from "./sessions.js";
import { PatientClinicalReader, assessMedication } from "./patient-clinical.js";
import { selectMedication } from "./selection.js";

interface Scope { patientId: string; medId: string; pharmacyId: string; query: string; medicationName: string; revision: number }
type Record =
  | { kind: "confirmed" | "pending" | "unknown" | "rejected"; scope: Scope }
  | { kind: "submitted"; scope: Scope; receipt: RefillReceipt };
export type RefillOutcome =
  | { kind: "blocked"; reason: "pharmacy_confirmation_required" | "invalid_context" | "clinical_recheck_failed" }
  | { kind: "submitted"; receipt: RefillReceipt }
  | { kind: "unknown" | "rejected" };
export interface ActionResult { state: ConversationState; outcome: RefillOutcome }

function sameScope(first: Scope, second: Scope): boolean {
  return first.patientId === second.patientId && first.medId === second.medId
    && first.pharmacyId === second.pharmacyId && first.query === second.query
    && first.medicationName === second.medicationName && first.revision === second.revision;
}

/** Final refill authorization boundary; the conversation layer cannot submit directly to EHR. */
export class RefillActions {
  readonly #records = new Map<string, Record>();
  readonly #inflight = new Map<string, Promise<ActionResult>>();
  readonly #reader: PatientClinicalReader;
  readonly #ehr: ClinicalEhr;
  constructor(ehr: ClinicalEhr) { this.#ehr = ehr; this.#reader = new PatientClinicalReader(ehr); }

  /** Restore retained facts before accepting a new intent after an interrupted session commit.
   * This performs no service operation and does not grant new clinical authorization. */
  async recoverRecorded(state: ConversationState, context: SessionContext | undefined): Promise<ActionResult | undefined> {
    const record = context && this.#records.get(context.conversationId);
    if (!record || record.kind === "confirmed") return undefined;
    const patientId = assertSessionPatient(context, state);
    if (record.scope.patientId !== patientId) throw new SessionError("invalid_state");
    if (record.kind === "pending") {
      const pending = this.#inflight.get(context!.conversationId);
      if (pending) return pending;
    }
    if (record.kind === "submitted") {
      return { state: { phase: "refill_submitted", patientId, medId: record.scope.medId,
        pharmacyId: record.scope.pharmacyId, receipt: record.receipt }, outcome: { kind: "submitted", receipt: record.receipt } };
    }
    const kind = record.kind === "rejected" ? "rejected" : "unknown";
    return { state: transition(state, { type: "clinical_stop", reason: kind === "rejected" ? "refill_rejected" : "refill_unknown", policyReasons: [] }),
      outcome: { kind } };
  }

  async confirmCurrentPharmacy(
    state: ConversationState, context: SessionContext | undefined, pharmacyId: string,
  ): Promise<boolean> {
    const patientId = assertSessionPatient(context, state);
    if (state.phase !== "awaiting_pharmacy_confirmation") return false;
    if (state.pharmacyContext) {
      assertSavedPharmacyPrompt(context, state);
      if (state.pharmacyContext.stage !== "confirm_current" || state.pharmacyContext.pharmacy.pharmacyId !== pharmacyId) return false;
    }
    const revision = sessionSelectionVersion(context, state);
    if (revision === undefined) return false;
    const existing = this.#records.get(context!.conversationId);
    if (existing && existing.kind !== "confirmed") return false;
    const pharmacy = await this.#reader.pharmacy(state, context);
    assertSessionPatient(context, state);
    if (this.#records.get(context!.conversationId) !== existing
      || sessionSelectionVersion(context, state) !== revision
      || !pharmacy || pharmacy.pharmacyId !== pharmacyId) return false;
    this.#records.set(context!.conversationId, { kind: "confirmed", scope: {
      patientId, medId: state.medId, pharmacyId, query: state.request.medicationQuery, medicationName: state.medicationName, revision,
    } });
    return true;
  }

  async submit(state: ConversationState, context: SessionContext | undefined): Promise<ActionResult> {
    const existing = context && this.#records.get(context.conversationId);
    // A terminal receipt is replayable only with this service's retained submission evidence.
    if (state.phase === "refill_submitted" && existing?.kind === "submitted"
      && existing.scope.patientId === state.patientId && existing.scope.medId === state.medId
      && existing.scope.pharmacyId === state.pharmacyId
      && existing.receipt.refillId === state.receipt.refillId) {
      assertSessionEvidence(context, state.patientId);
      return { state, outcome: { kind: "submitted", receipt: existing.receipt } };
    }
    const patientId = assertSessionPatient(context, state);
    if (state.phase !== "awaiting_pharmacy_confirmation") return { state, outcome: { kind: "blocked", reason: "invalid_context" } };
    if (state.pharmacyContext) {
      assertSavedPharmacyPrompt(context, state);
      if (state.pharmacyContext.stage !== "confirm_current") return { state, outcome: { kind: "blocked", reason: "invalid_context" } };
    }
    const revision = sessionSelectionVersion(context, state);
    if (revision === undefined) return { state, outcome: { kind: "blocked", reason: "invalid_context" } };
    if (!existing) return { state, outcome: { kind: "blocked", reason: "pharmacy_confirmation_required" } };
    if (existing.kind === "pending" && existing.scope.patientId === patientId
      && existing.scope.medId === state.medId && existing.scope.query === state.request.medicationQuery
      && existing.scope.revision === revision && existing.scope.medicationName === state.medicationName) {
      const pending = this.#inflight.get(context!.conversationId);
      if (pending) return pending;
    }
    if (existing.kind === "submitted") {
      if (existing.scope.patientId !== patientId || existing.scope.medId !== state.medId
        || existing.scope.query !== state.request.medicationQuery) return { state, outcome: { kind: "blocked", reason: "invalid_context" } };
      const next = transition(state, { type: "refill_submitted", pharmacyId: existing.scope.pharmacyId, receipt: existing.receipt });
      return { state: next, outcome: { kind: "submitted", receipt: existing.receipt } };
    }
    if (existing.kind !== "confirmed") {
      const next = transition(state, { type: "clinical_stop", reason: existing.kind === "rejected" ? "refill_rejected" : "refill_unknown", policyReasons: [] });
      return { state: next, outcome: { kind: existing.kind === "rejected" ? "rejected" : "unknown" } };
    }
    const scope = existing.scope;
    if (scope.patientId !== patientId || scope.medId !== state.medId || scope.query !== state.request.medicationQuery
      || scope.medicationName !== state.medicationName || scope.revision !== revision) {
      return { state, outcome: { kind: "blocked", reason: "pharmacy_confirmation_required" } };
    }
    // No write occurs until fresh ownership, policy and pharmacy checks all succeed.
    const medications = await this.#reader.medications(state, context);
    const selection = selectMedication(medications, state.request.medicationQuery);
    if (selection.kind !== "selected" || selection.medication.medId !== state.medId
      || selection.medication.name !== state.medicationName) return { state, outcome: { kind: "blocked", reason: "invalid_context" } };
    const medication = selection.medication;
    const policy = await assessMedication(this.#reader, state, context, medication);
    if (!policy.eligible) {
      const next = transition(state, { type: "clinical_stop", reason: "policy_blocked", policyReasons: [...policy.reasons] });
      return { state: next, outcome: { kind: "blocked", reason: "clinical_recheck_failed" } };
    }
    const pharmacy = await this.#reader.pharmacy(state, context);
    if (!pharmacy || !sameScope(scope, { patientId, medId: state.medId,
      pharmacyId: pharmacy.pharmacyId, query: state.request.medicationQuery, medicationName: state.medicationName, revision })) {
      return { state, outcome: { kind: "blocked", reason: "pharmacy_confirmation_required" } };
    }
    assertSessionPatient(context, state);
    // Recheck the exact confirmed record after awaits. Parallel actions within one lease share one write.
    if (this.#records.get(context!.conversationId) !== existing) {
      const pending = this.#inflight.get(context!.conversationId);
      if (pending) return pending;
      return this.submit(state, context);
    }
    this.#records.set(context!.conversationId, { kind: "pending", scope });
    const pending = this.#write(state, context!, scope, patientId, medication.medId);
    this.#inflight.set(context!.conversationId, pending);
    try { return await pending; }
    finally { if (this.#inflight.get(context!.conversationId) === pending) this.#inflight.delete(context!.conversationId); }
  }

  async #write(state: Extract<ConversationState, { phase: "awaiting_pharmacy_confirmation" }>, context: SessionContext,
    scope: Scope, patientId: string, medId: string): Promise<ActionResult> {
    try {
      const receipt = refillReceiptSchema.safeParse(await this.#ehr.submitRefill(patientId, medId));
      if (!receipt.success) throw new ClinicalEhrError("invalid_response", { uncertain: true });
      const evidence = Object.freeze({ ...receipt.data });
      this.#records.set(context.conversationId, { kind: "submitted", scope, receipt: evidence });
      const next = transition(state, { type: "refill_submitted", pharmacyId: scope.pharmacyId, receipt: evidence });
      return { state: next, outcome: { kind: "submitted", receipt: evidence } };
    } catch (error) {
      const knownRejection = error instanceof ClinicalEhrError && !error.uncertain;
      const kind = knownRejection ? "rejected" : "unknown";
      this.#records.set(context.conversationId, { kind, scope });
      const next = transition(state, { type: "clinical_stop", reason: kind === "rejected" ? "refill_rejected" : "refill_unknown", policyReasons: [] });
      return { state: next, outcome: { kind } };
    }
  }
}
