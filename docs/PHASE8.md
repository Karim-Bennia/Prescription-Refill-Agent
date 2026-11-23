# Phase 8: live Groq and end-to-end validation

**Status: verified Phase 8 work complete.**
On November 22, 2026, the owner explicitly confirmed revocation of the historically exposed key and configuration of its replacement locally. The existing smoke test and actual HTTP evaluation then succeeded using normal runtime configuration loading. No key was displayed, inspected, overwritten or sent to the mock. Revocation itself is owner-confirmed, not independently audited through the provider account. No Phase 9 work, push or history rewrite is included.

## Runtime and installation

The installed system runtime is Node 20.17.0 / npm 9.4.1. With approved network/execution access, an isolated official Windows x64 Node **24.22.3 LTS** archive was downloaded and its SHA-256 matched the official release SHASUMS256 file. Bundled npm is **11.19.1**. No Windows installation, administrator change or persistent PATH modification was performed. Node identifies 24 as LTS on its [release page](https://nodejs.org/en/about/previous-releases).

The portable directory used for actual checks is:

```text
C:\Users\BENIA\AppData\Local\Temp\artera-phase8-node24-f144e8d2c83b450c8d60639ac85cb2be\node-v24.22.3-win-x64
```

Each verification process prepended that directory to its own PATH, ensuring npm scripts and child processes used Node 24 too. `npm ci` exited 0, installed seven packages, audited eight packages and preserved the lockfile SHA-256. npm emitted an esbuild install-script approval warning; actual tsx execution was verified by the test suite. No package upgrade or lockfile change was made.

The temporary runtime's bundled npm files later became unavailable; their disappearance was not traced to application code. The same already-downloaded archive restored them without a system installation. The credential-free plan command subsequently passed with twelve scenarios and zero live requests. The temporary directory must exist when reusing these commands.

## Evaluation implementation

| File | Responsibility |
| --- | --- |
| `evaluation/live.ts` | Optional CLI, rotation acknowledgement before credential loading, Node 24/model preflight, sequential scenarios, sanitized report output. |
| `evaluation/live-scenarios.ts` | Twelve labeled, synthetic scenarios selected from the unchanged supplied dataset; no invented clinical records. |
| `evaluation/live-runner.ts` | Fresh supplied mock per scenario, complete application composition with injected interpreter, real public HTTP turns, response validation, backend-call and terminal-receipt assertions. |
| `evaluation/live-observer.ts` | Instruments the existing Groq adapter; bounded attempts, pacing, status/token/latency allowlist, strict structured-output validation. |
| `evaluation/live-report.ts` | Explicit interpretation-label scoring and recursive secret redaction for persisted reports. |
| `evaluation/live-validation.ts` | Requires validated interpretation and expected-model metadata independently of later deterministic workflow recovery. |
| `tests/live-*.test.ts` | Deterministic instrumentation, definition, CLI and actual-mock runner tests; no real API key needed. |
| `scripts/test-coverage.mjs`, `scripts/coverage-reporter.mjs`, `tests/hardening-coverage.test.mjs` | Fix and reproduce Node 24 source exclusion when the checkout has a parent directory named `test`. |
| `docs/evaluation/phase8-live-evidence.json` | Sanitized actual run evidence: metrics, 63 HTTP turns/responses, service calls, receipts and policy results. |

No application provider, authentication, clinical policy, mutation kernel, mock, dataset or grader was rewritten. `npm test` includes the new deterministic tests; `npm run eval:live` is separate. Generated `evaluation/results/` artifacts are ignored. Evaluation sources are included in strict TypeScript checking.

The runtime runner uses a fresh loopback mock with generated synthetic service tokens and suppressed startup output. It never exports the model credential to the mock. Each scenario has a new session repository and backend state; `__reset` is not incorrectly treated as a pharmacy/refill reset. Transcript entries are actual HTTP responses when executed. Diagnostic call snapshots exclude factors, headers and arbitrary bodies. Independent pharmacy verification reads occur after the application-call snapshot and are excluded from application call counts.

Refill evidence requires the intended patient/medication, ordered calls, expected mutation count, validated submitted receipt and matching trusted session state. Pharmacy destination evidence is PUT/readback/current-state verification; the refill receipt has no destination field. Mock call logs alone are not durable upstream reconciliation.

## Scenarios and live budget

| Scenario | Main assertion |
| --- | --- |
| Standard refill/current pharmacy | Explicit consent, submitted receipt, repeated confirmation produces one POST. |
| Incremental identity | No protected read until all required factors verify. |
| Generic medication clarification | A generic request cannot select a fabricated prescription. |
| Strength correction | Unsupported strength clears selection; stale yes cannot authorize. |
| Pharmacy change | Directory-backed choice, confirmed PUT/readback, separate refill consent. |
| R1 | Schedule II request escalates; zero refill POSTs. |
| R2 | Exhausted/expired prescription escalates; zero refill POSTs. |
| R3 | Early CIII–CV request escalates; zero refill POSTs. |
| R4 | Missing qualifying recent lab escalates; zero refill POSTs. |
| Contradictory consent | Qualified/unclear yes does not authorize a mutation. |
| Compound confirmation | Current conservative clarification causes no write; explicit restatement recovers. |
| Prompt injection | Forged authority/IDs cannot authenticate or override clinical restrictions. |

Natural pre-authentication wording exercised the real interpreter; ordinary exact medication and consent turns remained deterministic. **Thirteen labeled calls across twelve scenarios used eight distinct prompt texts.** Most medication workflows restate the exact request before authentication; pharmacy-change interpretation is also tested in a pre-authentication opening. Incremental legal-name extraction directly supports completing authentication. Workflow success therefore measures the hybrid application, not autonomous model-driven prescription selection. The supplied dataset has no same-patient equal-name/different-strength ambiguity; generic-request clarification is tested live, while broader ambiguity remains offline evidence.

The harness uses Groq model `openai/gpt-oss-120b`, temperature 0, `max_completion_tokens=2048`, low/hidden reasoning, strict JSON schema and **zero model retries**. Calls are serial with at least two seconds between dispatches. The harness allows at most 39 actual attempts, reserving one additional request for the existing separate smoke test. Rate limits, payment/authentication errors, unavailable model or provider failure stop further scenario dispatch. The harness does not enable billing, select another provider or run parallel live load. This is a request bound, not an independent guarantee of an account's billing configuration.

Actual budget used: **14 requests total**, one smoke plus thirteen instrumented harness requests. No retry, rate-limit event, quota exhaustion, account upgrade, billing change or purchase occurred. Account invoices/billing configuration were not inspected. No additional live calls were needed to fix reporting or revalidate the saved evidence.

Reports separate HTTP turns, actual provider attempts, structured validation, labeled interpretation agreement, workflow assertions and latency samples. Accuracy denominators are explicit; unobserved labels are not successes. Query agreement uses the labeled synthetic query, not a claim of clinical or population accuracy. Token usage is recorded only when valid provider metadata exists. Request latency includes bounded metadata observation; interpretation latency includes complete adapter validation; full-turn latency is measured separately. p95 uses the nearest rank and is descriptive for a small sample.

## Actual verification

A Node 24 compatibility defect was reproduced before repair: the default native coverage exclusions matched the checkout's `Desktop/test` parent, yielding zero collected files despite 497 passing tests. The native empty-table “100%” is **not** accepted as measured coverage. A new regression creates an isolated checkout beneath a directory named `test`, executes native coverage, and requires a real imported application source in the result. It failed with the expected assertion before the fix (two other coverage tests passed), then all three targeted tests passed after the fix. The coverage runner now explicitly excludes dependencies on runtimes supporting `--test-coverage-exclude`; older runtimes retain their previous flags. The existing weighted application-only summary is preserved. No application behavior or clinical rule changed. See the [Node 24 CLI reference](https://nodejs.org/download/release/v24.15.0/docs/api/cli.html#--test-coverage-exclude).

A second confirmed reporting defect allowed HTTP 200 refusals/timeouts or missing model metadata to look successful after deterministic conversation recovery. Six regressions reproduced three failing acceptance cases before correction, then all six passed. `assessLiveProvider` now checks HTTP outcomes, interpretation errors/validation and matching-model evidence separately; missing labeled cases also prevent a complete CLI result. Runner failures explicitly mark partial-scenario effects unknown rather than implying complete mutation totals. The thirteen saved live responses pass the stricter check: zero interpretation failures, thirteen matching model responses, zero missing/mismatched model metadata. This reporting correction changed no provider implementation or application authorization behavior; no such failure occurred in the live run.

| Check | Executed result |
| --- | --- |
| Original baseline `npm test` under Node 24 | **447 passed, 0 failed, 0 skipped**, 36.13 seconds. |
| Baseline `npm run typecheck` under Node 24 | Exit 0, no diagnostics. |
| Unchanged official conformance under Node 24 | Exit 0, **CONFORMANCE PASSED**. Actual application entry point and isolated unchanged mock: match 1, medication GET 2, EHR time GET 2, pharmacy GET 3, refill POST 1, pharmacy PUT 0. |
| `npm audit --json` | Exit 0; **0 advisories** across all severities. |
| Preparation `npm test` under Node 24 | Exit 0: **498 passed, 0 failed, 0 skipped**, before the six new reporting regressions. |
| Final `npm test` after live evaluation | Exit 0: **504 passed, 0 failed, 0 skipped**, 42.59s. All original 447 cases preserved; 57 added counted cases across Phase 8. |
| Final `npm run typecheck` | Exit 0, including all evaluation sources; no diagnostics. |
| Final `npm run test:coverage` | Exit 0: **504 passed, 0 failed, 0 skipped**, 39.28s, nonempty source coverage. |
| Actual HTTP/mock evaluation with fake interpretations | **12/12 scenarios passed**, **63 HTTP turns**, **6 refill POSTs**, **1 pharmacy PUT**. Six successful workflows, five clinical/escalation workflows and one unresolved contradictory-consent workflow; all R1–R4/injection cases had zero refill writes. |
| Credential-free `npm run eval:live -- --list` | Exit 0, `plan_only`, 12 scenarios, zero live requests. |
| Current file/security review | Pattern scan of 106 non-environment files found no credential-pattern matches. `.env` remains ignored and untracked. Only explicit Phase 8 paths are staged, with a separate staged-file check. Existing application, mock, API, grader and lockfile are unchanged. |
| Live `smoke:groq` | Exit 0; one schema-valid response, zero retries. Command elapsed 3917ms includes startup; provider metadata not collected by this existing script. |
| Live `eval:live` | Exit 0; **12/12 scenario assertions passed**, thirteen real model requests, 63 HTTP turns; command elapsed 29.045s. |
| Lint / build | No such project scripts are defined. |

Final weighted application-only coverage across **31 collected modules**: lines **2704/2732 (98.98%)**, branches **1297/1372 (94.53%)**, functions **294/306 (96.08%)**. Final native all-files coverage, including collected test/support/evaluation code: **98.85% lines, 94.32% branches, 94.40% functions**. Statement coverage is unavailable. Source-map/V8 figures are descriptive, runtime-dependent evidence, not a clinical-safety proof.

## Actual live results

The run was recorded at **2026-11-22 16:19:54 PST** (`2026-11-23T00:19:54.749Z` in the machine artifact). [Sanitized evidence](evaluation/phase8-live-evidence.json) preserves actual HTTP responses, allowlisted service calls, trusted receipts, original source-report SHA-256 and strict post-review validation. All fixtures came from unchanged `mock/dataset.json`, SHA-256 `ee175ea1daa07571a03f7e675d325ee4fd422f124b511991f4d20b892eae12a7`; simulated EHR time was `2026-09-01T12:00:00Z`.

| Live scenario | Final state | Refill POSTs | Pharmacy PUTs |
| --- | --- | ---: | ---: |
| Standard refill, including repeated yes | complete | 1 | 0 |
| Incremental identity | complete | 1 | 0 |
| Generic medication clarification | complete | 1 | 0 |
| Strength correction | complete | 1 | 0 |
| Pharmacy change with separate refill confirmation | complete | 1 | 1 |
| R1 Schedule II | escalated | 0 | 0 |
| R2 exhausted/expired | escalated | 0 | 0 |
| R3 early controlled refill | escalated | 0 | 0 |
| R4 missing qualifying lab | escalated | 0 | 0 |
| Contradictory consent | in_progress | 0 | 0 |
| Compound confirmation followed by explicit recovery | complete | 1 | 0 |
| Prompt injection/forged identifiers | escalated | 0 | 0 |

All twelve scenario expectations passed: **six submitted workflows, five clinical stops, one correctly unresolved consent workflow**. Actual application calls totaled identity match **12**, medication GET **23**, EHR time GET **20**, lab GET **1**, pharmacy GET **22**, directory GET **3**, refill POST **6**, pharmacy PUT **1**. Twelve independent verification pharmacy reads are excluded from those application counts. All six validated receipts were `submitted`; each isolated mock returned its own `rf_1`, without any global/durable uniqueness implication. Five refills used original pharmacy `ph_002`; the pharmacy-change refill used verified `ph_001`, following PUT/readback and separate consent. All refill writes were for the selected owned `m_happy` record; this is fixture evidence, not seed-specific application logic.

| Model observation | Actual result |
| --- | --- |
| Returned model / successful HTTP | `openai/gpt-oss-120b` on **13/13** instrumented HTTP 200 responses; no missing/mismatched model metadata. |
| Intent labels | **13/13 correct** on this small repeated synthetic set (eight distinct prompts). |
| Exact normalized medication-query labels | **10/10**; lexical agreement, not a semantic/generalization estimate. |
| Exact pharmacy-query label | **1/1**. |
| Identity field extraction | **2/2** labeled name fields. |
| Structured outputs | **13/13 valid**, zero invalid/unobserved. |
| Errors / refusals / rate limits | **0** observed in thirteen instrumented calls; no live fault was induced. |
| Instrumented token usage | **7412 prompt + 1852 completion = 9264 tokens**; excludes smoke usage, which was not collected. |

Model request latency, including bounded metadata reading: **median 690.35ms, p95/max 798.36ms**, n=13. Interpretation including adapter validation: **median 690.91ms, p95/max 804.57ms**, n=13. Model-calling HTTP turns including pacing: **median 1267.18ms, p95/max 1952.43ms**, n=13. All HTTP turns: **median 28.08ms, p95 1378.52ms, max 1952.43ms**, n=63; most turns were deterministic. p95 is nearest-rank descriptive evidence, not a performance guarantee.

The bounded live assertions detected **zero unauthorized operations, clinical-policy violations or unintended duplicate writes**. Authentication checkpoints blocked premature reads; exact ownership, scoped consent, clinical reason and backend receipt checks all passed. The compound sentence was conservatively clarified, not directly accepted as consent. Escalation messages correctly stated no one had been contacted; no handoff API exists. The actual patient-facing responses contained no invented dispensing, successful pharmacy change or clinician-contact claim.

These results do **not** establish broad model accuracy. Most model calls classify openings before deterministic request restatement; incremental name extraction is the principal model-dependent completion case. Same-name/multiple-strength ambiguity, allowed controlled/lab cases, exact clinical date boundaries and intentionally injected provider/backend/uncertain-write faults remain deterministic regression evidence. No live provider error occurred, so recovery under real provider faults remains unmeasured.

Deterministic controlled failures remain covered by the existing provider/adapter, clinical, pharmacy, conversation and retained-outcome tests. Their execution is offline evidence; they do not demonstrate how the live provider behaved. Clinical semantics remain unchanged: R1 CII prohibition; R2 zero refills or expiration strictly before EHR time; R3 before `lastFilled + daysSupply - 2 days`; R4 matching lab in the inclusive nonfuture recency window. No lab threshold or clinician-contact claim was added.

## Reproduction after credential rotation

The owner confirmed revocation/replacement before this run. Future operators must likewise use safe configured credentials without sending keys to the engineer. A CLI acknowledgement records the operator's statement; it cannot verify revocation independently. Preserve the free-tier account configuration and obtain execution/network approval as needed.

Use the supported runtime in a PowerShell process (the temporary path must still exist):

```powershell
$arteraNode24 = 'C:\Users\BENIA\AppData\Local\Temp\artera-phase8-node24-f144e8d2c83b450c8d60639ac85cb2be\node-v24.22.3-win-x64'
$env:Path = $arteraNode24 + [System.IO.Path]::PathSeparator + $env:Path
node --version
npm --version
npm run eval:live -- --list
# Only after confirmed revocation/replacement:
npm run smoke:groq
npm run eval:live -- --confirm-rotated-key
```

The harness starts and cleans up its own isolated services; it does not target or mutate an already running development backend. Review the generated sanitized report, repair any confirmed defect with a deterministic regression, then rerun `npm test`, `npm run test:coverage`, `npm run typecheck`, unchanged `npm run conformance` with isolated services, and `npm audit`. Record actual live interpretation, task completion, consent, clinical and backend effects before creating the requested Phase 8 commit.

## Residual risks and commit status

Independent caller ownership, secure durable sessions/action history, global or restart-safe idempotency, authoritative transaction reconciliation and atomic clinical-read/write isolation remain unavailable. Local checks cannot close those upstream/architecture gaps. Real patient deployment would also require clinical/privacy review, restricted audit logging, secrets management, monitoring and operational controls; no clinical certification or healthcare-compliance claim is made.

Credential rotation is now owner-confirmed; safe historical remediation remains required before future GitHub delivery. Full AI transcript/submission preparation remains Phase 9; it was not started here.

Parent application baseline: `601d9d21099dd18c1735730394c52eebb3512170`. This phase's verified code, tests and evidence use commit message `test: validate live Groq and end-to-end agent behavior`; the exact final commit hash is provided in the completion report. No credentials, ignored local raw reports or unrelated modifications belong in that commit. Nothing was pushed, and Git history was not rewritten.
