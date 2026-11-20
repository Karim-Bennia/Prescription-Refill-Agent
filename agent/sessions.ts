import {
  createInitialState, isAuthenticated, validateConversationState, type ConversationState,
} from "./conversation-state.js";
import { conversationIdSchema } from "./validation.js";

export type SessionErrorCode = "invalid_session" | "capacity" | "invalid_state";
export class SessionError extends Error {
  readonly code: SessionErrorCode;
  constructor(code: SessionErrorCode) {
    super(`Session operation failed (${code}).`);
    this.name = "SessionError";
    this.code = code;
  }
}

export interface SessionUpdate<T> { readonly state: ConversationState; readonly result: T }
export interface SessionRepository {
  run<T>(conversationId: string, operation: (state: ConversationState) => Promise<SessionUpdate<T>>): Promise<T>;
}

export interface SessionRepositoryOptions {
  readonly maxSessions?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}
interface Entry { state: ConversationState; lastActivity: number }

function snapshot(state: ConversationState): ConversationState {
  const clone = structuredClone(state);
  if (clone.phase === "collecting_identity" || clone.phase === "verifying_identity") Object.freeze(clone.factors);
  if ("request" in clone && clone.request !== null) Object.freeze(clone.request);
  return Object.freeze(clone);
}

function validateUpdate(previous: ConversationState, value: unknown): ConversationState {
  let next: ConversationState;
  try { next = validateConversationState(value); }
  catch { throw new SessionError("invalid_state"); }
  if (previous.phase === "escalated"
    && (next.phase !== "escalated" || next.reason !== previous.reason)) throw new SessionError("invalid_state");
  if (previous.phase === "closed" && next.phase !== "closed") throw new SessionError("invalid_state");
  if (isAuthenticated(previous) && next.phase !== "escalated" && next.phase !== "closed"
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

  async run<T>(conversationId: string, operation: (state: ConversationState) => Promise<SessionUpdate<T>>): Promise<T> {
    if (!conversationIdSchema.safeParse(conversationId).success) throw new SessionError("invalid_session");
    const pending = this.#pending.get(conversationId) ?? 0;
    if (pending >= 32) throw new SessionError("capacity");
    let entry = this.#entries.get(conversationId);
    if (!entry) {
      if (this.#entries.size >= this.#maxSessions) throw new SessionError("capacity");
      entry = { state: snapshot(createInitialState()), lastActivity: this.#clock() };
      // Reserve the slot before any await, including concurrent new sessions.
      this.#entries.set(conversationId, entry);
    }
    const previousTurn = this.#queues.get(conversationId) ?? Promise.resolve();
    let release!: () => void;
    const queue = new Promise<void>(resolve => { release = resolve; });
    this.#queues.set(conversationId, queue);
    this.#pending.set(conversationId, pending + 1);
    await previousTurn;
    try {
      const now = this.#clock();
      if (entry.state.phase !== "escalated" && entry.state.phase !== "closed" && now - entry.lastActivity >= this.#ttlMs) {
        entry.state = snapshot({ phase: "escalated", reason: "expired" });
      }
      const before = snapshot(entry.state);
      const update = await operation(before);
      const next = validateUpdate(before, update?.state);
      const committedState = snapshot(next);
      const committedAt = this.#clock();
      // Clone before storing so callers cannot mutate retained state after a turn.
      entry.state = committedState;
      entry.lastActivity = committedAt;
      return update.result;
    } finally {
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
