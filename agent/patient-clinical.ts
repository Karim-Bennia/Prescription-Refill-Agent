import {
  ehrTimeSchema, labListSchema, medicationListSchema, pharmacySchema,
  type Lab, type Medication, type Pharmacy,
} from "./clinical-types.js";
import type { ClinicalEhr } from "./clinical-ehr.js";
import { ClinicalEhrError } from "./clinical-ehr.js";
import type { ConversationState } from "./conversation-state.js";
import { assertSessionPatient, type SessionContext } from "./sessions.js";
import { evaluateEligibility, type PolicyDecision } from "./policy.js";

/** Protected reads accept a repository lease and state, never a caller-provided patient ID. */
export class PatientClinicalReader {
  readonly #ehr: ClinicalEhr;
  constructor(ehr: ClinicalEhr) { this.#ehr = ehr; }

  async medications(state: ConversationState, context: SessionContext | undefined): Promise<Medication[]> {
    const id = assertSessionPatient(context, state);
    const result = medicationListSchema.safeParse(await this.#ehr.medications(id));
    if (!result.success) throw new ClinicalEhrError("invalid_response");
    return result.data;
  }

  async time(state: ConversationState, context: SessionContext | undefined): Promise<string> {
    assertSessionPatient(context, state);
    const result = ehrTimeSchema.safeParse({ now: await this.#ehr.time() });
    if (!result.success) throw new ClinicalEhrError("invalid_response");
    return result.data.now;
  }

  async labs(state: ConversationState, context: SessionContext | undefined, type: string): Promise<Lab[]> {
    const id = assertSessionPatient(context, state);
    const result = labListSchema.safeParse(await this.#ehr.labs(id, type));
    if (!result.success) throw new ClinicalEhrError("invalid_response");
    return result.data;
  }

  async pharmacy(state: ConversationState, context: SessionContext | undefined): Promise<Pharmacy | null> {
    const id = assertSessionPatient(context, state);
    const result = pharmacySchema.safeParse(await this.#ehr.pharmacy(id));
    if (!result.success) throw new ClinicalEhrError("invalid_response");
    return result.data;
  }
}

/** Shared by intake and action-time revalidation; clinical rules exist only in policy.ts. */
export async function assessMedication(
  reader: PatientClinicalReader, state: ConversationState,
  context: SessionContext | undefined, medication: Medication,
): Promise<PolicyDecision> {
  const now = await reader.time(state, context);
  const labs = medication.requiresRecentLab
    ? await reader.labs(state, context, medication.requiresRecentLab.type) : [];
  return evaluateEligibility(medication, labs, now);
}
