# Persistent engineering instructions

- Treat docs/API.md and supplied grader contracts as authoritative. Read README.md for architecture and requirements traceability before functional work; distinguish contract requirements from design decisions.
- Use strict TypeScript and small testable modules. Compose dependencies through narrow interfaces; keep policy pure and deterministic.
- Never display, copy, log, overwrite or commit credentials. Do not read environment files for inspection or stage them. Use explicit paths when staging; never git add . or git add -A. Do not export real credentials into the mock, which prints its service keys.
- No hardcoded credentials or patient-specific application behavior. Read configuration from environment. Never encode seed names, IDs, medication choices or clinical outcomes in application logic.
- Do not modify provided grader contracts, conformance scripts, mock fixtures or API requirements to make checks pass. Preserve the starter with minimal, reversible changes.
- Enforce identity, ownership, consent and clinical safety deterministically at the action boundary. The LLM must never authorize a prescription action, override a clinical rule or choose patient identity.
- Use EHR time for clinical dates. Fail closed on missing or invalid safety data. Never claim a refill or handoff occurred without supporting service evidence; no handoff API currently exists.
- Add meaningful tests accompanying every functional change, including safety boundaries, authorization isolation and failure behavior. Keep the requirements traceability matrix current.
- Run appropriate typechecks/tests and unchanged conformance. Never fabricate results; report exact failures, skipped checks and environmental blockers. Distinguish planned tests from executed tests.
- Prevent duplicate writes within sessions; never blindly retry an uncertain refill submission. Disclose limitations of in-memory persistence and missing upstream idempotency.
- Make clean Git commits after successful verification. If verification is blocked, report it and obtain direction before committing functional work. The explicitly requested analysis-only documentation commit may record a blocked baseline honestly.
- Report uncertainty, assumptions, partial successes and limitations clearly. Keep submission instructions reproducible; the candidate reports that Artera waived the AI transcript deliverable, as recorded in SUBMISSION.md.
- Respect the phase scope explicitly authorized in the current user instructions. Stop after its requested commit; do not implement subsequent phases without instruction.
