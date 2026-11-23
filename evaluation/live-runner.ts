import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as reserveServer } from "node:net";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { z } from "zod";
import { createApplicationRuntime } from "../agent/runtime.js";
import { createAgentServer } from "../agent/http-server.js";
import { InMemorySessionRepository } from "../agent/sessions.js";
import { pharmacyRecordSchema } from "../agent/clinical-types.js";
import { replySchema, requestSchema, type AgentReply } from "../agent/validation.js";
import type { LanguageInterpreter } from "../agent/intent.js";
import type { PolicyReason } from "../agent/policy.js";
import { liveDatasetSchema, type LiveScenario, type PublicState } from "./live-scenarios.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const datasetPath = fileURLToPath(new URL("../mock/dataset.json", import.meta.url));
const identifier = z.string().min(1).max(256).refine(value => !/[\s\u0000-\u001f\u007f]/u.test(value));
const callsSchema = z.array(z.strictObject({
  seq: z.number().int().positive(), method: z.enum(["GET", "POST", "PUT"]),
  path: z.string().min(1).max(1000), query: z.record(z.string(), z.string()), body: z.unknown().optional(),
})).max(512);
const safeHttpErrorSchema = z.strictObject({ error: z.enum([
  "invalid request", "method not allowed", "not found", "request too large", "request timed out", "service unavailable",
]) });
type SafeHttpError = z.infer<typeof safeHttpErrorSchema>;
export type LiveRunnerErrorCode = "invalid_configuration" | "invalid_scenario" | "mock_startup" | "transport" | "invalid_response" | "setup";
export class LiveRunnerError extends Error {
  /** Represent a sanitized evaluation setup, transport or schema failure. */
  constructor(readonly code: LiveRunnerErrorCode) { super(`Evaluation runner failed (${code}).`); this.name = "LiveRunnerError"; }
}
export interface LiveTranscriptTurn {
  readonly turnIndex: number;
  readonly patient: string;
  readonly httpStatus: number | null;
  readonly response: AgentReply | SafeHttpError | null;
  readonly elapsedMs: number;
  readonly errorCategory?: "http_status" | "invalid_response" | "transport";
}
export interface SafeServiceCall {
  readonly seq: number; readonly method: "GET" | "POST" | "PUT"; readonly path: string;
  readonly medId?: string; readonly pharmacyId?: string;
}
export interface LiveScenarioResult {
  readonly scenarioId: string;
  readonly conversationId: string;
  readonly transcript: readonly LiveTranscriptTurn[];
  /** Authentication factors, query text, headers, and arbitrary bodies are deliberately omitted. */
  readonly calls: readonly SafeServiceCall[];
  readonly effects: {
    readonly refillPosts: number; readonly pharmacyUpdates: number; readonly protectedReads: number;
    readonly currentPharmacyId: string | null; readonly refillMedIds: readonly string[]; readonly updatedPharmacyIds: readonly string[];
  };
  readonly sessionEvidence: {
    readonly phase: string; readonly policyReasons?: readonly PolicyReason[];
    readonly receipt?: { readonly refillId: string; readonly status: "submitted" };
    readonly medId?: string; readonly pharmacyId?: string;
  };
  readonly checkpointFailures: readonly string[];
  readonly finalState: PublicState | null;
  readonly passed: boolean;
}
export interface LiveRunnerOptions {
  readonly interpreter: LanguageInterpreter;
  readonly timeoutMs?: number;
  /** Evaluation labeling only; does not modify application state or authorization. */
  readonly onTurnStart?: (turnIndex: number) => void;
}

/** Parse a byte-limited strict UTF-8 response from an isolated evaluation service. */
async function readJson(response: Response, maxBytes = 1_048_576): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new LiveRunnerError("invalid_response");
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) throw new LiveRunnerError("invalid_response");
      chunks.push(next.value);
    }
    const body = Buffer.concat(chunks);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch { throw new LiveRunnerError("invalid_response"); }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** Reserve and release an ephemeral loopback port for an isolated mock process. */
async function availablePort(): Promise<number> {
  const reservation = reserveServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  if (!address || typeof address === "string") throw new LiveRunnerError("setup");
  return address.port;
}

/** Stop only the owned mock process with a bounded cleanup wait. */
async function stopMock(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 5000);
    child.once("exit", () => { clearTimeout(timer); resolve(); }); child.kill();
  });
}
/** Close the isolated agent listener and its open connections. */
async function closeAgent(server: Server | undefined): Promise<void> {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

/** Start the unchanged mock with synthetic service credentials and bounded health polling. */
async function startMock(port: number, ehrToken: string, pharmacyToken: string): Promise<ChildProcess> {
  const environment: Record<string, string> = {};
  for (const name of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "ComSpec"]) {
    const value = process.env[name]; if (value) environment[name] = value;
  }
  Object.assign(environment, { PORT: String(port), EHR_API_KEY: ehrToken, PHARMACY_API_KEY: pharmacyToken, DATASET_PATH: datasetPath });
  // The unchanged mock prints its tokens at startup, so never inherit credentials or output.
  const child = spawn(process.execPath, ["--import", "tsx", "mock/server.ts"], {
    cwd: repositoryRoot, env: environment, stdio: "ignore", windowsHide: true,
  });
  let failed = false; child.once("error", () => { failed = true; });
  try {
    const deadline = performance.now() + 10_000;
    while (performance.now() < deadline) {
      if (failed || child.exitCode !== null) break;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(300) });
        const healthy = z.strictObject({ ok: z.literal(true) }).safeParse(await readJson(response, 1024));
        if (response.ok && healthy.success && child.exitCode === null) return child;
      } catch { /* Startup polling is bounded and never emits child error details. */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new LiveRunnerError("mock_startup");
  } catch { await stopMock(child); throw new LiveRunnerError("mock_startup"); }
}

/** Keep only documented service-call metadata and validated mutation identifiers. */
function summarizeCalls(raw: z.infer<typeof callsSchema>): SafeServiceCall[] {
  return raw.map(call => {
    const safe = { seq: call.seq, method: call.method, path: call.path };
    if (call.method === "POST" && call.path.endsWith("/refills")) {
      const body = z.strictObject({ medId: identifier }).safeParse(call.body);
      if (!body.success) throw new LiveRunnerError("invalid_response");
      return { ...safe, medId: body.data.medId };
    }
    if (call.method === "PUT" && call.path.endsWith("/pharmacy")) {
      const body = z.strictObject({ pharmacyId: identifier }).safeParse(call.body);
      if (!body.success) throw new LiveRunnerError("invalid_response");
      return { ...safe, pharmacyId: body.data.pharmacyId };
    }
    return safe;
  });
}
/** Identify patient-record GET operations when checking authentication ordering. */
const isProtectedRead = (call: SafeServiceCall) => call.method === "GET" && call.path.startsWith("/ehr/patients/");
/** Select recorded refill POSTs for mutation-count assertions. */
const refillCalls = (calls: readonly SafeServiceCall[]) => calls.filter(call => call.method === "POST" && call.path.endsWith("/refills"));
/** Select recorded pharmacy PUTs for consent and mutation-count assertions. */
const updateCalls = (calls: readonly SafeServiceCall[]) => calls.filter(call => call.method === "PUT" && call.path.endsWith("/pharmacy"));

// Inject the existing real provider for opt-in evaluation or a deterministic fake for routine tests.
// This module never reads an environment file or constructs a model client.
/** Run an isolated synthetic HTTP conversation and verify the unchanged mock's actual effects. */
export async function runMockScenario(scenario: LiveScenario, options: LiveRunnerOptions): Promise<LiveScenarioResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new LiveRunnerError("invalid_configuration");
  if (!scenario.turns.length || scenario.turns.length > 30
    || scenario.turns.some(text => !requestSchema.safeParse({ from: "patient", text }).success)) throw new LiveRunnerError("invalid_scenario");
  let dataset: z.infer<typeof liveDatasetSchema>;
  try { dataset = liveDatasetSchema.parse(JSON.parse(readFileSync(datasetPath, "utf8"))); }
  catch { throw new LiveRunnerError("setup"); }
  const patient = dataset.patients.find(record => record.patientId === scenario.expectations.patientId);
  if (!patient || (scenario.expectations.medId && !patient.medications.some(record => record.medId === scenario.expectations.medId))) {
    throw new LiveRunnerError("invalid_scenario");
  }
  const ehrToken = `synthetic-evaluation-ehr-${randomUUID()}`;
  const pharmacyToken = `synthetic-evaluation-pharmacy-${randomUUID()}`;
  let child: ChildProcess | undefined; let server: Server | undefined;
  try {
    const port = await availablePort(); child = await startMock(port, ehrToken, pharmacyToken);
    const mock = `http://127.0.0.1:${port}`;
    const sessions = new InMemorySessionRepository();
    const runtime = createApplicationRuntime({
      GROQ_API_KEY: "synthetic-unused-evaluation-token", EHR_API_KEY: ehrToken, PHARMACY_API_KEY: pharmacyToken,
      EHR_BASE_URL: mock, PHARMACY_BASE_URL: mock, REQUEST_TIMEOUT_MS: String(Math.min(timeoutMs, 60_000)),
    }, options.interpreter, { sessions });
    server = createAgentServer(runtime.engine);
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); if (!address || typeof address === "string") throw new LiveRunnerError("setup");
    const conversationId = `live-${randomUUID()}`;
    const endpoint = `http://127.0.0.1:${address.port}/conversations/${conversationId}/messages`;
    const transcript: LiveTranscriptTurn[] = []; const failures: string[] = [];
    let finalState: PublicState | null = null; let calls: SafeServiceCall[] = [];
    /** Read and validate the isolated mock call log without persisting authentication factors. */
    const snapshot = async () => {
      const response = await fetch(`${mock}/__calls`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new LiveRunnerError("transport");
      const parsed = callsSchema.safeParse(await readJson(response));
      if (!parsed.success) throw new LiveRunnerError("invalid_response");
      return summarizeCalls(parsed.data);
    };
    for (const [turnIndex, text] of scenario.turns.entries()) {
      options.onTurnStart?.(turnIndex);
      const started = performance.now(); let status: number | null = null;
      let responseBody: LiveTranscriptTurn["response"] = null; let errorCategory: LiveTranscriptTurn["errorCategory"];
      try {
        const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ from: "patient", text }), signal: AbortSignal.timeout(timeoutMs) });
        status = response.status;
        const body = await readJson(response, 65_536);
        if (response.ok) {
          const parsed = replySchema.safeParse(body);
          if (parsed.success) { responseBody = parsed.data; finalState = parsed.data.state; }
          else errorCategory = "invalid_response";
        } else { responseBody = safeHttpErrorSchema.safeParse(body).data ?? null; errorCategory = "http_status"; }
      } catch (error) { errorCategory = error instanceof LiveRunnerError && error.code === "invalid_response" ? "invalid_response" : "transport"; }
      transcript.push({ turnIndex, patient: text, httpStatus: status, response: responseBody, elapsedMs: performance.now() - started,
        ...(errorCategory ? { errorCategory } : {}) });
      calls = await snapshot();
      if (errorCategory) { failures.push(`turn ${turnIndex}: ${errorCategory}`); break; }
      for (const checkpoint of scenario.checkpoints.filter(checkpoint => checkpoint.afterTurn === turnIndex)) {
        if (checkpoint.state !== undefined && checkpoint.state !== finalState) failures.push(`turn ${turnIndex}: state mismatch`);
        if (refillCalls(calls).length !== checkpoint.refills) failures.push(`turn ${turnIndex}: refill count mismatch`);
        if (updateCalls(calls).length !== checkpoint.pharmacyUpdates) failures.push(`turn ${turnIndex}: pharmacy update count mismatch`);
        if (checkpoint.maxProtectedReads !== undefined && calls.filter(isProtectedRead).length > checkpoint.maxProtectedReads) {
          failures.push(`turn ${turnIndex}: premature protected read`);
        }
        if (checkpoint.replyIncludes && responseBody && "messages" in responseBody
          && !responseBody.messages.some(message => message.text.includes(checkpoint.replyIncludes!))) failures.push(`turn ${turnIndex}: expected reply fragment absent`);
      }
    }
    const refills = refillCalls(calls); const updates = updateCalls(calls);
    const expected = scenario.expectations;
    if (finalState !== expected.state) failures.push("final state mismatch");
    if (refills.length !== expected.refills) failures.push("final refill count mismatch");
    if (updates.length !== expected.pharmacyUpdates) failures.push("final pharmacy update count mismatch");
    let matched = false; let destination = patient.currentPharmacyId;
    for (const [index, call] of calls.entries()) {
      if (call.seq !== index + 1) failures.push("nonsequential backend call log");
      if (call.method === "POST" && call.path === "/ehr/patients:match") matched = true;
      const owned = call.path.startsWith("/ehr/patients/");
      if (owned && !call.path.startsWith(`/ehr/patients/${expected.patientId}/`)) failures.push("wrong-patient backend operation");
      if (owned && !matched) failures.push("protected operation precedes identity matching");
      const documented = call.path === "/ehr/time" && call.method === "GET"
        || call.path === "/ehr/patients:match" && call.method === "POST"
        || call.path === "/pharmacy/directory" && call.method === "GET"
        || owned && call.method === "GET" && /\/(?:medications|labs|pharmacy)$/u.test(call.path)
        || owned && call.method === "PUT" && call.path.endsWith("/pharmacy")
        || owned && call.method === "POST" && call.path.endsWith("/refills");
      if (!documented) failures.push("undocumented backend operation");
      if (call.pharmacyId) {
        destination = call.pharmacyId;
        if (call.pharmacyId !== expected.destinationPharmacyId) failures.push("unexpected pharmacy update destination");
      }
      if (call.medId && (call.medId !== expected.medId || destination !== expected.destinationPharmacyId)) failures.push("incorrect refill medication or destination");
    }
    // This independent verification read is deliberately made after the recorded application-call snapshot.
    const pharmacyResponse = await fetch(`${mock}/ehr/patients/${encodeURIComponent(patient.patientId)}/pharmacy`, {
      headers: { authorization: `Bearer ${ehrToken}` }, signal: AbortSignal.timeout(5000),
    });
    if (!pharmacyResponse.ok) throw new LiveRunnerError("transport");
    const pharmacy = pharmacyRecordSchema.nullable().safeParse(await readJson(pharmacyResponse, 65_536));
    if (!pharmacy.success) throw new LiveRunnerError("invalid_response");
    if (pharmacy.data?.pharmacyId !== (destination ?? undefined)) failures.push("authoritative pharmacy verification mismatch");
    const state = await sessions.run(conversationId, async current => ({ state: current, result: current }));
    const evidence: LiveScenarioResult["sessionEvidence"] = state.phase === "refill_submitted"
      ? { phase: state.phase, receipt: state.receipt, medId: state.medId, pharmacyId: state.pharmacyId }
      : state.phase === "clinical_escalated" ? { phase: state.phase, policyReasons: state.policyReasons } : { phase: state.phase };
    if (expected.refills > 0 && (state.phase !== "refill_submitted" || state.medId !== expected.medId || state.pharmacyId !== expected.destinationPharmacyId)) {
      failures.push("missing or mismatched confirmed refill receipt");
    }
    if (expected.policyReason && (state.phase !== "clinical_escalated" || !state.policyReasons.includes(expected.policyReason))) failures.push("clinical policy reason mismatch");
    return { scenarioId: scenario.id, conversationId, transcript, calls,
      effects: { refillPosts: refills.length, pharmacyUpdates: updates.length, protectedReads: calls.filter(isProtectedRead).length,
        currentPharmacyId: pharmacy.data?.pharmacyId ?? null, refillMedIds: refills.map(call => call.medId!), updatedPharmacyIds: updates.map(call => call.pharmacyId!) },
      sessionEvidence: evidence, checkpointFailures: [...new Set(failures)], finalState, passed: failures.length === 0 };
  } catch (error) { if (error instanceof LiveRunnerError) throw error; throw new LiveRunnerError("setup"); }
  finally { await closeAgent(server); if (child) await stopMock(child); }
}
