import { z } from "zod";
import { pharmacyRecordSchema } from "./clinical-types.js";
import { ClinicalEhrError, ClinicalHttpTransport, type ClinicalEhrDependencies } from "./clinical-http.js";

export const directoryPharmacySchema = pharmacyRecordSchema.extend({
  address: z.string().trim().min(1).max(500),
});
export type DirectoryPharmacy = z.infer<typeof directoryPharmacySchema>;
export const directoryListSchema = z.array(directoryPharmacySchema).max(1000)
  .refine(records => new Set(records.map(record => record.pharmacyId)).size === records.length);
const updateResponseSchema = z.strictObject({ ok: z.literal(true) });

export interface PharmacyService {
  search(query: string): Promise<DirectoryPharmacy[]>;
  update(patientId: string, pharmacyId: string): Promise<void>;
}

export interface PharmacyServiceConfig {
  readonly ehrBaseUrl: string;
  readonly ehrApiKey: string;
  readonly pharmacyBaseUrl: string;
  readonly pharmacyApiKey: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
}

/** Integration only. The action boundary must establish patient ownership and consent. */
export class HttpPharmacyService implements PharmacyService {
  readonly #directory: ClinicalHttpTransport;
  readonly #ehr: ClinicalHttpTransport;

  constructor(config: PharmacyServiceConfig, dependencies: ClinicalEhrDependencies = {}) {
    const limits = { timeoutMs: config.timeoutMs, maxRetries: config.maxRetries };
    this.#directory = new ClinicalHttpTransport({
      ...limits, baseUrl: config.pharmacyBaseUrl, apiKey: config.pharmacyApiKey,
    }, dependencies);
    this.#ehr = new ClinicalHttpTransport({
      ...limits, baseUrl: config.ehrBaseUrl, apiKey: config.ehrApiKey,
    }, dependencies);
  }

  async search(query: string): Promise<DirectoryPharmacy[]> {
    const response = await this.#directory.execute({ kind: "directory", query });
    const parsed = directoryListSchema.safeParse(response);
    if (!parsed.success) throw new ClinicalEhrError("invalid_response");
    return parsed.data;
  }

  async update(patientId: string, pharmacyId: string): Promise<void> {
    const response = await this.#ehr.execute({ kind: "pharmacy_update", patientId, pharmacyId });
    if (!updateResponseSchema.safeParse(response).success) {
      throw new ClinicalEhrError("invalid_response", { uncertain: true });
    }
  }
}
