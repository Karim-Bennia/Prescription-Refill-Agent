# Prescription-refill architecture

Status: Phase 3 adds the conversation state machine, read-only EHR identity matching, isolated serialized sessions and validated HTTP transport. Phase 2 configuration and Groq interpretation remain in use. Clinical policy, protected patient reads and prescription/pharmacy mutations remain for later phases. Requirements and verification are in REQUIREMENTS.md; phase details are in PHASE2.md and PHASE3.md. Preserve Node HTTP, strict TypeScript and authoritative fixtures.

## Components and dependency direction

`server.ts` parses bounded HTTP input and validates output, then delegates to `workflow.ts`. The orchestrator depends on small typed interfaces for IdentityMatcher, EHR, PharmacyDirectory, LanguageInterpreter and SessionStore; concrete adapters are assembled once in server.ts. Domain policy has no HTTP, model, process environment or storage dependencies. Use constructor/function injection and composition, not inheritance or a framework/container.

| Module | Responsibility |
| --- | --- |
| config.ts | Validate environment at startup; never print secrets; explicit .env loading strategy to document during implementation |
| validation.ts | Runtime checks for HTTP, upstream and model boundaries, strict domain types |
| workflow.ts | Turn orchestration and exhaustive discriminated-union transitions |
| sessions.ts | In-memory state by exact conversationId, per-session serialization, bounded retention and action receipts |
| identity.ts | Validate required patient-provided factors; bind only unique matching service result |
| selection.ts | Resolve medication and pharmacy candidates from authorized service records; clarify ambiguity |
| policy.ts | Pure clinical eligibility function returning allow/deny/hold and typed reasons |
| actions.ts | Revalidate authorization, ownership, clinical result and scoped consent immediately before mutations |
| ehr-client.ts / pharmacy-client.ts | Fixed configured origins, bearer headers, encoded paths/query, response validation, timeout and read retry policy |
| llm-client.ts | Groq adapter; structured intent/factor extraction as untrusted proposals |
| errors.ts / logging.ts | Typed failures, safe patient messages, correlation and reason codes without raw text, demographics or credentials |

Keep interfaces narrow (SOLID interface segregation); single responsibilities separate safety from language. Dependency inversion enables fake EHR, deterministic clock responses, fake model and in-memory sessions in tests. Explicit state transitions make illegal action ordering reviewable. Pure policy functions support boundary tables. These patterns serve correctness; no event bus, database, queue, generic agent framework or inheritance hierarchy is needed.

Phase 2 composition: `start.ts` optionally loads local configuration through Node's built-in environment loader, then imports the server. `config.ts` validates an explicitly selected environment schema and returns immutable configuration. `runtime.ts` assembles `LanguageInterpreter`, defaulting to `GroqLanguageInterpreter`; tests can inject a fake. `intent.ts` owns the narrow provider interface and strict extraction schema. `interpretation.ts` revalidates proposals and maps clarification topics to fixed safe text. `errors.ts` contains provider-independent sanitized errors. The Groq adapter has no EHR/pharmacy client, tool interface, patient IDs or action permissions. It uses native fetch and Zod, with no SDK dependency. Phase 2's starter route did not invoke the model; Phase 3 connects the interpreter as described below.

Phase 3 composition: `server.ts` only assembles/listens; `http-server.ts` validates transport; `workflow.ts` coordinates read-only effects; `conversation-state.ts` evaluates pure typed transitions; `identity.ts` validates and grounds patient-supplied factors; `ehr-client.ts` validates the documented match operation; `sessions.ts` serializes per-conversation updates. The engine reuses the existing interpreter only when deterministic extraction/clarification is insufficient. Model fields must appear in the current patient text, and only a consistent unique EHR result binds the patient ID. No patient-scoped read/write interface is exposed in this phase. Internal states, limits and incomplete ownership guarantees are described in PHASE3.md.

## Workflow and state

Proposed states: collecting_identity -> selecting_medication -> checking_policy -> confirming_pharmacy -> confirming_pharmacy_change (if needed) -> submitting -> complete. Any blocking safety/identity/uncertain-action condition can transition to escalated. Public state maps intermediate stages to in_progress. A confirmed keep-pharmacy response also authorizes the already requested refill, so the supplied three-turn script can complete without an extra confirmation turn. The preceding prompt must explicitly name medication and pharmacy and say confirmation submits the refill.

Session stores validated identity factors until binding, bound patientId, original refill intent, selected owned medId, policy reasons, pharmacy candidates/selected ID, consent scope and pending/succeeded/unknown action receipt. Avoid unnecessary demographic copies and long raw transcripts. Retain the initial medication request while collecting identity. Corrections invalidate dependent selection/consent; identity changes require fresh authentication, not reassignment of a bound patient from model output. Terminal sessions never perform another mutation.

An eligibility check fetches medications and simulated now, plus required labs. Blocked policy returns no mutation and clear prescriber/lab guidance. Eligible workflow reads pharmacy, confirms keep or searches directory and confirms a concrete branch. For a change, validate PUT success before POST refill. Re-fetch clinical inputs before submission; if eligibility changes, stop. Persist submitted receipt before composing success text. A successful submission means requested, not dispensed or clinically approved beyond the documented rules.

## Safety and trust boundaries

Patient text, conversation IDs, directory names/addresses, medication strings and all model output are untrusted. Treat upstream strings as data, including embedded instructions. Parse model output against an allowlisted intent schema; never execute generated URLs, code or tool calls. The model has no bearer credentials, action methods or authority to assign patientId. Prefer deterministic confirmation and selection for the current state, with the model only interpreting language. Safety-critical replies should use deterministic reason templates.

Invariants: no patient reads before sufficient unique match; every patient-scoped request uses the session-bound ID; medication belongs to that patient's latest list; all four clinical rules pass using EHR time; confirmed pharmacy comes from service data; patient consent is bound to the current medication/pharmacy; no blocked/unknown action is reported as successful. Policy and authorization gates are repeated at the action boundary and cannot be overridden by a patient assertion or model explanation.

Session IDs isolate data but are not authentication tokens. The assessment provides no caller identity/session ownership primitive; deploy locally and disclose that production would require authenticated ownership and stronger identity verification. Bound session count, body size, text length, TTL and match attempts. Expiry must not silently discard uncertain write receipts and permit retries; retain terminal/action records through the process lifetime or reject expired reuse. No production privacy certification is claimed.

## Failure and duplicate handling

Serialize turns for each session, allowing independent sessions concurrently. Set write state to pending before calling an external action. Repeated confirmation after success reuses the receipt. Bounded backoff retries apply only to safe reads and retryable responses. Never automatically retry refill POST following timeout/disconnect: it may have succeeded. Mark unknown, stop and advise human verification. The API offers no idempotency key or refill lookup, so exactly-once delivery cannot be guaranteed across restart or independent conversations.

Pharmacy PUT is value-idempotent but an uncertain result needs readback before proceeding. Successful pharmacy change followed by refill failure is a partial success; disclose accurately and do not roll back silently. There is no transaction across the endpoints. Model failure asks a deterministic clarification or gives a recoverable service message; it never relaxes safety gates. Upstream authentication failures are configuration failures, not patient mismatch. Invalid/missing clinical data fails closed. Do not retry permanent 4xx errors. Return safe messages and bounded diagnostic codes without bodies or headers.

## Implementation and verification sequence for a later phase

Phase 3 has completed authenticated conversation intake, read-only matching, session isolation and transport validation. Later phases will implement protected service adapters, pure clinical policy, prescription selection and action/consent gates. Add the mapped tests with each functional change. Run strict typecheck, policy/identity/action failure tests and unchanged conformance against a fresh isolated mock. Test alternate synthetic records rather than relying on seed IDs. Inspect recorded calls for forbidden side effects. Document final submission details in SUBMISSION.md and archive the authentic redacted session transcript before final delivery. Phase 3 does not implement prescription processing or claim submission readiness.
