import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createRuntime } from "../agent/runtime.js";
import { createAgentServer } from "../agent/http-server.js";
import { InMemorySessionRepository } from "../agent/sessions.js";
import { HttpClinicalEhr } from "../agent/clinical-ehr.js";
import { medicationSchema } from "../agent/clinical-types.js";
import { replySchema } from "../agent/validation.js";
import type { PolicyReason } from "../agent/policy.js";

const seed = z.object({ patients: z.array(z.object({
  patientId: z.string(), firstName: z.string(), lastName: z.string(), dob: z.string(), phone: z.string(), zip: z.string(),
  currentPharmacyId: z.string().nullable(), medications: z.array(medicationSchema),
})).min(7) }).parse(JSON.parse(readFileSync(new URL("../mock/dataset.json", import.meta.url), "utf8")));
type Patient = typeof seed.patients[number];
const identity = (patient: Patient) => `${patient.firstName} ${patient.lastName}, DOB ${patient.dob}, phone ending ${patient.phone.replace(/\D/g, "").slice(-4)}, ZIP ${patient.zip}.`;

test("Phase 4 production runtime uses the unchanged real mock for clinical reads and guarded submission", async t => {
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const reserved = reservation.address(); assert.ok(reserved && typeof reserved === "object");
  const port = reserved.port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const env: Record<string, string> = {};
  for (const key of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "ComSpec"]) if (process.env[key]) env[key] = process.env[key]!;
  const token = "synthetic-phase4-integration-token";
  Object.assign(env, { PORT: String(port), EHR_API_KEY: token, PHARMACY_API_KEY: "synthetic-phase4-pharmacy" });
  const child = spawn(process.execPath, ["--import", "tsx", "mock/server.ts"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), env, windowsHide: true, stdio: "ignore",
  });
  let failed = false; child.once("error", () => { failed = true; });
  t.after(async () => {
    if (child.pid && child.exitCode === null) {
      const exit = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill(); await exit;
    }
  });
  const mock = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (failed || child.exitCode !== null) break;
    try { healthy = (await fetch(`${mock}/healthz`, { signal: AbortSignal.timeout(500) })).ok; } catch {}
    if (healthy) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(healthy, true);
  const environment = { GROQ_API_KEY: "synthetic-unused-model-token", EHR_API_KEY: token,
    PHARMACY_API_KEY: "synthetic-phase4-pharmacy", EHR_BASE_URL: mock, PHARMACY_BASE_URL: mock };
  const sessions = new InMemorySessionRepository();
  const runtime = createRuntime(environment, { interpret: async () => { throw new Error("No model request expected"); } }, { sessions });
  const server = createAgentServer(runtime.engine);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const agent = `http://127.0.0.1:${address.port}`;
  const reset = () => fetch(`${mock}/__reset`, { method: "POST" });
  const callSchema = z.array(z.object({ seq: z.number(), method: z.string(), path: z.string(), body: z.unknown().optional() }));
  const calls = async () => callSchema.parse(await (await fetch(`${mock}/__calls`)).json());
  const turn = async (id: string, text: string) => {
    const response = await fetch(`${agent}/conversations/${id}/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "patient", text }),
    });
    assert.equal(response.status, 200); return replySchema.parse(await response.json());
  };
  const state = (id: string) => sessions.run(id, async current => ({ state: current, result: current }));

  const scenarios: { name: string; patient: Patient; medIndex: number; reason?: PolicyReason }[] = [
    { name: "eligible noncontrolled", patient: seed.patients[0], medIndex: 0 },
    { name: "R1 Schedule II", patient: seed.patients[1], medIndex: 0, reason: "R1_schedule_ii" },
    { name: "R2 no refills and expired", patient: seed.patients[2], medIndex: 0, reason: "R2_no_refills" },
    { name: "R3 early controlled decimal strength", patient: seed.patients[3], medIndex: 0, reason: "R3_early_controlled" },
    { name: "R4 stale lab", patient: seed.patients[5], medIndex: 0, reason: "R4_missing_recent_lab" },
    { name: "R4 fresh lab", patient: seed.patients[6], medIndex: 0 },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async () => {
    await reset();
    const id = `clinical-${randomUUID()}`;
    const record = scenario.patient.medications[scenario.medIndex];
    await turn(id, `Please refill my ${record.name}.`);
    assert.deepEqual(await calls(), []);
    const reply = await turn(id, identity(scenario.patient));
    assert.equal(reply.state, scenario.reason ? "escalated" : "in_progress");
    const stored = await state(id);
    assert.equal(stored.phase, scenario.reason ? "clinical_escalated" : "awaiting_pharmacy_confirmation");
    if (scenario.reason && stored.phase === "clinical_escalated") assert.ok(stored.policyReasons.includes(scenario.reason));
    await turn(id, "Yes, keep my pharmacy.");
    const actual = await calls();
    assert.equal(actual[0].path, "/ehr/patients:match");
    assert.ok(actual.some(call => call.path === `/ehr/patients/${scenario.patient.patientId}/medications`));
    assert.ok(actual.some(call => call.path === "/ehr/time"));
    assert.ok(actual.every(call => !call.path.startsWith("/ehr/patients/") || call.path.includes(`/${scenario.patient.patientId}/`)));
    assert.equal(actual.filter(call => call.method === "POST" && call.path.endsWith("/refills")).length, 0);
    assert.equal(actual.filter(call => call.path.endsWith("/pharmacy")).length, 0);
    assert.equal(actual.length, record.requiresRecentLab ? 4 : 3);
  });

  await t.test("normal domain consent permits one real POST while the public Phase 4 conversation never bypasses it", async () => {
    await reset();
    const patient = seed.patients[0]; const record = patient.medications[0];
    const id = `submit-${randomUUID()}`;
    await turn(id, `refill my ${record.name}`); await turn(id, identity(patient));
    await turn(id, "Yes, keep my pharmacy.");
    assert.equal((await calls()).filter(call => call.path.endsWith("/refills")).length, 0);
    const confirmed = await sessions.run(id, async (current, context) => ({
      state: current, result: await runtime.actions.confirmCurrentPharmacy(current, context, patient.currentPharmacyId!),
    }));
    assert.equal(confirmed, true);
    const submit = () => sessions.run(id, async (current, context) => {
      const result = await runtime.actions.submit(current, context); return { state: result.state, result: result.outcome };
    });
    const outcomes = await Promise.all([submit(), submit()]);
    assert.deepEqual(outcomes[0], outcomes[1]); assert.equal(outcomes[0].kind, "submitted");
    const reply = await turn(id, "submit again"); assert.equal(reply.state, "complete");
    const actual = await calls();
    const writes = actual.filter(call => call.method === "POST" && call.path.endsWith("/refills"));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, `/ehr/patients/${patient.patientId}/refills`);
    assert.deepEqual(writes[0].body, { medId: record.medId });
    assert.equal(actual.filter(call => call.method === "PUT").length, 0);
    assert.equal(actual.length, 8); // match, intake meds/time, confirmation pharmacy, fresh meds/time/pharmacy, refill
  });

  await t.test("real clinical-service 401 cannot become an eligible or submitted response", async () => {
    await reset();
    const bad = new HttpClinicalEhr({ baseUrl: mock, apiKey: "synthetic-wrong-token", timeoutMs: 1000, maxRetries: 0 });
    const isolated = createRuntime(environment, { interpret: async () => { throw new Error("No model expected"); } }, { ehr: bad });
    const id = `service-error-${randomUUID()}`;
    await isolated.engine.handleTurn(id, `refill my ${seed.patients[0].medications[0].name}`);
    const reply = await isolated.engine.handleTurn(id, identity(seed.patients[0]));
    assert.equal(reply.state, "in_progress"); assert.match(reply.messages[0].text, /temporarily unavailable/);
    const actual = await calls(); assert.equal(actual.length, 1); assert.equal(actual[0].path, "/ehr/patients:match");
  });
});
