import { z } from "zod";
import { pharmacyRecordSchema } from "./clinical-types.js";
import { directoryPharmacySchema } from "./pharmacy-client.js";

/** These are pending questions, never authorization flags. */
export const pharmacyContextSchema = z.discriminatedUnion("stage", [
  z.strictObject({ stage: z.literal("confirm_current"), pharmacy: pharmacyRecordSchema }),
  z.strictObject({ stage: z.literal("search"), candidates: z.array(directoryPharmacySchema).max(1000) }),
  z.strictObject({ stage: z.literal("confirm_change"), pharmacy: directoryPharmacySchema }),
]);
export type PharmacyContext = z.infer<typeof pharmacyContextSchema>;
