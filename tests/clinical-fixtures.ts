import { createRuntime } from "../agent/runtime.js";
import { InMemorySessionRepository, type SessionContext } from "../agent/sessions.js";
import type { ClinicalEhr } from "../agent/clinical-ehr.js";
import type { Medication, Lab, Pharmacy, RefillReceipt } from "../agent/clinical-types.js";
import type { ConversationState } from "../agent/conversation-state.js";
import type { LanguageInterpreter } from "../agent/intent.js";

export const TEST_NOW = "2031-06-30T12:00:00Z";
export const IDENTITY = "Morgan Vale, DOB 1990-01-02, phone ending 4321.";
export const medication = (changes: Partial<Medication> = {}): Medication => ({
  medId: "owned-med-a", name: "Examplemed 10mg", isControlled: false, schedule: null,
  lastFilledDate: "2031-06-01", daysSupply: 30, refillsRemaining: 3,
  rxExpirationDate: "2032-01-01", requiresRecentLab: null, ...changes,
});
export interface ClinicalCall { operation: string; patientId?: string; medId?: string; type?: string }
export function clinicalFixture(options: {
  medications?: Medication[]; labs?: Lab[]; pharmacy?: Pharmacy | null;
  now?: () => number; ttlMs?: number; interpreter?: LanguageInterpreter;
  hooks?: Partial<ClinicalEhr>;
} = {}) {
  const calls: ClinicalCall[] = [];
  const records = { medications: options.medications ?? [medication()], labs: options.labs ?? [],
    pharmacy: options.pharmacy === undefined ? { pharmacyId: "pharmacy-a", name: "Synthetic Pharmacy" } : options.pharmacy,
    time: TEST_NOW };
  let submissionCount = 0;
  const ehr: ClinicalEhr = {
    medications: async patientId => { calls.push({ operation: "medications", patientId }); return records.medications; },
    time: async () => { calls.push({ operation: "time" }); return records.time; },
    labs: async (patientId, type) => { calls.push({ operation: "labs", patientId, type }); return records.labs; },
    pharmacy: async patientId => { calls.push({ operation: "pharmacy", patientId }); return records.pharmacy; },
    submitRefill: async (patientId, medId): Promise<RefillReceipt> => {
      calls.push({ operation: "submit", patientId, medId });
      return { refillId: `synthetic-receipt-${++submissionCount}`, status: "submitted" };
    },
    ...options.hooks,
  };
  const sessions = new InMemorySessionRepository({ now: options.now, ttlMs: options.ttlMs });
  const runtime = createRuntime({ GROQ_API_KEY: "synthetic-groq-token", EHR_API_KEY: "synthetic-ehr-token",
    PHARMACY_API_KEY: "synthetic-pharmacy-token" }, options.interpreter ?? {
    interpret: async () => { throw new Error("Unexpected model call in deterministic fixture"); },
  }, { sessions, ehr, matcher: { match: async factors => ({ count: 1,
    patientId: factors.lastName === "Reed" ? "synthetic-patient-b" : "synthetic-patient-a" }) } });
  const state = (id = "clinical-a") => sessions.run(id, async current => ({ state: current, result: current }));
  const authenticate = async (query = "Examplemed 10mg", id = "clinical-a") => {
    await runtime.engine.handleTurn(id, `Please refill my ${query}.`);
    return runtime.engine.handleTurn(id, IDENTITY);
  };
  const confirm = (id = "clinical-a", pharmacyId = "pharmacy-a") => sessions.run(id, async (current, context) => ({
    state: current, result: await runtime.actions.confirmCurrentPharmacy(current, context, pharmacyId),
  }));
  const submit = (id = "clinical-a") => sessions.run(id, async (current, context) => {
    const result = await runtime.actions.submit(current, context);
    return { state: result.state, result: result.outcome };
  });
  const within = <T>(operation: (state: ConversationState, context?: SessionContext) => Promise<T>, id = "clinical-a") =>
    sessions.run(id, async (current, context) => ({ state: current, result: await operation(current, context) }));
  return { ...runtime, sessions, ehr, calls, records, state, authenticate, confirm, submit, within };
}
