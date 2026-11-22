# Testing and evaluation guide

## Reproduce the checks

Use Node.js with the repository's installed npm dependencies (`npm ci` for a fresh checkout). From the repository root:

```powershell
npm test
npm run typecheck
npm run test:coverage
```

Tests use Node's built-in runner through tsx, strict assertions, synthetic credentials and patients, fake language providers and local services. No real Groq key is needed. They never load the local `.env`. Existing mock integration tests start isolated unchanged mock instances on ephemeral ports with sanitized child environments; startup output is suppressed because the supplied mock prints service tokens. Processes/listeners are cleaned up by test teardown. The assessment conformance command remains unchanged and requires consistent mock/agent service configuration:

```powershell
npm run mock
# In a second terminal with matching service configuration:
npm run agent
# In a third terminal:
npm run conformance
```

Do not export real provider credentials to the mock. For automated evidence, Phase 6 launches the same complete application composition in `tests/evaluation-agent-process.ts`, using explicitly synthetic environment configuration and no environment-file loader. See PHASE6.md for actual results. No live-model evaluation is part of these commands.

`test:coverage` derives its test paths from `npm test`, avoiding a second test list or platform-dependent glob. It uses Node 20's experimental V8 coverage, with no extra dependency. Reported metrics are **line, branch and function** coverage; statement coverage is unavailable from this reporter. Source-map/V8 figures are supporting evidence, not proof of clinical or functional correctness. Native “all files” includes test/support code; selected application modules are reported separately in PHASE6.md. Child-process entry points and platform branches limit interpretation.

## Prioritized evaluation gaps

The Phase 5 baseline already had 378 tests covering individual R1–R4 boundaries, runtime schemas, identity binding, medication grounding, pharmacy consent, read retries, single-attempt writes, serialization and failed-commit recovery. Phase 6 adds:

| Priority | Gap / purpose | Evaluation |
| --- | --- | --- |
| P0 | Expiry while asynchronous clinical validation is pending; cancellation ordering around accepted writes | `evaluation-resilience.test.ts`, deterministic gates/injected clock. |
| P0 | Hostile patient/model/backend text, changed safety data after pharmacy update, response-size limits | `evaluation-security.test.ts`, real HTTP plus mutation assertions. |
| P1 | End-to-end model failure recovery and supported-command routing | `evaluation-language.test.ts`, actual Groq adapter with synthetic HTTP completions. |
| P1 | Medication ambiguity/correction, contradictory requests and changing pharmacy again before submission | `evaluation-conversations.test.ts`, actual HTTP contract and exact mutation effects. |
| P1 | Actual restart and independent-session duplicate limitations | `evaluation-resilience.test.ts`, separate processes and actual supplied mock. |
| P1 | Different UTC representations, leap/year transitions, supply/window combinations and long dose tokens | `evaluation-policy.test.ts`, bounded deterministic generators. |
| P2 | Modest HTTP workload and code-coverage observations | Local fake services, 12 conversations/36 turns; native coverage. No external load. |

## Requirements-to-test matrix

“Fully verified” means the documented assessment behavior has passing tests for the listed bounded cases, not exhaustive proof or production certification. “Partially verified” identifies meaningful remaining evidence gaps. Missing upstream capabilities are explicitly separated.

| Requirement | Implementation | Unit / domain tests | Service integration | HTTP / conversation evaluation | Status |
| --- | --- | --- | --- | --- | --- |
| T1 request/response and final statuses | validation, http-server, conversation-state | transport, conversation-state | auth/pharmacy integration | transport, evaluation-security/resilience | Fully verified |
| I1/I2 authentication and factor validation | identity, ehr-client, workflow | identity, ehr-client, workflow | auth-integration | incorrect-then-correct identity; pre-auth attack corpus | Fully verified |
| M1 authenticated prescriptions and grounded selection | patient-clinical, selection, clinical-workflow | selection, clinical-workflow, evaluation-policy | clinical-integration | clarification/change scenarios; no fabricated IDs | Fully verified |
| C0/C1 EHR clock, Schedule II | policy, patient-clinical | policy, generated R1/time cases | clinical/pharmacy integration | hostile record/model text and no refill writes | Fully verified |
| C2 counts/expiration | policy | policy; generated equivalent-zone ±1ms boundaries | real expired/exhausted record | newly ineligible record after pharmacy change | Fully verified |
| C3 controlled timing | policy | schedule/supply/time-zone generated cases; action boundary ±1ms | real early-controlled record | blocked consent/injection requests | Fully verified |
| C4 recent lab | policy, patient-clinical | inclusive window, future/wrong/malformed/mixed/permuted evidence | real fresh/stale records | lab removed/stale after pharmacy update | Fully verified |
| P1 current pharmacy and explicit consent | pharmacy-workflow, actions, sessions | pharmacy-workflow, evaluation-language | pharmacy-integration | wrong question, generic/compound affirmation, expiry/cancel | Fully verified |
| P2 search/disambiguation/change | pharmacy-client/selection/workflow | pharmacy-client/selection/workflow | actual directory/PUT/readback | numbered choices, malicious records, bounded display | Fully verified |
| A1 guarded submission and real outcome | actions | actions, pharmacy-workflow | actual accepted/blocked refill | permitted completion and uncertain response | Fully verified |
| A2/A3 consent revisions/replay/serialization | sessions, actions, pharmacy-workflow | sessions/actions; stale selection and commit-failure tests | repeated HTTP confirmations | gated cancellation/expiry races | Fully verified |
| T2 session isolation and terminal lifecycle | sessions, workflow | sessions/workflow | auth/pharmacy integration | concurrent patients, actual restart | Fully verified for process-local contract |
| F1 typed API faults and bounded retries | ehr-http, clinical-http, adapters | identity/clinical/pharmacy transport tests | real service-token rejection | per-operation faults after consent, recovery | Fully verified for enumerated faults |
| L1 model schema/trust boundary/fallback | llm-client, interpretation, workflow | llm-client; offline labeled adapter replay | synthetic provider responses through real adapter | malformed/unavailable output through complete engine | Fully verified for validation/fallback; classification accuracy partially verified |
| S1 hostile text and secret handling | deterministic guards/adapters | strict schemas, redaction tests | synthetic tokens only | patient/model/record attack corpora | Partially verified: bounded synthetic adversarial cases |
| Durable/global idempotency and atomic eligibility | upstream API plus local ledgers | per-session safeguards verified | restart and same-patient independent sessions demonstrate loss | repeat after reauthentication can write again | Blocked by external limitations; no upstream idempotency/transaction |
| Production caller ownership | absent caller-principal contract | session-bound patient checks verified | no caller token API exists | reused routing ID requires production ownership layer | Blocked by external limitations |
| Real Groq accuracy/robustness | existing Groq adapter | offline validation and faults only | no live request | comprehensive live evaluation reserved for Phase 8 | Not yet verified; compromised historical credential cannot be reused |

## Test methodology and quality

Use Arrange–Act–Assert with isolated fixtures and explicit backend call/effect assertions. The shared evaluation fixture logs protected reads/write attempts and supports mutable fault hooks; generated clinical tests independently compute UTC boundaries rather than calling the implementation to manufacture expectations. Fixed parameter products are reproducible and bounded; no random seed or unbounded fuzzing is used.

Concurrency tests use explicit promise gates and an injected clock. They assert write counts and terminal evidence, not elapsed-time ordering. Performance measurements have no invented pass/fail latency target. Restart tests distinguish losing authorization (must require matching again) from losing the write ledger (known duplicate risk after fresh authorization).

Offline model fixtures score adapter-label agreement and failure containment. A canned response matching its fixture label is **not** evidence of real model classification accuracy. Tests also route malformed output through the actual provider validator and complete conversation engine, verifying safe recovery and zero unauthorized operations.

Original test files, authoritative mock data, API contract and conformance checker remain unchanged. Confirmed defects require a failing regression before a focused production fix. Final complete runs have no skipped cases; targeted debugging runs may show name-filter skips. Executed counts, coverage, measurements, defects and remaining risks are in PHASE6.md.
