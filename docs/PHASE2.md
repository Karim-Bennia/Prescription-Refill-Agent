# Phase 2: secure configuration and Groq interpretation

Scope: configuration, structured language interpretation, reliability and automated tests only. The starter refill workflow remains unimplemented. No push or history rewrite was performed.

## 1. Secret-tracking audit and containment

Git metadata confirmed `.env` was tracked. A read-only, in-memory inspection of its historical blobs detected a Groq-format, non-placeholder credential in both existing commits:

- `31117cafa643c18c78a865015fc7d7096e9947e4`
- `47962936331ce3de3edf897df3d13254c3facb15`

No credential values were displayed or written to reports. Detection establishes exposure in history, not current provider validity, account access, revocation or misuse. The local environment file was not opened for inspection. Removing it from the index with `git rm --cached -- .env` preserved the local file byte-for-byte, verified with an in-memory hash comparison. `.gitignore` excludes `.env` and `.env.*`, except the placeholder-only `.env.example`.

**Push blocker:** the historical credential still exists in prior commits. Revoke it and install a replacement locally. Before any push, coordinate safe history remediation with the repository owner, use an isolated clone and review all affected refs. Do not rewrite shared history or force-push without explicit authorization. Untracking does not purge old commits or copies in other clones. Follow [GitHub's sensitive-data removal guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository). Rotation and history cleanup are not claimed complete.

## 2. Configuration and startup

Use `npm ci`, then `npm run agent` from the repository root. The entry point optionally loads the existing local `.env` with Node's built-in loader; caller-supplied environment values take precedence. A local file is not required when the caller supplies configuration. No file is created or overwritten by startup. Node 20.17.0 was used for verification; no dotenv dependency is needed.

| Variable | Requirement / default |
| --- | --- |
| `GROQ_API_KEY` | Required nonempty, non-placeholder secret; never logged. |
| `LLM_MODEL` | Default `openai/gpt-oss-120b`; requires provider/model syntax. Model availability is checked by the provider at request time. |
| `EHR_API_KEY`, `PHARMACY_API_KEY` | Required nonempty, non-placeholder service tokens. No hardcoded fallback credentials. Configure the isolated mock with matching synthetic values separately. |
| `EHR_BASE_URL` | Default `http://127.0.0.1:4010`. |
| `PHARMACY_BASE_URL` | Defaults to the configured EHR origin. |
| `AGENT_PORT` | Integer 1–65535; default 5050. Agent listens on loopback. |
| `REQUEST_TIMEOUT_MS` | Per-model-attempt deadline, including response reading; integer 100–60000, default 10000. |
| `LLM_MAX_RETRIES` | Additional safe model attempts; integer 0–3, default 2. |

Backend URLs must be origins without userinfo, paths, queries or fragments. Remote origins require HTTPS; HTTP is allowed for loopback development only. Configuration errors identify variable names without retaining their rejected values or raw Zod errors. Configuration is immutable and parsed through a pure function. Zod is the only added runtime dependency. npm regenerated the lockfile, pruning stale unreachable entries; reproducibility is checked with `npm ci`.

Do not copy real credentials into a shell that starts the mock: the provided mock prints its configured tokens. Verification launches it with an explicitly sanitized child environment and synthetic service tokens.

## 3. Provider interface, schema and trust boundary

`LanguageInterpreter.interpret(text)` returns a typed proposal: an allowlisted intent, explicitly supplied demographic factors, medication/pharmacy search text, and a clarification topic. Both schema object levels reject additional properties. No patient, prescription or pharmacy IDs, authorization flags, eligibility decisions, write instructions or success receipts are accepted. Schema validity is not proof that extracted facts are true.

`GroqLanguageInterpreter` adapts that interface to native fetch at the fixed `https://api.groq.com/openai/v1/chat/completions` endpoint. Redirects are rejected. It sends one bounded patient message without backend records, service credentials, prior transcripts or tools. The Groq key appears only in the authorization header. Settings are temperature 0, maximum 2048 completion tokens, low reasoning effort, hidden reasoning, nonstreaming, and strict JSON Schema output. There is no model fallback or model-selected tool execution. Groq documents this model's strict-schema support in [Structured Outputs](https://console.groq.com/docs/structured-outputs).

`runtime.ts` is the composition root and accepts a fake interpreter. `interpretation.ts` depends only on the interface/schema and generic errors; it revalidates provider proposals and maps clarification topics to fixed text. This lets the model assist natural-language interpretation and clarification selection without emitting clinical/action claims. No backend mutations are possible through this interface. The starter server validates configuration at startup but does not invoke the model on its placeholder route; a later phase must connect deterministic workflow logic.

## 4. Reliability and privacy

Each attempt has a deadline covering headers and body reading, aborts on timeout, and caps the body at 64 KiB. Malformed JSON, invalid schemas, truncated completions, refusals and unexpected tool output fail explicitly. There is no permissive parser fallback.

Only transient network/timeouts, HTTP 408, 429 and 5xx failures are retried. Attempts are bounded by configuration. Exponential equal jitter starts with a 250 ms ceiling and caps at 2000 ms. `Retry-After` seconds and dates are honored using an injectable clock; jitter is added after that minimum so simultaneous rate-limited clients do not all retry at the same instant. If the required delay exceeds 10 seconds, the typed error is returned instead of retrying too early. No hardcoded account quota is assumed; see [Groq rate limits](https://console.groq.com/docs/rate-limits).

Authentication/permission errors, unavailable models, other permanent HTTP failures and malformed successful responses are not retried. Error objects contain only a safe code, retryability, optional HTTP status and numeric retry delay. Raw provider bodies, prompts, original exception causes and credentials are discarded. No prompt, patient-data or credential logging is implemented. Empty/oversized input is rejected before a provider call. Health checks and runtime construction make no model requests. Retry logic applies to interpretation only, not prescription writes.

## 5. Executed verification and limitations

Executed on 2026-11-20 with Node 20.17.0, npm 9.4.1, TypeScript 5.9.3, tsx 4.23.13 and Zod 4.6.7:

| Command / check | Actual result |
| --- | --- |
| `npm ci` after updating the lockfile | Exit 0; added 7 packages, audited 8, zero vulnerabilities. |
| `npm test` | Exit 0; **93 passed, 0 failed, 0 skipped** (79 top-level tests plus nested cases). |
| `npm run typecheck` | Exit 0, no TypeScript diagnostics; includes application, starter, conformance and tests. |
| `git diff --check` | Exit 0; Git emitted only normal LF/CRLF conversion warnings. |
| Existing mock, grader and `docs/API.md` diff | Exit 0; unchanged. |
| Current index/worktree credential-pattern audit | Passed for 32 tracked/unignored files; private `.env` excluded. No high-confidence Groq/OpenAI key or private-key pattern found. This does not clear the historical exposure. |
| Isolated `npm run mock` + `npm run agent` | Both `/healthz` routes returned HTTP 200; owned processes stopped successfully. |
| Unchanged `npm run conformance` | Exit 1; same four starter failures below, zero recorded mock service calls. |
| Lint/build | No lint or build script is defined; neither was run. |

Tests use deterministic fake HTTP/provider implementations and synthetic fixtures; no real API key is required. An initial sandboxed test run failed to start its workers (`spawn EPERM`); approved execution outside the sandbox resolved that environment blocker. A targeted regression first demonstrated missing jitter after a `Retry-After` minimum (1 failed, 17 intentionally skipped by name filter); after the fix, the full 93-test run passed with no skipped tests.

The suite covers configuration defaults/bounds, missing/placeholder keys, model syntax, URL security, error redaction, unknown output/authority/ID fields, malformed JSON/envelopes, refusals, truncation, rate limits, retry exhaustion, exponential jitter, network failures, deadlines through body reading, oversized responses, empty input, fake-provider injection, proposal revalidation, safe clarification templates, and optional environment-file preservation/caller precedence.

Exact remaining conformance failures:

```text
expected final state "complete", got "in_progress"
agent never called POST /ehr/patients:match (identity verification)
agent never fetched the patient's medications
agent never submitted a refill (POST /ehr/patients/{id}/refills)
```

Live Groq connectivity was not attempted with the credential known to be exposed in Git history. After revocation/replacement, `npm run smoke:groq` explicitly opts into one synthetic request with retries disabled. It prints only a pass result or a sanitized failure code, never the response, key or prompt. Live model behavior, availability and account access are therefore unverified in this phase.

Clinical rules, authentication, session ownership, pharmacy writes, consent, refill submission, duplicate-write handling and transport hardening remain unimplemented. The Phase 2 suite does not establish those guarantees. This is not a complete assessment submission, and no refill or handoff is claimed.
