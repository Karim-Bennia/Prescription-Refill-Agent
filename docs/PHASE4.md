# Phase 4: clinical policy and prescription workflows

Scope: authenticated clinical reads, grounded medication selection, deterministic rules, and the guarded refill domain operation. The public conversation stops at pharmacy confirmation. Phase 5 pharmacy prompts, directory search and pharmacy changes are not implemented. No push, history rewrite or local credential edit was performed.

## Clinical rule matrix

All rules are implemented in the pure `evaluateEligibility` function in `agent/policy.ts`, verified by `tests/policy.test.ts`, conversation tests and real-mock integration. The only clinical clock is the validated value from `GET /ehr/time`.

| Rule | Exact blocking condition | Permitting boundary | Required data / failure handling | Response and tests |
| --- | --- | --- | --- | --- |
| R1 | `schedule === "CII"`: decline and advise prescriber involvement. | Other schedules continue through the other rules; CII has no permitting date boundary. | Valid controlled flag/schedule required; inconsistency fails closed. | Schedule II refusal, no write; tests cover CII with remaining and exhausted refills. |
| R2 | `refillsRemaining === 0` OR expiration strictly before EHR now: decline and advise a new prescription. | Positive refills and expiration equal to or after now pass R2. | Count and expiration must be valid; missing/negative/invalid data blocks. | Separate no-refill/expiration reasons; equality and one-millisecond boundaries tested. |
| R3 | For CIII–CV, block when `now < lastFilledDate + daysSupply - 2 days`. | Equality and later instants pass R3; non-controlled prescriptions have no added early-refill rule. | Valid fill date, positive integer supply and consistent schedule required. | Early-controlled refusal; each controlled schedule and both sides of the boundary tested. |
| R4 | If a recent lab is required, a matching type must exist in `[now - withinDays, now]`; otherwise hold and advise the care team. | Inclusive cutoff/current instant; a null requirement needs no lab lookup. | Invalid or empty results fail closed; future labs cannot establish recency. No value threshold is invented. | Missing/out-of-window lab refusal; wrong type, stale/future/fresh mixtures, zero-day window and exact cutoff tested. |

Assumptions already established in requirements: UTC arithmetic, one day = 86,400,000 ms, date-only strings = UTC midnight, expiration uses literal `< now`. Required lab values must be nonempty, but are not interpreted numerically. Invalid dates, duplicate medication IDs, conflicting controlled flags, future fill dates and unrepresentable date arithmetic block eligibility. All applicable reasons are retained for otherwise valid data. R3/R4 use terminal escalation with advice; no clinician contact or handoff is claimed.

## Architecture and protected retrieval

- `clinical-types.ts`: strict Medication, Lab, EHR time, current-pharmacy and submitted-receipt schemas.
- `clinical-http.ts` / `clinical-ehr.ts`: fixed-origin transport and typed documented integration. GET retries are bounded with exponential jitter and Retry-After; bodies/deadlines are bounded. Refill POST is never automatically retried.
- `patient-clinical.ts`: protected reads derive patient ID from validated session state and a live repository-issued turn context. Forged, foreign, expired and finished contexts are rejected. Shared assessment retrieves EHR time and only the required lab type.
- `selection.ts`: deterministic selection from the authenticated patient's validated records. Case/whitespace/strength spacing normalize; numeric dose order, decimals, signs, percentages and formulations remain constraints. Unique partial names can resolve; ambiguous/missing/unavailable requests require clarification. No medication or indication aliases are hardcoded.
- `clinical-workflow.ts`: retrieves prescriptions, selects, evaluates policy, then either escalates or enters the pharmacy gate. No EHR records are sent to the model. The complete literal medication request is matched; a model substring cannot erase explicit dose/formulation constraints.
- `actions.ts`: consent scope, fresh action-boundary checks, immutable service receipts and a process-local write ledger.

The existing Groq provider remains unchanged. It may classify natural-language intent, but the medication query retains the patient's full literal constraints. Conflicting multi-sentence corrections or oversized queries ask for clarification rather than silently dropping information. Negative refill intent closes without submission. Production runtime enables clinical processing; the original Phase 3 intake-only unit fixtures remain valid and fail closed without any protected-action dependency.

## State and session changes

Existing authentication, cancellation, serialization, TTL, queue limits and replay behavior remain in place. New states are `medication_clarification`, `awaiting_pharmacy_confirmation`, terminal `clinical_escalated` and terminal `refill_submitted`. Public statuses stay exactly `in_progress`, `escalated`, `complete`; clinical eligibility alone never means complete.

Turn contexts are issued only inside `SessionRepository.run` and revoked when the callback exits. They retain patient binding and the actual saved selection. Newly verified identity is bound only after a unique validated EHR match. Protected operations check context liveness at each boundary. Selection revisions invalidate confirmation on changes, including A→B→A; terminal states cannot reopen. Session snapshots are deeply frozen/cloned. Replay digests include the validated state.

## Refill authorization and outcomes

`confirmCurrentPharmacy` is a normal internal domain interface for Phase 5's future explicit-confirmation workflow; it is not exposed through the Phase 4 HTTP conversation. It checks the current pharmacy from EHR and binds confirmation to conversation, patient, saved medication/name/query, pharmacy and selection revision. Null/mismatched pharmacy cannot confirm. No pharmacy PUT or directory interface exists in this phase.

`submit` requires that confirmed scope, a current authenticated session, a fresh owned medication list, deterministic re-selection matching the saved request, all policy checks using fresh EHR time/labs, and unchanged current pharmacy. It checks session expiry immediately before the write. Missing confirmation or any failed check prevents POST.

Before POST, the ledger records pending. Concurrent turns are serialized; concurrent actions within the same turn share one in-flight write. Compare-and-set checks prevent delayed confirmation from overwriting pending/submitted records. Validated immutable `{refillId,status:"submitted"}` evidence permits completion; it means submitted, not dispensed or medically approved beyond the documented rules. Known HTTP rejection stops; timeout/network/5xx or invalid successful receipts retain unknown-outcome protection. Pending/unknown actions are never blindly retried. Ledger evidence survives a failed session-state commit within the process, preventing a duplicate write on recovery.

## Executed verification

Executed on 2026-11-20:

| Check | Actual result |
| --- | --- |
| `npm test` | Exit 0; **309 passed, 0 failed, 0 skipped** (244 top-level plus nested cases). All 182 Phase 3 tests are unchanged and passing. |
| `npm run typecheck` | Exit 0, no TypeScript diagnostics. |
| `npm ls --depth=0` | Exit 0; existing TypeScript/tsx/Zod dependencies present. No new dependency or lockfile change. |
| Provided-mock clinical integration | Eight cases passed: six eligible/blocked R1–R4 scenarios, one explicit domain-confirmation/refill test, one real clinical-service authentication failure. |
| Actual integration calls | Ordinary clinical scenarios: match + medications + EHR time (3 calls), plus required labs where applicable (4). No runtime refill or pharmacy write. Authorized domain test: 8 total calls, exactly 1 refill POST, 0 PUT, with duplicate requests sharing the receipt. |
| Final isolated `npm run conformance` | Exit 1; 1 identity match, 1 same-patient medication GET, 1 EHR-time GET, 0 refill POST, 0 pharmacy PUT. Two expected Phase 5 failures below. Both services were healthy and stopped cleanly. |
| Lint/build | No existing scripts; not run. |
| Security/file checks | Credential-pattern audit passed for 65 current files. `.env` remains local, ignored and untracked. API/grader/mock/lockfile/Groq/configuration files and all original Phase 3 test files are unchanged. |

Exact remaining conformance failures:

```text
expected final state "complete", got "in_progress"
agent never submitted a refill (POST /ehr/patients/{id}/refills)
```

Routine tests use synthetic fixtures and fake language providers; the real supplied mock is exercised unchanged with sanitized child environments and synthetic service tokens. No real Groq request was made. Targeted regression runs intentionally used name filters; the final complete suite has no skipped cases. Initially failing regression results were preserved honestly and fixed before the final run; no tests were weakened to improve the count.

The integration suite covers real medication/time/lab calls and R1–R4 fixture outcomes, same-patient access, rejected service authentication, and zero premature runtime writes. A separate normal-domain confirmation test performs one real refill POST and verifies its validated receipt and duplicate protection. This does not add a public confirmation bypass.

Security regressions were reproduced before fixes: decimal/signed dose collapse; intake truncation of decimal/corrected/oversized requests; model substring removal of dose constraints; empty lab results/date arithmetic; unsaved selection consent; A→B→A consent revival; mutable receipts; same-turn duplicate writes; delayed confirmation overwriting action evidence. The final full-suite count includes every unchanged Phase 3 test, with no skipped cases.

## Limitations and Phase 5 work

The public runtime deliberately cannot submit on a generic “yes”: it has not displayed and collected a pharmacy-specific confirmation. Phase 5 must implement current-pharmacy presentation/consent, directory disambiguation using `GET /pharmacy/directory` with the pharmacy service token, confirmed `PUT /ehr/patients/{id}/pharmacy`, and consent-bound invocation of the existing action kernel. A pharmacy change must succeed before submission; uncertain PUT outcomes need readback. Rejection/cancellation must not authorize a refill.

The upstream API has no idempotency key, receipt lookup, transaction or clinical compare-and-write operation. Fresh checks cannot eliminate changes between upstream reads and POST. In-memory sessions/ledger/replay do not survive restart and do not deduplicate across independent conversations/processes. A conversation ID is still not production caller authentication; the supplied API lacks caller ownership tokens. Historical credential exposure remains a push blocker. No handoff endpoint exists, and none is invented.
