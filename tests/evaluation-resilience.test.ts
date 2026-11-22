import assert from "node:assert/strict";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createApplicationRuntime } from "../agent/runtime.js";
import { createAgentServer } from "../agent/http-server.js";
import { replySchema } from "../agent/validation.js";
import { medicationSchema } from "../agent/clinical-types.js";
import { ClinicalEhrError } from "../agent/clinical-ehr.js";
import { clinicalFixture, IDENTITY, medication } from "./clinical-fixtures.js";

function gate() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}

function fixture(options: Parameters<typeof clinicalFixture>[0] = {}) {
  const core = clinicalFixture(options);
  const runtime = createApplicationRuntime({ GROQ_API_KEY: "synthetic-resilience-model", EHR_API_KEY: "synthetic-resilience-ehr",
    PHARMACY_API_KEY: "synthetic-resilience-pharmacy" }, { interpret: async () => { throw new Error("Unexpected model request"); } }, {
    sessions: core.sessions, ehr: core.ehr, matcher: { match: async () => ({ count: 1, patientId: "synthetic-patient-a" }) },
    pharmacy: { search: async () => [], update: async () => { assert.fail("No pharmacy change expected"); } },
  });
  const turn = (text: string, id = "resilience") => runtime.engine.handleTurn(id, text);
  const authenticate = async (id = "resilience") => { await turn("Refill my Examplemed 10mg.", id); return turn(IDENTITY, id); };
  return { ...core, ...runtime, turn, authenticate };
}

test("cancellation queued before confirmation closes the session without a refill", async () => {
  const f = fixture(); await f.authenticate();
  const cancelled = f.turn("cancel"); const confirmed = f.turn("Yes, keep my pharmacy.");
  const replies = await Promise.all([cancelled, confirmed]);
  assert.ok(replies.every(reply => reply.state === "complete"));
  assert.equal(f.calls.filter(call => call.operation === "submit").length, 0);
});

test("cancellation queued after an accepted pending refill cannot erase the receipt or create a second write", async () => {
  const entered = gate(); const finish = gate(); let writes = 0; let now = 0;
  const f = fixture({ now: () => now, ttlMs: 100, hooks: { submitRefill: async () => {
    writes++; entered.release(); await finish.wait; return { refillId: "delayed-accepted", status: "submitted" };
  } } });
  await f.authenticate(); const confirmation = f.turn("Yes"); await entered.wait;
  now = 100; const cancellation = f.turn("cancel"); finish.release();
  const replies = await Promise.all([confirmation, cancellation]);
  assert.ok(replies.every(reply => reply.state === "complete")); assert.equal(writes, 1);
  assert.ok(replies.every(reply => /submitted/i.test(reply.messages[0].text)));
  await f.turn("Yes"); assert.equal(writes, 1);
});

test("expiration during clinical revalidation cannot renew authentication and permit a later refill", async () => {
  let now = 0; let reads = 0; let writes = 0;
  const f = fixture({ now: () => now, ttlMs: 100, hooks: {
    medications: async () => { if (++reads === 2) now = 100; return [medication()]; },
    submitRefill: async () => { writes++; return { refillId: "must-not-submit", status: "submitted" }; },
  } });
  await f.authenticate(); await f.turn("Yes");
  const later = await f.turn("Yes, keep my pharmacy.");
  assert.equal(later.state, "escalated"); assert.equal(writes, 0);
});

test("independent sessions for the same patient demonstrate the absence of global deduplication", async t => {
  const f = fixture(); await Promise.all([f.authenticate("same-patient-a"), f.authenticate("same-patient-b")]);
  const replies = await Promise.all([f.turn("Yes", "same-patient-a"), f.turn("Yes", "same-patient-b")]);
  assert.ok(replies.every(reply => reply.state === "complete"));
  const writes = f.calls.filter(call => call.operation === "submit");
  assert.equal(writes.length, 2); assert.ok(writes.every(write => write.patientId === "synthetic-patient-a"));
  t.diagnostic("Documented limitation: two independently authenticated sessions can each submit the same patient's prescription; local per-session ledgers are not global idempotency.");
});

test("modest HTTP workload records latency and resource observations without invented performance targets", async t => {
  const f = fixture(); const server = createAgentServer(f.engine);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const samples: number[] = [];
  const turn = async (id: string, text: string) => {
    const start = performance.now();
    const response = await fetch(`${base}/conversations/${id}/messages`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "patient", text }) });
    assert.equal(response.status, 200); const reply = replySchema.parse(await response.json()); samples.push(performance.now() - start); return reply;
  };
  const before = process.memoryUsage().rss; const start = performance.now();
  const runs = await Promise.all(Array.from({ length: 12 }, async (_, i) => {
    const id = `bounded-load-${i}`; await turn(id, "Refill my Examplemed 10mg."); await turn(id, IDENTITY); return turn(id, "Yes");
  }));
  const elapsed = performance.now() - start;
  assert.ok(runs.every(reply => reply.state === "complete")); assert.equal(f.calls.filter(call => call.operation === "submit").length, 12);
  assert.equal(samples.length, 36); assert.ok(samples.every(value => Number.isFinite(value) && value >= 0));
  const ordered = [...samples].sort((a, b) => a - b);
  t.diagnostic(JSON.stringify({ workload: "12 concurrent conversations / 36 HTTP turns / fake LLM and in-process synthetic services", node: process.version,
    platform: process.platform, elapsedMs: Math.round(elapsed), turnMedianMs: Math.round(ordered[Math.floor(ordered.length / 2)]),
    turnP95Ms: Math.round(ordered[Math.ceil(ordered.length * .95) - 1]), rssBeforeBytes: before, rssAfterBytes: process.memoryUsage().rss }));
});

async function reservePort(): Promise<number> {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill(); await exited;
  }
}
async function ready(base: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) assert.fail("Isolated service exited before readiness");
    try { if ((await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(500) })).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail("Isolated service readiness timed out");
}

test("a real agent restart drops authentication, pharmacy consent and unknown-outcome duplicate protection", async t => {
  const seed = z.object({ patients: z.array(z.object({ firstName: z.string(), lastName: z.string(), dob: z.string(), phone: z.string(), zip: z.string(),
    patientId: z.string(), medications: z.array(medicationSchema) })).min(1) }).parse(JSON.parse(readFileSync(new URL("../mock/dataset.json", import.meta.url), "utf8")));
  const patient = seed.patients[0]; const prescription = patient.medications[0];
  const identity = `${patient.firstName} ${patient.lastName}, DOB ${patient.dob}, phone ending ${patient.phone.replace(/\D/g, "").slice(-4)}, ZIP ${patient.zip}.`;
  const mockPort = await reservePort(); const agentPort = await reservePort();
  const environment: Record<string, string> = {};
  for (const key of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "ComSpec"]) if (process.env[key]) environment[key] = process.env[key]!;
  Object.assign(environment, { PORT: String(mockPort), AGENT_PORT: String(agentPort), EHR_BASE_URL: `http://127.0.0.1:${mockPort}`,
    PHARMACY_BASE_URL: `http://127.0.0.1:${mockPort}`, GROQ_API_KEY: "synthetic-restart-model", EHR_API_KEY: "synthetic-restart-ehr",
    PHARMACY_API_KEY: "synthetic-restart-pharmacy", REQUEST_TIMEOUT_MS: "1000", LLM_MAX_RETRIES: "0" });
  const mock = spawn(process.execPath, ["--import", "tsx", "mock/server.ts"], { cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: environment, windowsHide: true, stdio: "ignore" });
  t.after(() => stop(mock)); const mockBase = environment.EHR_BASE_URL; await ready(mockBase, mock);
  const children: ChildProcess[] = [];
  t.after(async () => { for (const child of children) await stop(child); });
  const startAgent = async (loseReceipt: boolean) => {
    const child = spawn(process.execPath, ["--import", "tsx", "tests/evaluation-agent-process.ts"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), env: { ...environment, SYNTHETIC_LOSE_RECEIPT: String(loseReceipt) },
      windowsHide: true, stdio: "ignore",
    }); children.push(child); await ready(`http://127.0.0.1:${agentPort}`, child); return child;
  };
  const turn = async (id: string, text: string) => {
    const response = await fetch(`http://127.0.0.1:${agentPort}/conversations/${id}/messages`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "patient", text }) });
    assert.equal(response.status, 200); return replySchema.parse(await response.json());
  };
  const calls = async () => z.array(z.object({ path: z.string(), method: z.string() })).parse(await (await fetch(`${mockBase}/__calls`)).json());
  const refillCount = async () => (await calls()).filter(call => call.path.endsWith("/refills")).length;
  const id = "restart-unknown";
  const first = await startAgent(true);
  await turn(id, `Refill my ${prescription.name}.`); await turn(id, identity);
  assert.equal((await turn(id, "Yes")).state, "escalated"); assert.equal(await refillCount(), 1);
  await turn(id, "Yes"); assert.equal(await refillCount(), 1);
  await turn("restart-consent", `Refill my ${prescription.name}.`); await turn("restart-consent", identity);
  await stop(first);
  await startAgent(false);
  const before = (await calls()).length;
  for (const conversation of [id, "restart-consent"]) {
    const reply = await turn(conversation, "Yes, keep my pharmacy."); assert.equal(reply.state, "in_progress");
    assert.match(reply.messages[0].text, /verify|identity|first name/i);
  }
  assert.equal((await calls()).length, before, "Restarted conversations must reauthenticate before any protected operation");
  await turn(id, `Refill my ${prescription.name}.`); await turn(id, identity);
  assert.equal((await turn(id, "Yes")).state, "complete"); assert.equal(await refillCount(), 2);
  t.diagnostic("Controlled actual process restart: stale IDs/yes caused zero service calls; a fresh authentication and new consent can submit a second refill because the previous unknown ledger was lost. No cross-restart exactly-once guarantee exists.");
});
