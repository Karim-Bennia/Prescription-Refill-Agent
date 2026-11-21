import { z } from "zod";

function calendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

/** Clinical instants use explicit UTC dates or ISO timestamps with an explicit offset. */
export function clinicalDate(value: string): number | undefined {
  if (typeof value !== "string") return undefined;
  if (calendarDate(value)) return Date.parse(`${value}T00:00:00.000Z`);
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !calendarDate(match[1]) || Number(match[2]) > 23
    || Number(match[3]) > 59 || Number(match[4]) > 59) return undefined;
  const zone = match[6];
  if (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

const identifierSchema = z.string().min(1).max(200)
  .refine(value => !/[\s\u0000-\u001f\u007f]/.test(value));
const textSchema = z.string().trim().min(1).max(300);
export const clinicalDateSchema = z.string().refine(value => clinicalDate(value) !== undefined);

export const medicationSchema = z.strictObject({
  medId: identifierSchema,
  name: textSchema,
  isControlled: z.boolean(),
  schedule: z.enum(["CII", "CIII", "CIV", "CV"]).nullable(),
  lastFilledDate: clinicalDateSchema,
  daysSupply: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  refillsRemaining: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  rxExpirationDate: clinicalDateSchema,
  requiresRecentLab: z.strictObject({
    type: z.string().trim().min(1).max(100),
    withinDays: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }).nullable(),
});
export type Medication = z.infer<typeof medicationSchema>;

export const medicationListSchema = z.array(medicationSchema).max(1000)
  .refine(records => new Set(records.map(record => record.medId)).size === records.length);

export const labSchema = z.strictObject({
  type: z.string().trim().min(1).max(100),
  value: z.string().trim().min(1).max(1000),
  takenDate: clinicalDateSchema,
});
export type Lab = z.infer<typeof labSchema>;
export const labListSchema = z.array(labSchema).max(1000);

export const pharmacyRecordSchema = z.strictObject({ pharmacyId: identifierSchema, name: textSchema });
export type Pharmacy = z.infer<typeof pharmacyRecordSchema>;
export const pharmacySchema = pharmacyRecordSchema.nullable();
export const refillReceiptSchema = z.strictObject({ refillId: identifierSchema, status: z.literal("submitted") });
export type RefillReceipt = z.infer<typeof refillReceiptSchema>;
export const ehrTimeSchema = z.strictObject({ now: clinicalDateSchema });
