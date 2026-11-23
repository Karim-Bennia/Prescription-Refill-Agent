import { z } from "zod";

/** Build a bounded model-text field that represents absent information explicitly as null. */
const nullableText = (max: number) => z.string().trim().min(1).max(max).nullable();

// These are language proposals, never authenticated identities or action permissions.
export const interpretationSchema = z.strictObject({
  intent: z.enum([
    "refill_request", "identity_information", "keep_pharmacy", "change_pharmacy",
    "affirm", "deny", "cancel", "other",
  ]),
  identity: z.strictObject({
    firstName: nullableText(100),
    lastName: nullableText(100),
    dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    phoneLast4: z.string().regex(/^\d{4}$/).nullable(),
    zip: z.string().regex(/^\d{5}(?:-\d{4})?$/).nullable(),
  }),
  medicationQuery: nullableText(200),
  pharmacyQuery: nullableText(300),
  clarification: z.enum(["none", "identity", "medication", "pharmacy", "request"]),
});

export type Interpretation = z.infer<typeof interpretationSchema>;

export interface LanguageInterpreter {
  interpret(text: string): Promise<Interpretation>;
}

// The API schema and runtime validator share one definition. Every property is required;
// null represents an absent factor. Both object levels reject additional properties.
export const interpretationJsonSchema = z.toJSONSchema(interpretationSchema, {
  target: "draft-7",
});
