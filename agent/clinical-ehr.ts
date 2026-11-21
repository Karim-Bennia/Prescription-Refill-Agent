import type { z } from "zod";
import {
  medicationListSchema, labListSchema, pharmacySchema, refillReceiptSchema, ehrTimeSchema,
  type Medication, type Lab, type Pharmacy, type RefillReceipt,
} from "./clinical-types.js";
import {
  ClinicalEhrError, ClinicalHttpTransport,
  type ClinicalEhrConfig, type ClinicalEhrDependencies, type ClinicalOperation,
} from "./clinical-http.js";

export { ClinicalEhrError } from "./clinical-http.js";
export type { ClinicalEhrConfig, ClinicalEhrDependencies, ClinicalEhrErrorCode } from "./clinical-http.js";
export type PharmacyRecord = Pharmacy;

/** Service integration only. Callers must enforce verified session identity before protected operations. */
export interface ClinicalEhr {
  medications(patientId: string): Promise<Medication[]>;
  time(): Promise<string>;
  labs(patientId: string, type: string): Promise<Lab[]>;
  pharmacy(patientId: string): Promise<Pharmacy | null>;
  submitRefill(patientId: string, medId: string): Promise<RefillReceipt>;
}

/** Adapter for only the documented Phase 4 EHR operations; no pharmacy mutation interface is exposed. */
export class HttpClinicalEhr implements ClinicalEhr {
  readonly #transport: ClinicalHttpTransport;

  constructor(config: ClinicalEhrConfig, dependencies: ClinicalEhrDependencies = {}) {
    this.#transport = new ClinicalHttpTransport(config, dependencies);
  }

  async #validated<S extends z.ZodType>(operation: ClinicalOperation, schema: S): Promise<z.output<S>> {
    const response = await this.#transport.execute(operation);
    const parsed = schema.safeParse(response);
    if (!parsed.success) throw new ClinicalEhrError("invalid_response", { uncertain: operation.kind === "refill" });
    return parsed.data;
  }

  medications(patientId: string): Promise<Medication[]> {
    return this.#validated({ kind: "medications", patientId }, medicationListSchema);
  }

  async time(): Promise<string> {
    return (await this.#validated({ kind: "time" }, ehrTimeSchema)).now;
  }

  labs(patientId: string, type: string): Promise<Lab[]> {
    return this.#validated({ kind: "labs", patientId, type }, labListSchema);
  }

  pharmacy(patientId: string): Promise<Pharmacy | null> {
    return this.#validated({ kind: "pharmacy", patientId }, pharmacySchema);
  }

  submitRefill(patientId: string, medId: string): Promise<RefillReceipt> {
    return this.#validated({ kind: "refill", patientId, medId }, refillReceiptSchema);
  }
}
