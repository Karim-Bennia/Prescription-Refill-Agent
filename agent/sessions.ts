import {
  createInitialState, isAuthenticated, isTerminal, requireAuthenticatedPatient, validateConversationState, type ConversationState,
} from "./conversation-state.js";
import { conversationIdSchema } from "./validation.js";

export type SessionErrorCode = "invalid_session" | "capacity" | "invalid_state" | "expired";
export class SessionError extends Error {
  readonly code: SessionErrorCode;
  constructor(code: SessionErrorCode) {
    super(`Session operation failed (${code}).`);
    this.name = "SessionError";
    this.code = code;
  }
}

export interface SessionUpdate<T> { readonly state: ConversationState; readonly result: T }
export interface SessionContext { readonly conversationId: string }
interface SavedSelection { medId: string; name: string; query: string }
interface ContextRecord { assertActive: () => void; patientId?: string; bindingAllowed: boolean;
  selection?: SavedSelection; selectionVersion: number; pharmacyPrompt?: string }
const activeContexts = new WeakMap<SessionContext, ContextRecord>();

function contextRecord(context: SessionContext | undefined): ContextRecord {
  const record = context && activeContexts.get(context);
  if (!record) throw new SessionError("invalid_state");
  record.assertActive();
  return record;
}

/** Called by authentication orchestration only after a validated unique EHR match. */
export function bindSessionPatient(context: SessionContext, state: ConversationState): void {
  const record = contextRecord(context);
  const patientId = requireAuthenticatedPatient(state);
  if (record.patientId !== undefined && record.patientId !== patientId) throw new SessionError("invalid_state");
  if (record.patientId === undefined && !record.bindingAllowed) throw new SessionError("invalid_state");
  record.patientId = patientId;
  record.bindingAllowed = false;
}

/** Every protected operation checks an active repository-issued lease and its patient binding. */
export function assertSessionPatient(context: SessionContext | undefined, state: ConversationState): string {
  const record = contextRecord(context);
  const patientId = requireAuthenticatedPatient(state);
  if (record.patientId !== patientId) throw new SessionError("invalid_state");
  return patientId;
}

/** Receipt replay uses retained session evidence; it grants no protected operation. */
export function assertSessionEvidence(context: SessionContext | undefined, patientId: string): void {
  const record = context && activeContexts.get(context);
  if (!record || record.patientId !== patientId) throw new SessionError("invalid_state");
}

export function sessionSelectionVersion(context: SessionContext | undefined, state: ConversationState): number | undefined {
  const record = contextRecord(context);
  assertSessionPatient(context, state);
  if (state.phase !== "awaiting_pharmacy_confirmation" || !record.selection
    || record.selection.medId !== state.medId || record.selection.name !== state.medicationName
    || record.selection.query !== state.request.medicationQuery
    || record.pharmacyPrompt !== (state.pharmacyContext ? JSON.stringify(state.pharmacyContext) : undefined)) return undefined;
  return record.selectionVersion;
}

/** A pharmacy mutation/confirmation must answer the question actually saved before this turn. */
export function assertSavedPharmacyPrompt(context: SessionContext | undefined, state: ConversationState): void {
  const record = contextRecord(context);
  if (sessionSelectionVersion(context, state) === undefined || state.phase !== "awaiting_pharmacy_confirmation"
    || !state.pharmacyContext || record.pharmacyPrompt !== JSON.stringify(state.pharmacyContext)) {
    throw new SessionError("invalid_state");
  }
}
export interface SessionRepository {
  run<T>(conversationId: string, operation: (state: ConversationState, context?: SessionContext) => Promise<SessionUpdate<T>>): Promise<T>;
}

export interface SessionRepositoryOptions {
  readonly maxSessions?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}
interface Entry { state: ConversationState; lastActivity: number; selectionVersion: number }

function selectionKey(state: ConversationState): string {
  return isAuthenticated(state) ? JSON.stringify({ patientId: state.patientId,
    request: state.request, selected: state.phase === "awaiting_pharmacy_confirmation"
      ? [state.medId, state.medicationName, state.pharmacyContext ?? null] : null }) : state.phase;
}

function snapshot(state: ConversationState): ConversationState {
  const clone = structuredClone(state);
  const freeze = (value: object): void => {
    for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child);
    Object.freeze(value);
  };
  freeze(clone);
  return clone;
}

function validateUpdate(previous: ConversationState, value: unknown): ConversationState {
  let next: ConversationState;
  try { next = validateConversationState(value); }
  catch { throw new SessionError("invalid_state"); }
  if (isTerminal(previous) && JSON.stringify(next) !== JSON.stringify(previous)) throw new SessionError("invalid_state");
  if (isAuthenticated(previous) && "patientId" in next && next.patientId !== previous.patientId) throw new SessionError("invalid_state");
  if (isAuthenticated(previous) && !isTerminal(next)
    && (!isAuthenticated(next) || next.patientId !== previous.patientId)) throw new SessionError("invalid_state");
  return next;
}

/** Process-local state, serialized by routing key; IDs provide no caller authentication. */
export class InMemorySessionRepository implements SessionRepository {
  readonly #entries = new Map<string, Entry>();
  readonly #queues = new Map<string, Promise<void>>();
  readonly #pending = new Map<string, number>();
  readonly #maxSessions: number;
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: SessionRepositoryOptions = {}) {
    this.#maxSessions = options.maxSessions ?? 1000;
    this.#ttlMs = options.ttlMs ?? 30 * 60 * 1000;
    this.#now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.#maxSessions) || this.#maxSessions < 1
      || !Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1) throw new SessionError("invalid_state");
  }

  async run<T>(conversationId: string, operation: (state: ConversationState, context?: SessionContext) => Promise<SessionUpdate<T>>): Promise<T> {
    if (!conversationIdSchema.safeParse(conversationId).success) throw new SessionError("invalid_session");
    const pending = this.#pending.get(conversationId) ?? 0;
    if (pending >= 32) throw new SessionError("capacity");
    let entry = this.#entries.get(conversationId);
    if (!entry) {
      if (this.#entries.size >= this.#maxSessions) throw new SessionError("capacity");
      entry = { state: snapshot(createInitialState()), lastActivity: this.#clock(), selectionVersion: 0 };
      // Reserve the slot before any await, including concurrent new sessions.
      this.#entries.set(conversationId, entry);
    }
    const previousTurn = this.#queues.get(conversationId) ?? Promise.resolve();
    let release!: () => void;
    const queue = new Promise<void>(resolve => { release = resolve; });
    this.#queues.set(conversationId, queue);
    this.#pending.set(conversationId, pending + 1);
    await previousTurn;
    let context: SessionContext | undefined;
    try {
      const now = this.#clock();
      if (!isTerminal(entry.state) && now - entry.lastActivity >= this.#ttlMs) {
        entry.state = snapshot({ phase: "escalated", reason: "expired" });
      }
      const before = snapshot(entry.state);
      context = Object.freeze({ conversationId });
      activeContexts.set(context, {
        patientId: "patientId" in before ? before.patientId : undefined,
        bindingAllowed: before.phase === "collecting_identity" || before.phase === "verifying_identity",
        selection: before.phase === "awaiting_pharmacy_confirmation"
          ? { medId: before.medId, name: before.medicationName, query: before.request.medicationQuery } : undefined,
        selectionVersion: entry.selectionVersion,
        pharmacyPrompt: before.phase === "awaiting_pharmacy_confirmation" && before.pharmacyContext
          ? JSON.stringify(before.pharmacyContext) : undefined,
        assertActive: () => { if (this.#clock() - entry.lastActivity >= this.#ttlMs || isTerminal(entry.state)) throw new SessionError("expired"); },
      });
      const update = await operation(before, context);
      const next = validateUpdate(before, update?.state);
      const committedState = snapshot(next);
      const committedAt = this.#clock();
      // A caught dependency error must not renew a lease that expired during this turn.
      // Terminal action evidence can still be retained after an already accepted write.
      if (!isTerminal(next) && committedAt - entry.lastActivity >= this.#ttlMs) {
        entry.state = snapshot({ phase: "escalated", reason: "expired" });
        throw new SessionError("expired");
      }
      if (selectionKey(before) !== selectionKey(next)) entry.selectionVersion++;
      // Clone before storing so callers cannot mutate retained state after a turn.
      entry.state = committedState;
      entry.lastActivity = committedAt;
      return update.result;
    } finally {
      if (context) activeContexts.delete(context);
      release();
      if (this.#queues.get(conversationId) === queue) this.#queues.delete(conversationId);
      const remaining = (this.#pending.get(conversationId) ?? 1) - 1;
      if (remaining === 0) this.#pending.delete(conversationId);
      else this.#pending.set(conversationId, remaining);
    }
  }

  #clock(): number {
    const value = this.#now();
    if (!Number.isFinite(value)) throw new SessionError("invalid_state");
    return value;
  }
}
