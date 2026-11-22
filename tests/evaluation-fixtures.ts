import { createApplicationRuntime } from "../agent/runtime.js";
import { InMemorySessionRepository, type SessionRepository } from "../agent/sessions.js";
import type { ClinicalEhr } from "../agent/clinical-ehr.js";
import type { IdentityMatcher } from "../agent/ehr-client.js";
import type { LanguageInterpreter } from "../agent/intent.js";
import type { Medication, Lab, Pharmacy } from "../agent/clinical-types.js";
import type { DirectoryPharmacy, PharmacyService } from "../agent/pharmacy-client.js";
import { replySchema } from "../agent/validation.js";
import { IDENTITY, TEST_NOW, medication } from "./clinical-fixtures.js";

export { IDENTITY, TEST_NOW, medication };
export const EVALUATION_ENV = Object.freeze({ GROQ_API_KEY: "synthetic-evaluation-model",
  EHR_API_KEY: "synthetic-evaluation-ehr", PHARMACY_API_KEY: "synthetic-evaluation-directory" });
export interface EvaluationCall { operation: string; patientId?: string; medId?: string; pharmacyId?: string; query?: string }
export interface EvaluationOptions {
  medications?: Medication[]; labs?: Lab[]; pharmacy?: Pharmacy | null; directory?: DirectoryPharmacy[];
  now?: () => number; ttlMs?: number; maxSessions?: number; sessions?: SessionRepository;
  ehr?: Partial<ClinicalEhr>; pharmacyService?: Partial<PharmacyService>;
  matcher?: IdentityMatcher; interpreter?: LanguageInterpreter;
}

/** Complete production composition with mutable fault hooks and synthetic service evidence. */
export function evaluationFixture(options: EvaluationOptions = {}) {
  const calls: EvaluationCall[] = [];
  const records = { medications: options.medications ?? [medication()], labs: options.labs ?? [], time: TEST_NOW,
    pharmacy: options.pharmacy === undefined ? { pharmacyId: "pharmacy-a", name: "Synthetic Pharmacy" } : options.pharmacy,
    directory: options.directory ?? [
      { pharmacyId: "pharmacy-a", name: "Synthetic Pharmacy", address: "10 Market Street" },
      { pharmacyId: "pharmacy-b", name: "Synthetic Pharmacy", address: "20 Market Street" },
      { pharmacyId: "pharmacy-c", name: "Other Drugstore", address: "30 Lake Road" },
    ] };
  const hooks = { ehr: options.ehr ?? {}, pharmacy: options.pharmacyService ?? {} };
  let receipts = 0;
  const ehr: ClinicalEhr = {
    medications: async patientId => { calls.push({ operation: "medications", patientId }); return hooks.ehr.medications ? hooks.ehr.medications(patientId) : records.medications; },
    time: async () => { calls.push({ operation: "time" }); return hooks.ehr.time ? hooks.ehr.time() : records.time; },
    labs: async (patientId, type) => { calls.push({ operation: "labs", patientId, query: type }); return hooks.ehr.labs ? hooks.ehr.labs(patientId, type) : records.labs; },
    pharmacy: async patientId => { calls.push({ operation: "pharmacy", patientId }); return hooks.ehr.pharmacy ? hooks.ehr.pharmacy(patientId) : records.pharmacy; },
    submitRefill: async (patientId, medId) => {
      calls.push({ operation: "submit", patientId, medId });
      return hooks.ehr.submitRefill ? hooks.ehr.submitRefill(patientId, medId) : { refillId: `evaluation-receipt-${++receipts}`, status: "submitted" };
    },
  };
  const pharmacy: PharmacyService = {
    search: async query => { calls.push({ operation: "search", query }); return hooks.pharmacy.search ? hooks.pharmacy.search(query)
      : records.directory.filter(item => `${item.name} ${item.address}`.toLowerCase().includes(query.toLowerCase())); },
    update: async (patientId, pharmacyId) => {
      calls.push({ operation: "update", patientId, pharmacyId });
      if (hooks.pharmacy.update) return hooks.pharmacy.update(patientId, pharmacyId);
      const destination = records.directory.find(item => item.pharmacyId === pharmacyId);
      if (!destination) throw new Error("Synthetic directory destination missing");
      records.pharmacy = { pharmacyId, name: destination.name };
    },
  };
  const sessions = options.sessions ?? new InMemorySessionRepository({ now: options.now, ttlMs: options.ttlMs, maxSessions: options.maxSessions });
  const runtime = createApplicationRuntime(EVALUATION_ENV, { interpret: async text => {
    calls.push({ operation: "model" });
    if (options.interpreter) return options.interpreter.interpret(text);
    throw new Error("No model call expected in deterministic evaluation");
  } }, { sessions, ehr, pharmacy, matcher: { match: async factors => {
    calls.push({ operation: "match" });
    return options.matcher ? options.matcher.match(factors) : { count: 1, patientId: factors.lastName === "Reed" ? "synthetic-patient-b" : "synthetic-patient-a" };
  } } });
  const turn = async (text: string, id = "evaluation-a") => replySchema.parse(await runtime.engine.handleTurn(id, text));
  const authenticate = async (query = "Examplemed 10mg", id = "evaluation-a") => {
    await turn(`Please refill my ${query}.`, id); return turn(IDENTITY, id);
  };
  const state = (id = "evaluation-a") => sessions.run(id, async current => ({ state: current, result: current }));
  const mutations = () => calls.filter(call => call.operation === "update" || call.operation === "submit");
  return { ...runtime, calls, records, hooks, sessions, ehr, pharmacy, turn, authenticate, state, mutations };
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
