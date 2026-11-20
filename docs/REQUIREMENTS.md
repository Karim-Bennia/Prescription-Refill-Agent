# Requirements and verification plan

Authority: `docs/API.md`, then the supplied `conformance/run.ts` grading contract and README submission instructions. This is analysis only; all proposed tests below remain unimplemented. No hidden grading contract was supplied.

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

Paths refer to proposed modules under agent/ and proposed tests under tests/, unless marked existing. Requirements marked design are decisions filling gaps, not extra grader mandates.

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
| F1 design | Bounded read/model timeouts and retries, schema rejection, neutral errors, no fabricated success | errors.ts, adapters | failures.test.ts: 401/404/429/5xx, network, malformed response, model failure |
| L1 user | Groq configured through GROQ_API_KEY and LLM_MODEL; model extracts proposals only, never authorizes or selects identity | llm-client.ts, workflow.ts | llm.test.ts: injection, invented IDs, invalid structured output, timeout |
| S1 user | No credential exposure; minimize demographics in logs/model requests; no seed-specific behavior | config.ts, logging.ts | security.test.ts: redaction, cross-session attacks, alternate dataset |
| G1 conformance | Three scripted turns end complete; match, medications, refill calls exist; refill after match and same patient as medication lookup; medId present | workflow.ts | existing conformance/run.ts unchanged, plus stricter ordering assertions |
| D1 README | One documented agent start command; env-only config; commercially available model provider/ID/version and settings in SUBMISSION | config.ts, SUBMISSION.md | startup smoke test with injected config; manual documentation review |
| D2 README | Own safety tests, full secret-redacted AI transcripts in docs/ai-log/, incremental Git history, final private-repo push | tests/, submission artifacts | test runner plus manual delivery review; push belongs to later delivery phase |

## Decisions and unresolved specification details

R3 requires decline but does not expressly mandate escalation; choose terminal escalation with prescriber guidance for a blocked request. R4 permits advice/escalation; choose escalation. No handoff endpoint exists: do not claim a clinician was contacted. Only pharmacy PUT and refill POST are required external mutations; no prescription creation, lab order, pharmacy dispensing, or notification API exists.

Use UTC date arithmetic, a day = 86,400,000 ms, inclusive lab window `[now-withinDays, now]`, and literal expiration `< now`. Date-only values will be interpreted as UTC midnight; expiration-day semantics are unspecified and need explicit boundary tests/documentation. Do not invent a lab-value threshold. Future labs cannot establish recency. Inconsistent controlled flags/schedules require review rather than permissive interpretation.

Malformed input HTTP status policy is unspecified: propose 400, 413 for size limit, 404/405 for unsupported route/method and sanitized 503 for unavailable dependencies. Valid recoverable conversational problems remain in_progress; safety/human-review stops are escalated. No upstream error implies permission to act.

Authentication factor strength and failure limit are application decisions; proposed maximum five unsuccessful matching attempts per session. Demographic matching is assessment authentication, not production identity proof. Cross-process/restart durability, global patient-level deduplication, real handoff, and server-supported idempotency are unavailable and must be disclosed.

## Repository inspection and baseline

Inspected all tracked source/configuration/documentation, both seed datasets and conformance script; environment files deliberately excluded. Starter uses dependency-free Node HTTP, strict TypeScript, Map placeholder state and tsx. No unit tests or test/build/typecheck scripts exist. Mock prefers DATASET_PATH, then dataset.json, then data.dev.ts; these datasets differ. It permits clinically unsafe refills and duplicates. Its reset clears only call logs, not pharmacy mutations/refill counter. Mock startup prints service tokens; avoid exporting real credentials to it or capturing startup logs. Agent does not load .env automatically. .gitignore does not ignore .env; the existing untracked file must never be staged.

Actual checks: npm ls --depth=0 failed with all three development dependencies missing. npm exec --no -- tsc --noEmit failed ENOTCACHED (compiler unavailable). npm run conformance failed because tsx was unavailable. Requested npm ci --ignore-scripts escalation was rejected by the user; no dependencies installed. No passing checks or behavior tests are claimed. Runtime baseline remains unverified; even with dependencies the placeholder cannot satisfy refill conformance.
