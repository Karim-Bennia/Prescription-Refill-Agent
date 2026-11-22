import { isAuthenticated, transition, type ConversationState } from "./conversation-state.js";
import { ClinicalEhrError } from "./clinical-ehr.js";
import type { SessionContext } from "./sessions.js";
import { assertSessionPatient } from "./sessions.js";
import { PatientClinicalReader, assessMedication } from "./patient-clinical.js";
import { selectMedication } from "./selection.js";
import type { PolicyReason } from "./policy.js";

export interface ClinicalProgress {
  readonly state: ConversationState;
  readonly message: string;
  readonly cache: boolean;
}

const REASONS: Record<PolicyReason, string> = {
  R1_schedule_ii: "Schedule II prescriptions cannot be refilled here. Please contact your prescriber.",
  R2_no_refills: "No refills remain. Please contact your prescriber for a new prescription.",
  R2_expired: "This prescription has expired. Please contact your prescriber for a new prescription.",
  R3_early_controlled: "This controlled medication is too early for refill under the documented timing rule. Please contact your prescriber.",
  R4_missing_recent_lab: "A required recent lab result is missing or outside the required window. Please contact your care team about the required lab.",
  invalid_clinical_data: "Required clinical information is missing or inconsistent, so I cannot safely evaluate this prescription. Please contact your care team.",
};

export function clinicalReply(state: ConversationState): string {
  switch (state.phase) {
    case "medication_clarification": {
      const names = state.candidates.slice(0, 8).map(candidate => candidate.name).join("; ");
      return `Please specify the medication name and strength from your prescription record${names ? `: ${names}` : "."} No refill has been submitted.`;
    }
    case "awaiting_pharmacy_confirmation":
      return `${state.medicationName} passed the documented clinical checks. Pharmacy identity and confirmation are still required before submission. No refill has been submitted.`;
    case "clinical_escalated":
      if (state.reason === "pharmacy_unknown") return "The pharmacy change outcome could not be verified. Do not repeat the change; please contact your care team to verify the destination. No refill has been submitted.";
      if (state.reason === "pharmacy_rejected") return "The service did not confirm the pharmacy change. Please contact your care team. No refill has been submitted.";
      if (state.reason === "refill_unknown") return "The refill submission outcome is unknown. Do not submit it again; please contact your care team to verify it. No successful submission is being claimed.";
      if (state.reason === "refill_rejected") return "The service did not confirm submission of this refill. Please contact your care team. No successful submission is being claimed.";
      if (state.reason === "no_prescriptions") return "No prescriptions were returned for your verified record. Please contact your care team. No refill has been submitted and no one has been contacted on your behalf.";
      return `${(state.policyReasons.length ? state.policyReasons : ["invalid_clinical_data" as const]).map(reason => REASONS[reason]).join(" ")} No refill has been submitted. No one has been contacted on your behalf.`;
    case "refill_submitted": return "Your refill request was submitted to the EHR service. This confirms submission, not dispensing or a new prescription.";
    default: return "Prescription review is still in progress. No refill has been submitted.";
  }
}

/** Clinical effects run inside the existing serialized turn; no pharmacy confirmation/write UI. */
export class PrescriptionWorkflow {
  constructor(readonly reader: PatientClinicalReader) {}

  async advance(state: ConversationState, context: SessionContext | undefined): Promise<ClinicalProgress> {
    assertSessionPatient(context, state);
    if (!isAuthenticated(state)) throw new Error("Patient authentication is required.");
    try {
      const medications = await this.reader.medications(state, context);
      if (medications.length === 0) {
        const stopped = transition(state, { type: "clinical_stop", reason: "no_prescriptions", policyReasons: [] });
        return { state: stopped, message: clinicalReply(stopped), cache: true };
      }
      const query = state.request?.medicationQuery ?? null;
      // Match the complete literal request. A model substring must never erase dose/formulation constraints.
      const selection = selectMedication(medications, query);
      if (selection.kind !== "selected") {
        const candidates = selection.kind === "clarify" ? selection.candidates : medications;
        const next = transition(state, { type: "medication_clarification", request: query ? { medicationQuery: query } : null,
          candidates: candidates.slice(0, 25).map(({ medId, name }) => ({ medId, name })) });
        const prefix = selection.kind === "not_found" ? "I could not identify that request in your prescription records. " : "";
        return { state: next, message: prefix + clinicalReply(next), cache: true };
      }
      const decision = await assessMedication(this.reader, state, context, selection.medication);
      assertSessionPatient(context, state);
      const next = decision.eligible
        ? transition(state, { type: "prescription_eligible", medId: selection.medication.medId,
          medicationName: selection.medication.name, request: { medicationQuery: query! } })
        : transition(state, { type: "clinical_stop", reason: "policy_blocked", policyReasons: [...decision.reasons] });
      return { state: next, message: clinicalReply(next), cache: true };
    } catch (error) {
      if (error instanceof ClinicalEhrError && error.code === "invalid_response") {
        const next = transition(state, { type: "clinical_stop", reason: "invalid_data", policyReasons: ["invalid_clinical_data"] });
        return { state: next, message: clinicalReply(next), cache: true };
      }
      return { state, message: "Prescription information is temporarily unavailable. Please retry. No refill has been submitted.", cache: false };
    }
  }
}
