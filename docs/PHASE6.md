# Phase 6: clinical safety and agent reliability evaluation

Scope: deterministic evaluation, focused defect correction and engineering evidence. No Phase 7/8 work, live Groq call, dependency addition, push, history rewrite or local environment-file access is included. The original 378 test cases and their source files are preserved.

## Method and traceability

The prioritized gap analysis, reproducible commands and requirement → implementation → unit/integration/HTTP matrix are in TESTING.md. Existing coverage was reviewed before adding tests. New files cover generated clinical properties, hostile input/data, real HTTP correction conversations, actual process restart, controlled races and provider failures through the complete validation/orchestration path. A shared synthetic evaluation fixture logs read/write attempts and permits isolated fault injection.

All parameter products are fixed and bounded, with failing case coordinates included in assertions; no random seed is needed. Generated combinations are counted separately from Node test cases. Tests use independent expected UTC arithmetic, strict response schemas and service-call/effect assertions. Timing races use promise gates or injected clocks; latency measurements have no invented acceptance threshold.

## Defects reproduced and corrected

| Defect | Failing evidence before correction | Root cause / focused correction | Regression |
| --- | --- | --- | --- |
| Expired read lease could renew authentication | A turn expired during medication revalidation; a later confirmation returned `complete` and wrote a refill instead of stopping. | A caught dependency/lease error returned the prior authenticated state, and repository commit reset activity time. Commit now terminally expires any nonterminal update whose lease elapsed; workflow returns the fixed expiry response. Terminal evidence from an already accepted in-flight write is preserved. | `evaluation-resilience`: expiry during revalidation; accepted pending refill plus queued cancellation/expiry. |
| Oversized directory reply saved undisplayed choices | Ten valid long directory records produced HTTP 503, while selection state had already changed. | A fixed count of ten ignored replySchema's 4000-character limit. Saved choices now fit a 3000-character rendered budget plus prompt headroom; undisplayed ordinal choices cannot authorize a change. No identifying string is silently truncated. | `evaluation-security`: real HTTP long-directory contract and unseen tenth choice. |
| Supported confirmation routed as medication text | “I confirm” returned `in_progress` rather than completing the permitted refill. | The parser recognized the command, but workflow used a narrower routing regex. Recognized deterministic pharmacy commands now reach the existing guarded workflow. | `evaluation-language`: supported explicit phrases through complete production composition. |

Only `agent/sessions.ts`, `agent/workflow.ts` and `agent/pharmacy-workflow.ts` receive production corrections. Policy, authorization kernel, Groq adapter, API contract, mock and conformance checker remain unchanged.

## Clinical evaluation

The exact API rules remain authoritative: R1 blocks CII; R2 blocks zero refills or expiration strictly before EHR time; R3 blocks CIII–CV before `lastFilled + daysSupply - 2 days`; R4 needs a matching lab in the inclusive EHR-time window, excluding future labs. No lab-value thresholds or medical synonyms were added.

New generated evidence includes:

- R1: 72 fixed time/supply/refill/lab combinations remain blocked.
- R2: 36 equivalent-time-zone and expiration ±1ms/equality combinations.
- R3: 648 schedule/supply/time-zone/boundary combinations across leap/year transitions; additional one-/two-day supply checks avoid inventing a waiting rule.
- R4: 288 lower/current/future boundary combinations, evidence permutations, conflicting values and malformed evidence. Value agreement is not an API policy requirement.
- Selection: 24 long exact decimal-strength cases beyond floating-point precision; distinct explicit doses remain distinct.
- Guarded action boundary: 27 fresh-time cases, with 9 blocked/zero-write and 18 allowed/single-write outcomes including receipt replay.

Existing clinical tests cover missing/malformed classification, dates/supply/labs, wrong type, exhausted counts, controlled inconsistency and real seed R1–R4 outcomes. New conversations make medication/lab/expiration data unsafe after an authorized pharmacy change and verify no refill follows.

## Conversation, authorization and model evaluation

| Categories | Evidence |
| --- | --- |
| A/F permitted refill/current pharmacy | Existing real mock public workflow and concurrent confirmations. |
| B incorrect then valid identity; P concurrent patients | New real HTTP security conversation, distinct bound patient call/effect assertions. |
| C ambiguous prescription; H changed medication; I changed pharmacy; L contradictory medication | New HTTP correction table verifies clarification, final selection/destination and mutation counts. |
| D clinical refusal; E missing lab | Existing real clinical/pharmacy integrations plus new post-change safety-data faults. |
| G pharmacy change and refill | Actual directory/PUT/readback/refill integration; separate consent preserved. |
| J cancel; K repeated turn; M expiry | Existing regressions plus gated cancellation/pending-write/expiry tests. |
| N dependency outage; O uncertain submission | Existing adapter/mock tests and new fresh-read failure/recovery and actual accepted-write/lost-receipt restart evaluation. |

Adversarial corpora contain eight pre-authentication and five authenticated messages. They attempt forged identities/IDs/consent, clinical override, secret/instruction extraction, cross-patient access and fabricated success. Observed unauthorized reads/mutations: zero. Synthetic instruction-like medication/pharmacy/directory records remain data: they cannot bypass clinical policy, choose fabricated IDs or skip separate consent. This is bounded adversarial evidence, not a claim of universal injection resistance.

Thirteen malformed/unavailable provider cases run through the existing Groq HTTP adapter, runtime validator and complete engine: missing fields, invalid JSON/intent, conflicting intent type, fabricated IDs, empty/truncated/unexpected bodies, rate limit, unavailable model/provider and timeout. Every case fails safely before protected operations and permits later deterministic recovery. Offline labeled replay agrees on 8/8 supplied fixtures. **This measures adapter replay agreement, not real model classification accuracy.** Live/unseen-patient model reliability remains unverified and is reserved for Phase 8 with rotated credentials.

## Faults, concurrency and restart

Existing identity/clinical/pharmacy/model transport tests cover bounded safe-read retries, 401/403/404/429/5xx, timeouts, malformed JSON/schema, bounded bodies and single-attempt writes. New tests fault medication/time/lab/pharmacy reads after explicit consent, assert zero writes and verify recovery. Existing tests retain unknown outcomes after POST/PUT and recover action evidence after failed session commits.

Cancellation queued before confirmation causes no refill. Cancellation queued after an accepted pending refill cannot erase its receipt or initiate another write. Expiry during revalidation prevents later authorization; expiry while an already initiated write is accepted preserves factual terminal evidence. Existing queue and capacity tests retain the 32-turn bound and bounded session reservation behavior.

An actual agent child process is stopped and recreated while the supplied mock remains running. Old conversation IDs/affirmations cause zero service calls until fresh authentication. Stored pharmacy consent is lost. A refill actually accepted before its receipt is lost remains protected within the original process, but can be submitted again after restart and fresh authentication because the unknown ledger is gone. Two independently authenticated sessions can also each submit the same prescription. These are demonstrated limitations, not resolved idempotency guarantees.

## Executed verification and measurements

| Executed check | Actual result |
| --- | --- |
| `npm test` | Exit 0: **429 passed, 0 failed, 0 skipped**; 327 top-level plus nested cases, 58.82 seconds. All 378 prior tests unchanged/passing; 51 new counted cases. |
| `npm run test:coverage` | Exit 0: **429 passed, 0 failed, 0 skipped**, 62.71 seconds; native coverage below. |
| `npm run typecheck` | Exit 0, no diagnostics. |
| Unchanged `npm run conformance` | Exit 0, **CONFORMANCE PASSED**; isolated mock and complete application composition healthy. Exact calls: match 1, owned medications 2, EHR time 2, pharmacy GET 3, refill POST 1, PUT 0. |
| Real supplied mock integrations | Existing authentication, eight clinical and eleven pharmacy scenarios remain passing. New controlled restart actually records one accepted/lost-receipt refill, zero unauthenticated calls after restart, then a second refill only after fresh authentication/consent. |
| Security/file review | Credential-pattern audit passed for 83 non-environment files. Local `.env` is present, ignored and untracked; never inspected or edited. Original tests, API, mock, conformance, lockfile, provider, pure policy and refill kernel unchanged. |
| Live model / lint / build | No real Groq call; no existing lint/build script. |

Selected application coverage from the final native report:

| Module | Line % | Branch % | Function % |
| --- | ---: | ---: | ---: |
| policy.ts | 100.00 | 100.00 | 100.00 |
| selection.ts | 100.00 | 97.18 | 100.00 |
| sessions.ts | 100.00 | 95.24 | 100.00 |
| actions.ts | 97.18 | 93.06 | 100.00 |
| pharmacy-workflow.ts | 98.43 | 90.91 | 100.00 |
| workflow.ts | 96.46 | 92.26 | 100.00 |
| llm-client.ts | 100.00 | 95.83 | 80.00 |
| Native all files, including tests/support | 99.38 | 96.48 | 94.87 |

The final uninstrumented workload observation on Windows / Node v20.17.0 was **742ms** total for 12 concurrent conversations / 36 HTTP turns, median turn **217ms**, p95 **297ms**. Worker RSS was **79,978,496 → 124,628,992 bytes**. The ordinary and coverage suites ran concurrently, so scheduling and instrumentation contention affect this observation; RSS is an instantaneous worker reading, not peak or per-conversation memory. No production latency guarantee is inferred.

The bounded workload uses 12 concurrent conversations / 36 actual local HTTP turns with fake language and in-process synthetic services. Reported latency includes request/JSON processing and local scheduling; it is not Groq latency or a production throughput benchmark. No external API load was generated. Results vary with coverage instrumentation and concurrent test workers.

Coverage is Node 20.17.0's experimental V8 **line/branch/function** coverage. Statement coverage is not supplied. Native all-files totals include tests and support code; application-module figures are reported separately. A measured 100% for a module is not proof of all clinical states or production behavior. Entry-point subprocess/platform branches may not be collected.

Debugging runs intentionally used name filters and showed filtered skips; every final complete run above has zero skips. Failing reproductions were executed before the three production fixes, and targeted/related/full regressions passed afterward. No test was weakened to obtain these results.

## Residual risks and Phase 7 priorities

1. Historical Groq-key exposure remains a submission/push blocker; rotate it and plan safe history remediation without reusing or displaying the compromised value.
2. A conversation ID is a routing key, not a caller principal. Production needs an authenticated caller/ownership contract and stronger patient verification.
3. In-memory sessions/ledgers lose pending/unknown receipts on restart and cannot globally deduplicate independent sessions. Durable pending evidence and upstream idempotency/reconciliation require a separately designed contract; no database was added here.
4. Backend state can change after validation reads and before PUT/POST. The API supplies no conditional clinical write or cross-service transaction. Partial pharmacy-change/refill failure cannot be atomically rolled back.
5. Terminal entries remain until process exit and consume session capacity. Production needs admission/rate limits and a retention policy that does not discard uncertain action evidence.
6. Live model classification, larger/alternate datasets and broader sustained load remain limited or unverified. Synthetic/offline passing tests do not establish real-world medical safety or regulatory readiness.

Phase 7 security/reliability review is recommended; it has not started. No push was performed.
