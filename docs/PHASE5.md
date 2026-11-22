# Phase 5: pharmacy consent and complete refill execution

Scope: complete the public pharmacy/refill workflow using the unchanged API, mock and conformance checker. No Phase 6 work, push, history rewrite, dependency addition or local credential edit is included.

## Implementation

| Module | Responsibility |
| --- | --- |
| `agent/pharmacy-client.ts` | Narrow `PharmacyService` adapter, strict directory/update schemas, separate service origins/tokens. |
| `agent/clinical-http.ts` | Reused bounded transport; adds directory GET and pharmacy PUT to its operation allowlist. |
| `agent/pharmacy-selection.ts` | Pure explicit-confirmation parsing and deterministic selection from actual presented directory records. |
| `agent/pharmacy-state.ts` | Discriminated pending-question schemas: `confirm_current`, `search`, `confirm_change`. |
| `agent/pharmacy-workflow.ts` | Pharmacy presentation/search/change effects, readback and change ledger; invokes the existing refill kernel. |
| `agent/conversation-state.ts`, `agent/sessions.ts` | Pure `pharmacy_prompt` event, validated contexts, saved-question evidence and revision invalidation. |
| `agent/actions.ts` | Existing sole refill kernel; additionally checks that pharmacy context matches the saved turn question. |
| `agent/runtime.ts`, `agent/server.ts`, `agent/workflow.ts` | Complete executable composition and integration with existing identity, clinical and session behavior. |
| `agent/clinical-workflow.ts` | Sanitized pharmacy rejection/unknown terminal replies; clinical rules unchanged. |
| Four `tests/pharmacy-*.test.ts` files, `package.json` | Adapter, selection, workflow and real HTTP integration coverage included in `npm test`. |

Patterns: Adapter, Dependency Injection, existing Repository/State Machine, existing pure clinical Policy. No framework or infrastructure was added. The Groq adapter and extraction schema are unchanged. Deterministic pharmacy commands need no model call; model output cannot populate IDs, consent or action state. `createApplicationRuntime` is the complete application factory used by the executable and new HTTP tests. `createRuntime` remains an injectable clinical-core composition for the unchanged prior regression tests; omitting a pharmacy capability fails closed. There is no environment setting that disables production authorization.

## Exact service contract

- Existing `GET /ehr/patients/{patientId}/pharmacy` returns the current `{pharmacyId,name}` or null.
- New `GET /pharmacy/directory?q=<encoded literal query>` returns validated `{pharmacyId,name,address}[]`, using the pharmacy service token/origin.
- New `PUT /ehr/patients/{patientId}/pharmacy` sends only `{pharmacyId}` and requires `{ok:true}`, using the EHR token/origin.
- Existing guarded `POST /ehr/patients/{patientId}/refills` sends only `{medId}` and requires `{refillId,status:"submitted"}`.

No pharmacy-by-ID, handoff, idempotency or refill-reconciliation endpoint is invented. HTTP responses and fake injected services are validated. The shared transport keeps bounded bodies, deadlines, safe read retries/backoff and sanitized typed errors. PUT and POST are always single-attempt.

## Conversation and consent

After unique patient authentication, grounded prescription selection and deterministic eligibility, the current pharmacy is fetched and presented with its real name/reference. The current-pharmacy API supplies no address; directory choices display actual names and addresses. A null pharmacy starts selection, with no free-floating confirmation permitted.

| Pending question | Patient trigger | Effects and next state |
| --- | --- | --- |
| `confirm_current` | Explicit affirmative | Confirm the exact saved pharmacy scope, invoke the existing refill kernel, complete only on submitted receipt. |
| Any pharmacy question | Change/search request | Invalidate the former question before directory access, even if access fails; present up to ten stable choices or an exact-destination confirmation. |
| `search` | Unique number/ordinal/name/address | Resolve only a presented service record, then ask `confirm_change`; ambiguous/invalid selections do not mutate. |
| `confirm_change` | Explicit affirmative | Revalidate the destination, record pending, PUT once, read back the pharmacy, then ask a separate `confirm_current` refill question. |
| `confirm_change` | “Keep my pharmacy” | Present the existing current pharmacy afresh; do not interpret this as consent to change it. |
| Any pharmacy question | No / unclear response | Ask for selection or repeat the focused question; no write. |
| Any active state | Medication correction | Re-run grounded clinical selection and invalidate pharmacy context/consent. |
| Any active state | Cancellation / expiry / identity switch | Existing terminal lifecycle applies; no later mutation. |

The initial prompt explicitly says confirmation submits the named medication to the named pharmacy. A change confirmation authorizes only PUT; after successful readback, the patient must separately confirm refill submission. Public statuses remain exactly `in_progress`, `complete`, `escalated`. Submission means a request was submitted, never dispensing.

Consent is bound to the real repository-issued active context, patient, saved medication ID/name/query, pharmacy and selection revision. Repository snapshots are immutable. The saved pending question must match exactly; replacing or omitting context cannot preserve authority. Search/destination/medication changes advance the selection revision, including changes back to an earlier choice. IDs written in chat/model output are not directory evidence. Pharmacy ZIP searches cannot rebind patient identity.

Consecutive identical turns are conservatively replayed. In particular, repeating the same “Yes” immediately after a pharmacy change replays its result rather than authorizing a second action. The displayed next prompt asks for “Yes, keep my pharmacy” to provide distinct refill consent. The API offers no request ID with which to distinguish a retransmission from a new identical message.

## Clinical and transaction safety

`RefillActions.submit` remains the only refill write path. It retrieves fresh owned medications, reselects the saved prescription, fetches authoritative EHR time and any required lab, evaluates unchanged R1–R4, rereads the current pharmacy, verifies exact consent/revision and checks active session liveness before POST. No model-based clinical authorization exists.

The existing refill ledger retains pending/submitted/unknown/rejected evidence and immutable receipts. A separate pharmacy-change ledger records pending before PUT and retains the scoped result before session commit. Successful readback establishes the intended destination; a timeout can be reconciled by GET without another PUT. Unverified outcomes stop as `pharmacy_unknown`; known rejections stop as `pharmacy_rejected`. Neither permits refill submission. A verified pharmacy change followed by refill failure remains a partial result; no silent rollback or successful-refill claim occurs.

Session serialization prevents concurrent turns from duplicating writes. Retained action evidence recovers both a successful pharmacy update and a refill receipt after a failed session commit without another mutation. Unknown outcomes are never blindly retried.

## Executed verification

Final executed results:

| Check | Result |
| --- | --- |
| `npm test` | Exit 0: **378 passed, 0 failed, 0 skipped**, including 300 top-level tests and nested cases. All 309 previous tests remain unchanged and passing; 69 new counted cases are included. |
| `npm run typecheck` | Exit 0, no diagnostics. |
| Real mock HTTP integration | All eleven new scenarios passed, alongside all eight existing clinical integration cases. Actual effects are recorded below. |
| `npm run conformance` | Exit 0, **CONFORMANCE PASSED**, using the actual executable `npm run agent` and an isolated mock; both health checks succeeded and owned process trees were stopped. |
| Security/file checks | Credential-pattern audit passed for 73 non-environment files; `.env` remains present, ignored and untracked. Existing tests, API, conformance, mock, lockfile and Groq/configuration modules are unchanged. |
| Live Groq / lint / build | No live Groq call made; no existing lint/build scripts. |

The new real HTTP integration uses an isolated unchanged mock, ephemeral ports, synthetic service tokens and a fake interpreter. Its eleven scenarios cover public completion/concurrent confirmation; all four clinical blocks; directory selection and actual pharmacy change; missing consent; cancellation/identity switching; expiry; real directory authentication failure; and an actually accepted refill whose client loses the result.

| Real scenario | Actual recorded service effects |
| --- | --- |
| Current pharmacy refill, including concurrent/replayed confirmation | 9 calls: match 1, medications 2, time 2, pharmacy GET 3, refill POST 1, PUT 0. |
| Changed pharmacy refill with fresh required lab | 16 calls: match 1, medications 2, time 2, labs 2, pharmacy GET 5, directory GET 2, PUT 1, refill POST 1. Includes one independent test readback. PUT precedes POST; authoritative destination matches. |
| R1/R2/R3 blocked requests | 3 calls each: match, medications, time; zero pharmacy reads/writes or refill writes. |
| R4 missing recent lab | 4 calls: match, medications, time, labs; zero mutations. |
| Accepted refill, unknown client outcome | 9 calls, exactly one actual refill POST; repeated confirmation remains stopped. |
| Unchanged official conformance | Passed; match 1, medications 2, EHR time 2, pharmacy GET 3, refill POST 1, PUT 0. |

Existing tests are preserved, not weakened or skipped. Targeted regression runs intentionally filter test names; the final full suite runs every test. No live Groq credits are consumed. No lint/build scripts exist.

## Review findings and limitations

Regression tests reproduced and fixes address stale consent after failed/compound/corrected pharmacy searches, “keep current” contradicting a pending change, ZIP searches incorrectly treated as identity changes, and modified/omitted unsaved pharmacy context at the refill boundary. Failure/replay tests verify cancellation, expiry, prompt injection/invalid IDs, changed medication/destination, uncertain writes and failed-commit recovery. There is no raw prompt, patient-data or credential logging added.

Remaining limitations: process-local sessions/ledgers cannot guarantee deduplication after restart or across independent conversations/processes. The supplied API has no caller principal/ownership token, upstream idempotency, atomic clinical compare-and-write, refill-status lookup or cross-endpoint transaction. Read/check/write races against external changes remain possible. Search is deliberately conservative and may request clearer literal names/locations; only ten results are displayed per search. No real clinician handoff exists or is claimed.

Historical credential exposure remains a push blocker; rotation and safe history remediation are still required before any future push. Local `.env` is preserved, ignored and untracked. Phase 6 may evaluate broader alternate datasets, adversarial/load/restart scenarios and final delivery artifacts; none is claimed complete here.
