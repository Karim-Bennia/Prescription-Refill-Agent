# Phase 7: security, reliability and architecture review

Scope: review the actual implementation and apply focused, regression-tested hardening. No Phase 8/9 work, live Groq request, push, history rewrite, package upgrade, host-runtime replacement or local `.env` inspection/edit is included.

## Method and prioritized findings

Reviewed the API/grader, architecture/requirements, phase records, all agent responsibilities and relevant tests, mock behavior, configuration and dependency graph. Trust boundaries were traced from HTTP input through session leases, model validation, service adapters, deterministic policy and the sole refill kernel. Findings were reproduced with synthetic fixtures before selected repairs. Severity: Critical means demonstrated broad/system compromise; High means material authorization/clinical/deployment exposure; Medium means bounded integrity/availability/diagnostic defects; Low means maintainability issues. No new Critical application exploit was established in this local assessment.

| Finding | Severity | Impact | Modules / evidence | Recommended remediation | Safe assessment fix? |
| --- | --- | --- | --- | --- | --- |
| Caller ownership is absent; routing IDs are caller-chosen, not guaranteed unpredictable | High | A caller knowing an authenticated conversation ID can continue that conversation. Identity isolation does not authenticate its caller. | API §1, validation.ts/sessions.ts; known-ID continuation test. Fixed grader IDs must remain accepted. | Authenticated caller/gateway ownership binding, secure session issuance and transport; require a production contract. | No compatible mandatory-token change; residual explicit. |
| Restart and independent conversations lose/share no global action evidence | High | Fresh authentication can repeat an already accepted/uncertain refill. | Phase 6 actual process-restart and same-patient/two-session tests; process-local maps. | Durable pending evidence plus upstream idempotency/reconciliation and defined transaction identity. | Partial local mitigation only; no unproven file ledger added. |
| Clinical check/write race is not atomic | High | Backend eligibility/pharmacy can change after the last snapshot and before POST. | hardening-actions test changes remaining refills during final pharmacy GET; POST still follows. API has no version/conditional write. | Backend atomic clinical authorization/compare-and-submit and pharmacy binding. | Fresh checks preserved; app rereads cannot eliminate this race. |
| Historical Groq credential exposure | High | Previously committed credential may permit account abuse until revoked. Rotation status is not established here. | Git metadata shows two commits affecting `.env`; historical contents/key were not read. | Rotate, verify revocation and plan approved safe history remediation before submission/push. | Current ignored/untracked state preserved; provider-owner action remains required. |
| Execution host Node 20.17.0 is EOL | High deployment gap | Unsupported runtime can retain unpatched vulnerabilities despite a clean package audit. | Actual node version; official Node EOL/release documentation linked below. | Upgrade and validate on a supported LTS before deployment. | Host unchanged; supported-runtime validation remains outstanding. |
| Accepted refill could be relabelled as a new pharmacy after failed state commit | Medium | False destination statement and unnecessary pharmacy mutation after an earlier submitted action. | Failed regression: receipt A retained, prompt B used in reply; exactly one POST. actions.ts/pharmacy-workflow.ts/workflow.ts. | Recover retained pending/submitted/unknown/rejected evidence before accepting another intent; preserve actual receipt scope. | Fixed, with zero new protected operations during recovery. |
| Terminal replay accepted a forged pharmacy scope | Medium internal integrity gap | A trusted domain caller could receive inconsistent destination metadata; no new POST occurred. | hardening-actions forged terminal state rejected only after correction. | Match stored pharmacy as well as patient/medication/receipt. | Fixed at existing kernel. |
| Expiry could falsely deny an earlier accepted/unknown action | High | “No refill has been submitted” could encourage a duplicate after a failed session commit. | Accepted and uncertain red regressions after TTL expiration. workflow.ts. | Stop new actions without asserting an earlier outcome; valid active sessions recover retained evidence. | Fixed; expiry exposes no protected receipt/details. |
| Incomplete headers outlived short configured deadlines | Medium | Slow clients retain connections until Node's default 30-second timeout scan. | Raw TCP red regression: 25ms configuration did not close within 1500ms. http-server.ts. | Configure server deadlines at construction and bound the scan interval. | Fixed; body deadline retained. |
| Credential ASCII control characters passed startup validation | Medium | Invalid outbound headers fail later and can trigger misleading provider/network classification. | NUL/ESC/DEL red regression for all three key variables. config.ts. | Reject controls at configuration parsing; report variable names only. | Fixed; no secret value logged. |
| HTTP failures lacked safe request correlation | Medium operational gap | Operators had little diagnostic evidence without inspecting sensitive messages. | Previously only startup/listener diagnostics. | Server-generated request ID and allowlisted response metadata; broader restricted audit controls for production. | Added privacy-safe optional observer; no telemetry dependency. |
| Asynchronous diagnostic failures escaped synchronous isolation | Medium | An optional rejected sink promise could produce an unhandled rejection/process failure. | Red regression on the new observer; not a pre-existing provider/action failure. | Consume rejected sink promises without exposing their errors or changing patient outcomes. | Fixed before commit; sync/async failure tests pass. |
| Terminal retention and overall admission remain bounded but limited | Medium deployment gap | The default 1000 retained sessions can exhaust capacity; socket/workflow/global rate controls are incomplete. | sessions.ts default capacity/32-turn queue; existing resource tests. | Production admission/rate policy, lifecycle retention and protected uncertain-action storage. | Existing bounds preserved; header resource gap fixed. |
| Some module layering/comments lag current behavior | Low | Schema import from pharmacy adapter and a large orchestration method increase future change cost. | Import graph has no cycle; classes remain small/cohesive. | Extract pure shared schemas if another provider needs them; clarify effect ownership. | Corrected comment only; broad refactor deferred. |

## Architecture and safety assessment

The existing State Machine, Adapter, Dependency Injection, Repository, pure Policy and pending-action patterns serve concrete responsibilities. Policy has no HTTP/model/storage dependency. Adapters own transport/schema validation; protected readers derive patient IDs exclusively from repository-issued live leases. The model gets no action methods and cannot supply trusted identifiers, eligibility or consent. TypeScript unions and runtime Zod checks remain the boundaries; guarded non-null assertions are backed by live-context validation. No import cycle was found in the agent graph. No framework, inheritance hierarchy or alternate refill path was introduced.

The focused changes add `RefillActions.recoverRecorded` and a pharmacy recovery admission check. They restore already recorded facts after interrupted commits; they never perform a new service call or make a fresh eligibility decision. New intents, pharmacy changes and cancellation cannot overwrite an earlier known/unknown action outcome. Existing immutable receipts, compare-and-set confirmation guards and serialized sessions remain in use. Expired sessions receive generic verification guidance rather than receipt data or a false denial.

Every fresh public refill still reaches `RefillActions.submit`: current authenticated identity, saved selection/revision, owned medication reread, exact deterministic selection, EHR-time/lab policy evaluation, current pharmacy and scoped consent, then pending-before-single-POST. R1 CII, R2 zero/expired (`expiration < now`), R3 CIII–CV (`now < lastFill + daysSupply - 2 days`) and R4 inclusive recent/nonfuture matching lab remain unchanged. No lab-value threshold, handoff endpoint or model authorization is invented. Backend acceptance is submission, not dispensing.

## Restart/idempotency decision

The mock returns `rf_<counter>` receipts, but the counter is process-local and resets with the mock. No durable/global identifier guarantee, refill-history query, idempotency key, transaction identifier, conditional write or atomic pharmacy/refill transaction exists. `__calls` is mutable diagnostic introspection, records requests before outcomes and is not authoritative refill reconciliation.

A local journal could reduce some restart duplicates, but a safe design would need atomic write-ahead persistence/fsync, crash/torn-write/corruption handling, interprocess exclusion, pending/confirmed/unknown recovery, protected stable keys/identifiers, retention semantics and verified OS permissions. POSIX file mode alone does not establish a Windows ACL. A crash after backend acceptance but before local confirmation still requires upstream reconciliation or a human-verification stop. Hashing patient/medication alone cannot distinguish a repeated transaction from a legitimate future refill; the API supplies no stable logical request key. Persisting sensitive evidence without those decisions adds privacy and operational risk.

No database, speculative persistence option or claim of global exactly-once behavior was added. This phase improves **in-process** recovery. Restart, multiple processes and independent conversations remain explicit production gaps; the existing demonstration tests remain unchanged.

## Transport, observability and configuration

Incomplete-header deadlines now use server construction options and a scan interval no greater than the smaller of 1000ms and the body deadline. Scheduling is event-loop dependent. The native whole-incoming-request fallback is `3 * bodyTimeoutMs + 1000ms`, allowing header parsing and the earlier application body timer to produce its JSON 408 rather than racing a native empty 408. Existing 16KiB request bodies, 4000-character patient text, response validation, bounded upstream bodies/deadlines and safe-read retry budgets remain. PUT/POST are never automatically retried, including unknown outcomes.

`observability.ts` validates a strict allowlist: event tag, random request UUID, response status/category and elapsed milliseconds. `http-server.ts` ignores supplied request IDs, returns its own `x-request-id` and invokes an optional observer after response finish. `server.ts` uses the safe JSON sink. No raw URL/conversation ID, demographics, text, clinical record, credential, header or error object is logged. Sink failure cannot alter patient outcomes. Parser/header errors before the request callback and aborted responses without `finish` can lack an application observation; production needs connection-level monitoring, restricted clinical audit, alerting and incident response.

Configuration rejects ASCII control characters in credentials and preserves sanitized variable-name errors. `.env.example` credential fields were checked as placeholders without printing values. Local `.env` was not opened, modified or staged and remains ignored/untracked. `npm audit --json` completed with **zero advisories** and no package/lockfile changes. The installed runtime remains Node 20.17.0; [Node's EOL page](https://nodejs.org/en/about/eol) identifies that major as unsupported. Package audit does not assess that host-runtime support gap. No host upgrade or unrotated-key test was attempted.

## Verification

| Executed check | Actual result |
| --- | --- |
| `npm test` | Exit 0: **447 passed, 0 failed, 0 skipped**, 343 top-level plus nested cases, 43.39s. All original 429 cases/files unchanged and passing; 18 new counted cases. |
| `npm run test:coverage` | Exit 0: **447 passed, 0 failed, 0 skipped**, 42.34s. Executed after the ordinary suite to reduce contention. |
| `npm run typecheck` | Exit 0, no diagnostics. |
| Unchanged `npm run conformance` | Exit 0, **CONFORMANCE PASSED** against actual `agent/start.ts` and supplied mock, with synthetic environment and an empty temporary startup directory. Match 1, medications 2, EHR time 2, pharmacy GET 3, refill POST 1, PUT 0. Owned processes/directories cleaned up. |
| Real mock regressions | Existing authentication, eight clinical and eleven pharmacy scenarios remain passing, including actual pharmacy PUT/refill POST and blocked zero-write cases. Actual restart/unknown-outcome demonstrations also remain passing. |
| Startup/diagnostics | Actual entry point starts from injected configuration without a local env file; missing key and occupied listener exit safely. Sync/async sink failures and incoming correlation injection are isolated. |
| `npm audit --json` / `npm ls --depth=0` | Exit 0; **0 advisories**. Existing Zod/tsx/TypeScript/@types-node dependencies intact, no lockfile change. |
| Secret/file checks | Credential-pattern scan passed for 92 non-environment files; safe example credential placeholders verified separately. Local `.env` remains present, ignored and untracked. Original test files, API/mock/grader, lockfile, Groq adapter and clinical policy remain unchanged. |
| Lint/build/live Groq | No lint/build script defined; no live model request made. |

Coverage uses native line/branch/function counters, never unweighted averages; statement coverage is unavailable. The application aggregate excludes tests/support/mock/dependencies:

| Scope | Lines | Branches | Functions |
| --- | --- | --- | --- |
| **Application only: 31 collected agent modules** | **2694/2732 — 98.61%** | **1266/1341 — 94.41%** | **266/278 — 95.68%** |
| Native all files including test/support code | 99.15% | 96.23% | 94.73% |

Uncollected entry-point lines (including the intentionally unrun live Groq smoke path) remain unmeasured. Experimental V8/source-map percentages are supporting evidence, not complete functional/clinical coverage. Filter/weighting tests use distinct per-metric counters and reject malformed counters. Windows reporter loading was verified with a `file:` URL rather than an unsupported bare drive-path ESM specifier.

Red reproductions were executed before the corresponding fixes. The initial complete hardening run had 446 passed/1 failed (the original stalled-body JSON test); the native/application timeout race was then corrected, with all original transport tests unchanged. A new observer's asynchronous-rejection test also failed before promise isolation and required stopping only its owned test process; bounded final reruns pass. A TypeScript callback-return mismatch in the new diagnostics tests was corrected without weakening assertions. Final complete runs above have zero skips; earlier name-filter debugging runs intentionally showed filtered skips.

## Production-readiness gap analysis

| Class | Assessment |
| --- | --- |
| A — Implemented and verified locally | Deterministic R1–R4, demographic matching, bound session leases, scoped consent, grounded selection, real mock pharmacy/refill workflow, bounded reads/writes, pending/unknown safeguards, retained-result recovery and sanitized HTTP diagnostics. |
| B — Partially validated | Real Groq interpretation, alternate datasets, sustained operational load, supported-LTS behavior and broader adversarial cases. Synthetic workload/coverage do not establish live latency or clinical safety. |
| C — Unsupported by upstream contract | Independently authenticated caller ownership, atomic clinical/pharmacy submission, server idempotency, authoritative refill reconciliation, durable globally unique transaction identity and real clinician handoff. |
| D — Required for real patients | Supported/patched runtime, stronger patient/caller authentication, secure durable sessions/actions, compliant vendor/secrets controls, clinical oversight/validation, privacy review, restricted audit/monitoring, deployment/backup/recovery and incident-response evidence. |

This local assessment is not represented as HIPAA-compliant, clinically certified or ready for real patients.

## Phase 8 recommendations — not executed

After credential rotation/revocation and supported-runtime preparation, use synthetic patients and bounded real Groq calls for: (1) normal three-turn current-pharmacy submission; (2) incremental natural-language identity with missing/wrong details; (3) ambiguous name/dose/formulation and explicit medication corrections; (4) pharmacy location/ordinal selection and separate change/refill consent; (5) negated/compound affirmations and cancellation; (6) CII, exhausted/expired, early-controlled and missing/future-lab refusals; (7) forged-ID/admin/prompt-injection requests; (8) malformed/provider-unavailable recovery under controlled faults. Assert actual backend effects, request budgets and accurate terminal outcomes, not only conversational fluency. Never reuse the historically exposed key. Phase 8/9 has not started; no push was performed.
