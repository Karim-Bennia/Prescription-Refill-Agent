import { z } from "zod";

/** Directory data is evidence of a destination, never patient authorization. */
export interface PharmacyChoice {
  readonly pharmacyId: string;
  readonly name: string;
  readonly address: string;
}

export type PharmacyCommand =
  | { readonly kind: "affirm" }
  | { readonly kind: "deny" }
  | { readonly kind: "change"; readonly query: string }
  | { readonly kind: "other" };

export type PharmacySelection =
  | { readonly kind: "selected"; readonly pharmacy: PharmacyChoice }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "not_found" };

const textSchema = z.string().trim().min(1).max(4000)
  .refine(text => !/[\u0000-\u001F\u007F]/u.test(text));
const choiceSchema = z.strictObject({
  pharmacyId: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(300),
  address: z.string().trim().min(1).max(500),
});
const choicesSchema = z.array(choiceSchema).max(1000)
  .refine(records => new Set(records.map(record => record.pharmacyId)).size === records.length);

const normalize = (text: string): string => text.normalize("NFKC").toLocaleLowerCase("en-US")
  .replace(/[’]/gu, "'").replace(/\s+/gu, " ").trim();
const statement = (text: string): string => normalize(text).replace(/[.!?]+$/u, "").trim();

/** An affirmative is useful only when the caller has a trusted, specific pending question. */
export function parsePharmacyCommand(text: string): PharmacyCommand {
  const parsed = textSchema.safeParse(text);
  if (!parsed.success) return { kind: "other" };
  const value = statement(parsed.data);
  if (/^(?:yes(?:,? please)?|yes[, ]+(?:keep|use) my (?:current )?pharmacy|(?:keep|use) my (?:current )?pharmacy|i confirm|confirm)$/u.test(value)) {
    return { kind: "affirm" };
  }
  if (/^(?:no(?:,? (?:thanks|thank you))?|not (?:that|this) (?:one|pharmacy))$/u.test(value)) return { kind: "deny" };

  if (/^(?:please )?(?:show|list)(?: me)?(?: the)?(?: available)? pharmacies$/u.test(value)
    || /^(?:i (?:want|need|would like) )?(?:a )?(?:different|another|new) pharmacy$/u.test(value)
    || /^(?:(?:can|could) you |please )?change (?:it|my pharmacy)(?: to (?:a )?(?:different|another|new) (?:location|pharmacy))?$/u.test(value)) {
    return { kind: "change", query: "" };
  }

  // Only remove known request framing. Everything else remains a literal directory query.
  const match = /^(?:i (?:want|need|would like) )?(?:the |a )?pharmacy (?:on|at|in) (.+)$/u.exec(value)
    ?? /^(?:(?:can|could) you |please )?change (?:it|my pharmacy) to (.+)$/u.exec(value)
    ?? /^(?:please )?(?:search|look)(?: for| up) (?:a pharmacy (?:on|at|in) |pharmacies (?:on|at|in) )?(.+)$/u.exec(value);
  const query = match?.[1]?.trim();
  return query && query.length <= 200 ? { kind: "change", query } : { kind: "other" };
}

export class PharmacySelectionError extends Error {
  constructor() { super("Pharmacy selection input is invalid."); this.name = "PharmacySelectionError"; }
}

const ordinals: Readonly<Record<string, number>> = Object.freeze({
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6,
  seventh: 7, eighth: 8, ninth: 9, tenth: 10,
});
const tokens = (text: string): string[] => normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [];

/** Resolve only actual, currently presented directory records; identifiers in chat are ignored. */
export function selectPharmacy(candidates: readonly PharmacyChoice[], text: string): PharmacySelection {
  const parsed = choicesSchema.safeParse(candidates);
  const parsedText = textSchema.safeParse(text);
  if (!parsed.success || !parsedText.success) throw new PharmacySelectionError();
  const records = parsed.data;
  const value = statement(parsedText.data);
  if (!records.length || parsePharmacyCommand(value).kind === "affirm") return { kind: "not_found" };

  const ordinal = /^(?:(?:please )?(?:use|choose|select) )?(?:the |number |option )?(\d+|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)(?: one| pharmacy| option)?$/u.exec(value);
  if (ordinal) {
    const index = ordinals[ordinal[1]] ?? Number(ordinal[1]);
    return Number.isSafeInteger(index) && index >= 1 && index <= records.length
      ? { kind: "selected", pharmacy: records[index - 1] } : { kind: "not_found" };
  }

  const query = value.replace(/^(?:please )?(?:use|choose|select) (?:the )?/u, "")
    .replace(/^(?:the )?pharmacy (?:on|at|in) /u, "");
  const queryTokens = tokens(query);
  if (!queryTokens.length || queryTokens.every(token => token.length < 3 || /^(?:pharmacy|the|one)$/u.test(token))) {
    return { kind: "not_found" };
  }
  const matches = records.filter(record => {
    const recordTokens = tokens(`${record.name} ${record.address}`);
    return queryTokens.every(token => recordTokens.some(candidate => candidate === token
      || /^\p{L}{3,}$/u.test(token) && candidate.startsWith(token)));
  });
  if (matches.length === 1) return { kind: "selected", pharmacy: matches[0] };
  return { kind: matches.length > 1 ? "ambiguous" : "not_found" };
}
