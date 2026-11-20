import { z } from "zod";
import type { Interpretation } from "./intent.js";

const nameSchema = z.string().trim().min(1).max(100)
  .regex(/^[\p{L}\p{M}][\p{L}\p{M} .’'-]*$/u);
const dobSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});

export const identityFactorsSchema = z.strictObject({
  firstName: nameSchema.optional(),
  lastName: nameSchema.optional(),
  dob: dobSchema.optional(),
  phoneLast4: z.string().regex(/^\d{4}$/).optional(),
  zip: z.string().regex(/^\d{5}(?:-\d{4})?$/).optional(),
});
export type IdentityFactors = z.infer<typeof identityFactorsSchema>;

export class IdentityValidationError extends Error {
  constructor() {
    super("Identity information is invalid.");
    this.name = "IdentityValidationError";
  }
}

export function validateIdentityFactors(value: unknown): IdentityFactors {
  const parsed = identityFactorsSchema.safeParse(value);
  if (!parsed.success) throw new IdentityValidationError();
  return parsed.data;
}

/** Assessment identity-strength design; the API itself leaves factor sufficiency open. */
export function hasRequiredIdentity(factors: IdentityFactors): boolean {
  const valid = identityFactorsSchema.safeParse(factors);
  return valid.success && Boolean(valid.data.firstName && valid.data.lastName && valid.data.dob
    && (valid.data.phoneLast4 || valid.data.zip));
}

export function missingIdentityFields(factors: IdentityFactors): readonly string[] {
  const missing: string[] = [];
  if (!factors.firstName) missing.push("firstName");
  if (!factors.lastName) missing.push("lastName");
  if (!factors.dob) missing.push("dob");
  if (!factors.phoneLast4 && !factors.zip) missing.push("phoneLast4 or zip");
  return missing;
}

const factorKeys = ["firstName", "lastName", "dob", "phoneLast4", "zip"] as const;
const normalize = (text: string): string => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const numericPatterns = {
  dob: /\b(?:dob|date\s+of\s+birth|born(?:\s+on)?|birthday)\s*(?::|=|is\b)?\s*(\d{4}-\d{2}-\d{2})\b/i,
  phoneLast4: /\b(?:(?:phone|telephone)(?:\s+number)?\s*(?:ending(?:\s+in)?|ends?(?:\s+in)?|last\s*(?:four|4)(?:\s+digits)?|:|=)|last\s*(?:four|4)(?:\s+digits)?(?:\s+of\s+(?:my\s+)?phone)?)\s*(\d{4})\b/i,
  zip: /\b(?:zip(?:\s+code)?|postal\s+code)\s*(?::|=|is\b)?\s*(\d{5}(?:-\d{4})?)\b/i,
};

/** Model fields are proposals. Only literal evidence from this patient turn is retained. */
export function groundIdentityFactors(proposal: Interpretation["identity"], text: string): IdentityFactors {
  const grounded: IdentityFactors = {};
  const evidence = normalize(text);
  for (const key of factorKeys) {
    const value = proposal[key];
    if (typeof value !== "string") continue;
    const parsed = identityFactorsSchema.shape[key].safeParse(value);
    if (!parsed.success || parsed.data === undefined) continue;
    if (key === "dob" || key === "phoneLast4" || key === "zip") {
      // A DOB year or a number inside an unrelated record ID is not contact evidence.
      const labeled = [...text.matchAll(new RegExp(numericPatterns[key].source, "gi"))]
        .some(match => match[1] === parsed.data);
      if (text.trim() !== parsed.data && !labeled) continue;
    }
    const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegex(normalize(parsed.data))}(?=$|[^\\p{L}\\p{N}])`, "u");
    if (pattern.test(evidence)) grounded[key] = parsed.data;
  }
  return grounded;
}

/** Returns new factors only. The caller owns corrections and session-state merging. */
export function extractIdentityFactors(text: string, existing: IdentityFactors = {}): IdentityFactors {
  const proposed: Interpretation["identity"] = {
    firstName: null, lastName: null, dob: null, phoneLast4: null, zip: null,
  };
  const nameChars = "[\\p{L}\\p{M} .’'-]+?";
  const fieldEnd = "(?=\\s*(?:[,;\\n]|last\\s+name\\b|first\\s+name\\b|date\\s+of\\s+birth\\b|dob\\b|phone\\b|zip\\b|$))";
  for (const [key, label] of [["firstName", "first\\s+name"], ["lastName", "last\\s+name"]] as const) {
    const match = new RegExp(`\\b${label}\\s*(?::|=|is\\b)?\\s*(${nameChars})${fieldEnd}`, "iu").exec(text);
    if (match) proposed[key] = match[1].trim();
  }
  const initialName = /^(?:my\s+name\s+is\s+|i(?:\s+am|'m)\s+)?([\p{L}\p{M}][\p{L}\p{M} .’'-]+?)\s*,\s*(?:dob|date\s+of\s+birth)\b/iu.exec(text.trim());
  const prefixedName = /\b(?:my\s+name\s+is|i\s+am|i'm)\s+([\p{L}\p{M}][\p{L}\p{M} .’'-]+?)(?=\s*(?:[,;\n]|\bdob\b|\bdate\s+of\s+birth\b|\bphone\b|\bzip\b|$))/iu.exec(text);
  const fullName = (initialName ?? prefixedName)?.[1]?.trim();
  if (fullName && !proposed.firstName && !proposed.lastName) {
    const parts = fullName.split(/\s+/);
    if (parts.length >= 2) {
      proposed.firstName = parts[0];
      proposed.lastName = parts.slice(1).join(" ");
    }
  }
  proposed.dob = numericPatterns.dob.exec(text)?.[1] ?? null;
  proposed.phoneLast4 = numericPatterns.phoneLast4.exec(text)?.[1] ?? null;
  proposed.zip = numericPatterns.zip.exec(text)?.[1] ?? null;
  const standalone = text.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(standalone)) proposed.dob = standalone;
  else if (/^\d{4}$/.test(standalone)) proposed.phoneLast4 = standalone;
  else if (/^\d{5}(?:-\d{4})?$/.test(standalone)) proposed.zip = standalone;
  else if (nameSchema.safeParse(standalone).success) {
    if (!existing.firstName && existing.lastName) proposed.firstName = standalone;
    else if (!existing.lastName && existing.firstName) proposed.lastName = standalone;
  }
  return groundIdentityFactors(proposed, text);
}
