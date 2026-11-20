# Requirements and verification plan

Authority: `docs/API.md`, then the supplied `conformance/run.ts` grading contract and README submission instructions. Phase 2 implements configuration and the language-provider boundary; remaining workflow tests below are still planned. No hidden grading contract was supplied.

## Exact transport and identity contract

`POST /conversations/{conversationId}/messages` accepts `{ "from": "patient", "text": "<patient message>" }` and returns `{ "messages": [{ "from": "agent", "text": "<reply>" }], "state": "in_progress" | "complete" | "escalated" }`. Preserve state by conversationId across turns. `in_progress` expects more input; `complete` means resolved; `escalated` means human/pharmacist handoff and stopping. `GET /healthz` returns 200 when ready. No user token, request identifier, session creation endpoint, or idempotency key is specified. A conversation ID is a routing key, not proof of patient identity.

## Service contracts

Every EHR call uses the configured EHR bearer token; directory calls use the pharmacy bearer token. These authenticate services, never patients.

| Endpoint | Request / response |
| --- | --- |
| GET /ehr/time | `{now: ISO8601}`; sole clinical clock |
| POST /ehr/patients:match | `{factors:{firstName?,lastName?,dob?,phoneLast4?,zip?}}` -> `{count:integer,patientId:string|null}`; ID only for count 1 |
| GET /ehr/patients/{patientId} | `{patientId,firstName,lastName,dob,phone,zip}` |
| GET /ehr/patients/{patientId}/medications | Medication[] |
| GET /ehr/patients/{patientId}/labs?type=<t> | `{type,value,takenDate}[]` |
| GET /ehr/patients/{patientId}/pharmacy | `{pharmacyId,name}` or null |
| PUT /ehr/patients/{patientId}/pharmacy | `{pharmacyId}` -> `{ok:true}` |
| POST /ehr/patients/{patientId}/refills | `{medId}` -> `{refillId,status:"submitted"}` |
| GET /pharmacy/directory?q=<search> | `{pharmacyId,name,address}[]` |

Medication has `medId`, `name`, `isControlled:boolean`, `schedule:CII|CIII|CIV|CV|null`, `lastFilledDate`, `daysSupply:integer`, `refillsRemaining:integer`, `rxExpirationDate`, and `requiresRecentLab:{type,withinDays:integer}|null`. IDs and dates are strings. Validate all responses at runtime.

## Traceability matrix

Paths refer to modules under agent/ and tests under tests/. Unless explicitly marked implemented below, modules/tests remain proposed. Requirements marked design are decisions filling gaps, not extra grader mandates.

| ID / source | Requirement | Module | Automated verification planned |
| --- | --- | --- | --- |
| T1 API §1 | Exact route, request/reply literals and ready health | server.ts, validation.ts | transport.test.ts: valid, malformed JSON, wrong sender/type, oversized input, route/method |
| T2 API §1 | Retain isolated state by conversation ID; terminal states stop | sessions.ts, workflow.ts | sessions.test.ts: interleaved IDs, terminal replay, concurrent turns |
| I1 API §2 | Match before any patient data/action; use returned unique ID only | identity.ts | identity.test.ts: missing factors, zero/multiple/unique matches, forged IDs |
| I2 design | Require first name, last name, DOB and phoneLast4 or ZIP; ask neutrally for missing/disambiguating factors; bounded failures | identity.ts | identity.test.ts: insufficient unique match, ambiguous twins, corrections, attempt exhaustion |
| M1 README goals | Preserve initial medication request through authentication; select only owned medication; clarify absent/ambiguous names and strengths | selection.ts, workflow.ts | selection.test.ts: unknown, multiple, look-alikes, changed request, foreign medId |
| C0 API §2 | All date logic uses EHR time | policy.ts, ehr-client.ts | policy.test.ts: host clock independence, unavailable/invalid clock |
| C1 API R1 | schedule CII: decline and escalate to prescriber, no refill | policy.ts | policy.test.ts: CII even with remaining refills |
| C2 API R2 | zero refills OR expiration past now: decline and escalate for new prescription | policy.ts | policy.test.ts: each condition independently, both, expiration equality |
| C3 API R3 | CIII–CV: decline when now < lastFilledDate + daysSupply - 2 days | policy.ts | policy.test.ts: each schedule, just before/exactly/after boundary, noncontrolled control |
| C4 API R4 | required matching lab exists within withinDays; otherwise hold and advise/escalate | policy.ts | policy.test.ts: missing/stale/wrong type, exact boundary, fresh among stale, future/invalid dates |
| C5 design | Fail closed on invalid/inconsistent clinical data; evaluate all rules, retain reasons; no dose advice | validation.ts, policy.ts | policy.test.ts: negative values, invalid dates, inconsistent schedule, overlapping failures |
| P1 README goals | Read and explicitly confirm current pharmacy; null requires selection | actions.ts, workflow.ts | workflow.test.ts: keep, decline, missing pharmacy |
| P2 README goals | Search directory; disambiguate branch/address; confirm selected change before PUT | pharmacy-client.ts, selection.ts, actions.ts | pharmacy.test.ts: empty/multiple results, correction, cancellation, no write before confirmation |
| A1 API §2 | After identity, ownership, eligibility and pharmacy confirmation POST refill; complete only on validated submitted receipt | actions.ts | workflow.test.ts: ordered API calls, exact patient/med IDs, failed submission never complete |
| A2 design | Changed pharmacy PUT must succeed before refill; recheck eligibility before action; confirmation binds patient/med/pharmacy | actions.ts | actions.test.ts: PUT failure, stale confirmation, clinical recheck failure |
| A3 design | Serialize per conversation, record pending/success/unknown action; never blindly retry uncertain writes | sessions.ts, actions.ts | actions.test.ts: double yes, concurrency, timeout after write, repeated terminal turn |
| F1 design | Bounded read/model timeouts and retries, schema rejection, neutral errors, no fabricated success | errors.ts, adapters | Phase 2 implemented: llm-client.test.ts covers model timeout including body reads, 401/403/404/429/5xx, network errors, retry bounds, malformed output and sanitized errors. Backend failure tests remain planned. |
| L1 user | Groq configured through GROQ_API_KEY and LLM_MODEL; model extracts proposals only, never authorizes or selects identity | llm-client.ts, intent.ts, interpretation.ts, runtime.ts | Phase 2 implemented: llm-client.test.ts rejects invented IDs/authority/write fields, invalid structured output, refusal and truncation; fake provider injection/revalidation in llm-client.test.ts and runtime.test.ts. Workflow remains planned. |
| S1 user | No credential exposure; minimize demographics in logs/model requests; no seed-specific behavior | config.ts, logging.ts | Phase 2 implemented: config.test.ts and llm-client.test.ts assert error redaction, no credential in model input and no retained raw exception cause; local-env.test.ts uses only synthetic temporary data. Cross-session/alternate-dataset tests remain planned. |
| CFG1 Phase 2 user | Fail-fast environment-only configuration; reject missing keys, invalid model/origins/ports/timeout/retry bounds; preserve caller env | config.ts, local-env.ts, start.ts | Implemented: config.test.ts validates defaults, boundaries, placeholders and sanitized errors; local-env.test.ts checks optional file loading, caller precedence and file preservation. |
| G1 conformance | Three scripted turns end complete; match, medications, refill calls exist; refill after match and same patient as medication lookup; medId present | workflow.ts | existing conformance/run.ts unchanged, plus stricter ordering assertions |
| D1 README | One documented agent start command; env-only config; commercially available model provider/ID/version and settings in SUBMISSION | config.ts, SUBMISSION.md | startup smoke test with injected config; manual documentation review |
| D2 README | Own safety tests, full secret-redacted AI transcripts in docs/ai-log/, incremental Git history, final private-repo push | tests/, submission artifacts | test runner plus manual delivery review; push belongs to later delivery phase |

## Decisions and unresolved specification details

R3 requires decline but does not expressly mandate escalation; choose terminal escalation with prescriber guidance for a blocked request. R4 permits advice/escalation; choose escalation. No handoff endpoint exists: do not claim a clinician was contacted. Only pharmacy PUT and refill POST are required external mutations; no prescription creation, lab order, pharmacy dispensing, or notification API exists.

Use UTC date arithmetic, a day = 86,400,000 ms, inclusive lab window `[now-withinDays, now]`, and literal expiration `< now`. Date-only values will be interpreted as UTC midnight; expiration-day semantics are unspecified and need explicit boundary tests/documentation. Do not invent a lab-value threshold. Future labs cannot establish recency. Inconsistent controlled flags/schedules require review rather than permissive interpretation.

Malformed input HTTP status policy is unspecified: propose 400, 413 for size limit, 404/405 for unsupported route/method and sanitized 503 for unavailable dependencies. Valid recoverable conversational problems remain in_progress; safety/human-review stops are escalated. No upstream error implies permission to act.

Authentication factor strength and failure limit are application decisions; proposed maximum five unsuccessful matching attempts per session. Demographic matching is assessment authentication, not production identity proof. Cross-process/restart durability, global patient-level deduplication, real handoff, and server-supported idempotency are unavailable and must be disclosed.

## Repository inspection and baseline

Inspected all tracked source/configuration/documentation, both seed datasets and conformance script; environment file contents deliberately excluded. Starter uses dependency-free Node HTTP, strict TypeScript, Map placeholder state and tsx. No unit tests or test/build/typecheck scripts exist. Mock prefers DATASET_PATH, then dataset.json, then data.dev.ts; these datasets differ. It permits clinically unsafe refills and duplicates. Its reset clears only call logs, not pharmacy mutations/refill counter. Mock startup prints service tokens; avoid exporting real credentials to it or capturing startup logs. Agent does not load .env automatically. Git metadata now confirms that .env is already tracked in the starter commit and is not ignored; its contents were not read, modified or staged. This documentation-only phase does not change its existing tracking or history.

### Phase 1 environment verification, 2026-11-20

Continued from the earlier blocked setup without changing application code, fixtures, contracts, package scripts or the lockfile. Repository root is `C:\Users\BENIA\Desktop\test\refill-agent-karim-bennia`, branch `main`; the working tree was clean at starter commit `31117ca`. All three Phase 1 documents were already tracked there. This continuation preserves the documents and updates only this baseline record.

| Executed command / check | Actual result |
| --- | --- |
| `npm ci` with approved network/execution access | Exit 0; added 6 packages, audited 7 packages, found 0 vulnerabilities. No offline-only install was used. |
| `npm ls --depth=0` | Exit 0; `@types/node@22.20.1`, `tsx@4.23.13`, `typescript@5.9.3` installed. |
| `.\node_modules\.bin\tsc.cmd --version` | Exit 0; TypeScript 5.9.3. |
| `.\node_modules\.bin\tsx.cmd --version` | Exit 0; tsx 4.23.13, Node 20.17.0. |
| `.\node_modules\.bin\tsc.cmd --noEmit` | Exit 0, no diagnostics; uses the existing strict `tsconfig.json`. |
| `npm run` | Only `mock`, `agent` and `conformance` are defined; no typecheck or unit-test script exists. |
| `npm test` | Exit 1: `Missing script: "test"`. The sandbox also prevented npm's diagnostic-log write; an approved rerun outside the sandbox reproduced only the missing-script failure. No unit tests ran. |
| `npm run mock`, `npm run agent`, then `npm run conformance` | Both services returned HTTP 200 from `/healthz`. Unchanged conformance executed and exited 1 with the four failures below; mock recorded zero service calls. |
| `git diff --exit-code -- package.json package-lock.json agent/server.ts mock/server.ts conformance/run.ts` | Exit 0; checked starter files and lockfile unchanged. |

Exact conformance failures:

```text
expected final state "complete", got "in_progress"
agent never called POST /ehr/patients:match (identity verification)
agent never fetched the patient's medications
agent never submitted a refill (POST /ehr/patients/{id}/refills)
```

These failures are existing starter limitations: `handleTurn` always returns the placeholder and `in_progress`, without EHR calls. The successful typecheck does not establish clinical or authorization safety. All tests in the traceability matrix remain planned for a later phase; no functional changes or new tests were made here.

The isolated runtime used `PORT=14010`, `AGENT_PORT=15050`, `MOCK_BASE=EHR_BASE_URL=PHARMACY_BASE_URL=http://127.0.0.1:14010` and `AGENT_BASE=http://127.0.0.1:15050`. Child processes received only required Windows runtime environment variables plus this test configuration and explicitly synthetic service tokens. Existing .env credentials were never loaded or inherited by those children; mock startup output was suppressed. The first sandboxed launch failed with `spawn EPERM`; an approved execution outside the sandbox resolved that blocker. The cleanup helper reported failure for both owned launcher process trees; subsequent process and TCP-listener checks found neither launcher PID nor listening ports 14010/15050. No services were left listening on those test ports.

The prior missing-dependency/ENOTCACHED results and declined installation approval describe the earlier attempt, not the current environment. Dependency installation and runtime execution are now verified; the absent test script and four conformance failures remain documented baseline limitations for Phase 2. No claim of passing conformance, implemented safety tests, completed refill or handoff is made.

## Phase 2 verification

The Phase 1 baseline above is historical. Phase 2 adds `npm test` and `npm run typecheck`, implements the configuration/language tests marked above, and preserves the unchanged grader and clinical fixtures. Current results, environment configuration, security findings and remaining limitations are recorded in `docs/PHASE2.md`. All clinical, identity, consent, duplicate-write and end-to-end refill requirements remain for later phases.
