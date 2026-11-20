# Phase 3: conversation engine and patient authentication

Scope: authenticated conversation intake only. Clinical policy, medication ownership/selection, protected patient reads, pharmacy operations and refill writes are not implemented. No Git push, history rewrite or local credential edit was performed.

## Contract and implementation decisions

The existing API is unchanged: `POST /conversations/{conversationId}/messages` takes `{from:"patient",text:string}` and returns agent messages plus `in_progress`, `complete` or `escalated`. `GET /healthz` checks listener readiness without model or EHR calls. Conversation IDs are routing keys, not authenticated caller identities. The API supplies no login/token/session-creation mechanism.

Authentication uses only the documented `POST /ehr/patients:match` request `{factors:{firstName?,lastName?,dob?,phoneLast4?,zip?}}`. The API explicitly leaves factor sufficiency to the application. The established design requires first name, last name, real-calendar ISO DOB and either four phone digits or ZIP. Five unsuccessful complete match submissions end the conversation; dependency failures do not consume this limit. These are design choices, not additional grader requirements.

Missing factors are collected across turns. Directly labeled/standard demographics are parsed deterministically; other language can use the unchanged Phase 2 interpreter. Every model proposal is schema-validated and every extracted factor must occur literally in the current text. Numeric factors also require the appropriate field label or a standalone factor response: a DOB year or number inside a record ID cannot supply the extra phone/ZIP factor. Names, IDs or approval flags invented by the model cannot bind identity. Only a runtime-validated EHR result with `count === 1` and a nonempty `patientId` can do so. Zero and multiple matches receive the same neutral response. Collected demographics are discarded after success or a rejected match. Service failures retain input for safe retry without claiming verification.

## State machine and session lifecycle

| Internal state | Meaning / next transitions | Public status |
| --- | --- | --- |
| `collecting_identity` | Gather factors and retain the original medication query; complete factors permit `verifying_identity`. | `in_progress` |
| `verifying_identity` | Effect is performed outside pure transition logic. Unique match leads to `collecting_request` or `ready`; rejected match returns to collection or stops at the failure limit; dependency failure returns to collection. | `in_progress` |
| `collecting_request` | Patient is bound; ask for a medication query without selecting a prescription. | `in_progress` |
| `ready` | Bound identity and request retained for a later processing phase; no clinical eligibility or action permission implied. | `in_progress` |
| `closed` | Explicit cancellation resolved the request without a refill; cannot reopen. | `complete` |
| `escalated` | Attempt exhaustion, attempted identity change or session expiry; cannot reopen or perform operations. No handoff is claimed. | `escalated` |

Typed events and runtime state validation reject invalid transitions. Verified IDs cannot be reassigned or reset by subsequent turns or repository updates. A new identity claim after authentication stops that conversation; a different person must use a new conversation. `requireAuthenticatedPatient` rejects unauthenticated/terminal states and provides a boundary for later protected operations. This phase exposes no protected EHR operation at all.

The repository is an in-memory Map with per-conversation serialization, immutable/cloned state snapshots, a default 1000-session bound, 30-minute inactivity expiry and a 32-turn per-session pending/in-flight bound. Overflow fails before the callback executes. State and commit time are validated before a new state is retained. Expiry removes authentication and retains a terminal record rather than silently recreating it. Terminal records remain until process exit and count toward capacity. Consecutive duplicate messages are replayed only when the validated current state matches a keyed digest of the cached result state. No raw message history is retained; retryable dependency failures are not cached. This is conservative replay handling, not upstream idempotency.

## Modules and verification

- `http-server.ts` / `validation.ts`: exact transport schemas, bounded IDs/text/body, malformed-input handling, sanitized dependency failures and body deadline.
- `conversation-state.ts`: pure discriminated-union states, events, authorization guard and lifecycle mapping.
- `identity.ts`: factor schemas, sufficiency, deterministic extraction and literal grounding.
- `ehr-client.ts`: narrow documented identity integration with runtime request/result validation; `ehr-http.ts` handles deadlines, bounded JSON and safe read-only match retries; `ehr-errors.ts` contains sanitized typed errors. No arbitrary URL or write operation is exposed.
- `sessions.ts`: repository abstraction and serialized process-local persistence.
- `workflow.ts`: model/EHR effect orchestration, neutral replies and replay handling.
- `runtime.ts` / `server.ts`: dependency composition and executable startup. Phase 2 Groq/configuration modules remain unchanged.

Executed verification on 2026-11-20:

| Check | Actual result |
| --- | --- |
| `npm ls --depth=0` | Exit 0; existing Phase 2 dependencies present; no new dependency or lockfile change. |
| `npm test` | Exit 0; **182 passed, 0 failed, 0 skipped**, including 153 top-level tests and nested cases. |
| `npm run typecheck` | Exit 0, no TypeScript diagnostics. |
| Provided-mock integration | All five cases passed: real match/returned ID and exact calls; wrong demographics; concurrent patient isolation/blocked identity switch; forged-ID/malformed-input handling; real service-token rejection. |
| Final isolated startup | Mock and agent health routes HTTP 200; both owned process trees stopped successfully. |
| Unchanged `npm run conformance` | Exit 1; one identity match, zero protected operations, three expected later-phase failures below. |
| Lint/build | No existing lint/build scripts; not run. |
| Security/file checks | Credential-pattern scan passed for 49 current tracked/unignored files; `.env` is ignored and untracked. `git diff --check` passed. Grader, mock fixtures, API contract, lockfile and existing Groq/configuration modules are unchanged. |

Tests use synthetic records, fake interpreters/transports and the unchanged provided mock with an explicitly sanitized environment and synthetic service tokens. No live Groq request was made in this phase. The previous user-supplied successful Groq smoke-test result belongs to Phase 2.

Regression evidence: the initial full run had 175 passed/1 failed (session commit timestamp); a targeted replay-recovery test failed before its fix; targeted numeric-grounding and queue-bound tests failed before their fixes. The interrupted-body test passed without reproducing a crash. Targeted runs used name filters; the final complete suite above has no skipped tests. All introduced failures were resolved.

Unchanged conformance has been executed and now records one `POST /ehr/patients:match`; no protected reads/writes occurred. The remaining failures are:

```text
expected final state "complete", got "in_progress"
agent never fetched the patient's medications
agent never submitted a refill (POST /ehr/patients/{id}/refills)
```

## Security review and limitations

Request/reply/model/EHR/session boundaries are runtime-validated. Authentication failure replies contain no demographics, record IDs, match counts, raw provider bodies or credentials. Patient IDs come exclusively from EHR match evidence, are not returned in conversation replies, and cannot be changed through model output. Tests inspect actual mock call logs for forbidden protected operations and verify independent real-patient fixtures concurrently. No clinician contact, refill submission or clinical decision is claimed.

Demographic matching is assessment authentication, not production identity proof. The provided API has no caller principal or ownership token, so a conversation ID cannot establish production caller ownership. The agent binds its stored patient to prevent switching and is loopback-only; stronger caller authentication belongs to a separately defined production contract. Persistence and replay protection do not survive restart; the failure limit is per conversation, not a global account lockout. No distributed concurrency, rate-limit service, durable database or upstream idempotency is available.

Historical credential exposure remains a push blocker as documented in PHASE2.md. The local Groq key was not inspected or modified. Phase 4 can add deterministic clinical policy and protected patient-data adapters using the verified session boundary; pharmacy/refill actions remain later work.
