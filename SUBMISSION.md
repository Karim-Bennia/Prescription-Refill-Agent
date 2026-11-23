# Submission

## How to run

Use Node.js **24 LTS** and npm; the preserved evaluation used Node **24.22.3** / npm **11.19.1**.

```powershell
npm ci
npm run dev:services
```

The paired launcher starts the supplied mock on 4010 and the existing agent on 5050 with matching temporary synthetic service tokens. It keeps model credentials in the agent's normal local configuration and stops both owned processes on Ctrl+C.

For the complete browser application instead:

```powershell
npm run dev:all
```

Open **http://127.0.0.1:5173**. If the backend is already running, use `npm run dev:frontend`. The frontend is strict React/TypeScript built with esbuild and served by a loopback Node proxy.

## Running my agent

- **Exact standalone command:** `npm run agent` → `tsx agent/start.ts`.
- **Backend:** start `npm run mock` separately with matching synthetic EHR/pharmacy service configuration, or use the paired launcher above.
- **Required standalone environment variables:** `GROQ_API_KEY`, `EHR_API_KEY`, `PHARMACY_API_KEY`.
- **Optional/default variables:** `LLM_MODEL`, `EHR_BASE_URL`, `PHARMACY_BASE_URL`, `AGENT_PORT`, `REQUEST_TIMEOUT_MS`, `LLM_MAX_RETRIES`; defaults and bounds are in [README.md](README.md#configuration).
- **Configuration loading:** the agent optionally loads local `.env`; supplied variables take precedence. No file is required when configuration is supplied through the environment. [.env.example](.env.example) contains placeholders only.
- **Model provider and ID:** Groq, `openai/gpt-oss-120b`, OpenAI-compatible API at `https://api.groq.com/openai/v1`. No immutable provider deployment revision is pinned.
- **Generation:** temperature 0; `max_completion_tokens=2048`; low reasoning effort; hidden reasoning; nonstreaming strict JSON Schema. Routine model retries are bounded by configuration; live evaluation uses zero retries.

The mock prints its configured service tokens. Do not pass it real model credentials or load the agent's private environment into its terminal.

## Key design decisions

- **Identity:** first name, last name, valid DOB, and phone ending or ZIP; only a validated unique EHR match binds the patient. Repository-issued active contexts authorize protected reads.
- **Clinical policy:** pure deterministic R1–R4 evaluation uses authoritative EHR time, with explicit boundary/missing-data tests and fresh checks at submission. The LLM cannot authorize clinical actions.
- **Conversation:** discriminated-union state machine, serialized repository updates, replay protection, inactivity expiry, cancellation and terminal outcomes.
- **Prescription/pharmacy selection:** grounded in actual patient records and directory results; ambiguous or changed requests require clarification and invalidate stale consent.
- **Consent:** binds patient, prescription, pharmacy, saved question and revision. Pharmacy change and refill submission require separate confirmations.
- **Mutations:** a single guarded refill kernel and pending-action evidence; immutable submitted receipts; no blind POST/PUT retries after uncertain outcomes. Success means submitted, not dispensed.
- **Maintainability:** narrow adapters/interfaces, dependency injection, Zod at trust boundaries, native HTTP/fetch, isolated synthetic tests and focused React hooks/components.

## Verification and evidence

```powershell
npm test
npm run typecheck
npm run test:coverage
npm run build:frontend
npm run typecheck:frontend
npm run test:frontend
npm audit
# With correctly paired services running:
npm run conformance
```

Final Node 24 release checks passed **534/534 tests** in both ordinary and native-coverage runs, with zero failures or skips: the unchanged 504-case baseline plus 30 React/proxy/launcher tests. Backend/frontend TypeScript, React build, official conformance and npm audit passed (zero vulnerabilities). Application-only coverage: **99.09% lines, 94.60% branches, 96.08% functions**. See [README.md](README.md#tests-and-release-checks) for scope and denominators.

Three final real HTTP conversations through the frontend proxy covered successful refill/replay, a Schedule II refusal, and a confirmed pharmacy change followed by separate refill consent: 14 turns, two intended refill POSTs, one pharmacy PUT, zero blocked or duplicate writes. [Exact sanitized evidence](docs/evaluation/final-ui-evidence.json) records actual replies and calls. Owned-stack shutdown was verified.

The [recorded live evaluation](docs/evaluation/phase8-live-evidence.json) exercised twelve synthetic HTTP/mock scenarios with thirteen actual Groq calls: 13/13 labeled intents across eight distinct prompts, six intended refill POSTs and one pharmacy PUT, with zero observed unauthorized operations or clinical-policy violations. This small repeated sample does not establish general model accuracy. Routine tests require no real API key.

## Known limitations and further work

Caller ownership is not independently authenticated by the public API. Sessions/action history are process-local, so global or restart-safe deduplication is unavailable. Upstream services provide neither comprehensive idempotency/reconciliation nor atomic clinical-check-and-submit operations. No real clinician handoff exists. Real patient use would require stronger identity, durable secure state, backend transaction support, clinical/privacy review, audit controls, secrets management and operational monitoring.

The historically exposed model key was revoked/replaced according to the owner before live testing; provider-side revocation was not independently audited. Credential-safe delivery history must be verified before publishing the candidate-requested [Prescription-Refill-Agent repository](https://github.com/Karim-Bennia/Prescription-Refill-Agent).

## Notes to the reviewer

The authoritative supplied [API](docs/API.md), mock and conformance checker are preserved. The original assessment text is archived verbatim in [docs/ASSESSMENT.md](docs/ASSESSMENT.md). [README.md](README.md) consolidates architecture, configuration, safety decisions, traceability and evaluation; [docs/MANUAL_CHAT.md](docs/MANUAL_CHAT.md) provides synthetic demonstration steps.

**The candidate reports that Artera waived Codex transcript delivery.** Independent verification of the waiver was not performed; no transcript export is included on that basis.
