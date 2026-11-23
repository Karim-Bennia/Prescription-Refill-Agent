import { clinicalDate, clinicalDateSchema, labListSchema, medicationSchema } from "./clinical-types.js";
import { z } from "zod";

export const policyReasonSchema = z.enum(["R1_schedule_ii", "R2_no_refills", "R2_expired",
  "R3_early_controlled", "R4_missing_recent_lab", "invalid_clinical_data"]);
export type PolicyReason = z.infer<typeof policyReasonSchema>;
export interface PolicyDecision {
  readonly eligible: boolean;
  readonly reasons: readonly PolicyReason[];
}
const DAY = 86_400_000;

/** Freeze the deterministic eligibility result and its safe clinical reason codes. */
function decision(reasons: readonly PolicyReason[]): PolicyDecision {
  return Object.freeze({ eligible: reasons.length === 0, reasons: Object.freeze([...reasons]) });
}

// Its only clock is the EHR instant supplied by the caller.
/** Evaluate the four deterministic clinical rules against validated prescription, lab and EHR time inputs. */
export function evaluateEligibility(medication: unknown, labs: unknown, now: unknown): PolicyDecision {
  const parsedMedication = medicationSchema.safeParse(medication);
  const parsedLabs = labListSchema.safeParse(labs);
  const parsedNow = clinicalDateSchema.safeParse(now);
  if (!parsedMedication.success || !parsedLabs.success || !parsedNow.success) {
    return decision(["invalid_clinical_data"]);
  }
  const record = parsedMedication.data;
  const nowMs = clinicalDate(parsedNow.data)!;
  const lastFilledMs = clinicalDate(record.lastFilledDate)!;
  const expirationMs = clinicalDate(record.rxExpirationDate)!;
  const supplyEnd = lastFilledMs + record.daysSupply * DAY;
  const lookback = record.requiresRecentLab ? record.requiresRecentLab.withinDays * DAY : 0;
  // Flags and dates are safety inputs. Inconsistency or unrepresentable arithmetic fails closed.
  if (record.isControlled !== (record.schedule !== null) || lastFilledMs > nowMs
    || !Number.isSafeInteger(supplyEnd) || !Number.isSafeInteger(lookback)
    || Math.abs(supplyEnd) > 8_640_000_000_000_000
    || !Number.isSafeInteger(nowMs - lookback)
    || Math.abs(nowMs - lookback) > 8_640_000_000_000_000) return decision(["invalid_clinical_data"]);

  const reasons: PolicyReason[] = [];
  if (record.schedule === "CII") reasons.push("R1_schedule_ii");
  if (record.refillsRemaining === 0) reasons.push("R2_no_refills");
  if (expirationMs < nowMs) reasons.push("R2_expired");
  if (record.schedule !== null && record.schedule !== "CII" && nowMs < supplyEnd - 2 * DAY) {
    reasons.push("R3_early_controlled");
  }
  if (record.requiresRecentLab) {
    const type = record.requiresRecentLab.type.toLowerCase();
    const recent = parsedLabs.data.some(lab => {
      const timestamp = clinicalDate(lab.takenDate)!;
      return lab.type.toLowerCase() === type && timestamp >= nowMs - lookback && timestamp <= nowMs;
    });
    if (!recent) reasons.push("R4_missing_recent_lab");
  }
  return decision(reasons);
}
