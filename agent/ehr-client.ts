import { z } from "zod";
import { hasRequiredIdentity, validateIdentityFactors, type IdentityFactors } from "./identity.js";
import { IdentityHttpTransport, type EhrDependencies, type EhrIdentityConfig } from "./ehr-http.js";
import { EhrError } from "./ehr-errors.js";
export { EhrError } from "./ehr-errors.js";
export type { EhrErrorCode } from "./ehr-errors.js";
export type { EhrDependencies, EhrIdentityConfig } from "./ehr-http.js";

export const matchResultSchema = z.strictObject({
  count: z.number().int().min(0),
  patientId: z.string().min(1).max(200).refine(value => !/[\s\u0000-\u001f\u007f]/.test(value)).nullable(),
}).refine(value => value.count === 1 ? value.patientId !== null : value.patientId === null);
export type MatchResult = z.infer<typeof matchResultSchema>;

export interface IdentityMatcher {
  match(factors: IdentityFactors): Promise<MatchResult>;
}

/** Builds and validates the documented EHR identity contract, independently of HTTP mechanics. */
export class HttpEhrIdentityMatcher implements IdentityMatcher {
  readonly #transport: IdentityHttpTransport;

  constructor(config: EhrIdentityConfig, dependencies: EhrDependencies = {}) {
    this.#transport = new IdentityHttpTransport(config, dependencies);
  }

  async match(input: IdentityFactors): Promise<MatchResult> {
    let factors: IdentityFactors;
    try { factors = validateIdentityFactors(input); }
    catch { throw new EhrError("invalid_request"); }
    if (!hasRequiredIdentity(factors)) throw new EhrError("invalid_request");
    const result = matchResultSchema.safeParse(await this.#transport.postMatch(factors));
    if (!result.success) throw new EhrError("invalid_response");
    return result.data;
  }
}
