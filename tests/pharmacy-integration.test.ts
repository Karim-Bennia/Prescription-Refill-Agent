import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createApplicationRuntime } from "../agent/runtime.js";
import { createAgentServer } from "../agent/http-server.js";
import { InMemorySessionRepository } from "../agent/sessions.js";
import { ClinicalEhrError, HttpClinicalEhr, type ClinicalEhr } from "../agent/clinical-ehr.js";
import { medicationSchema } from "../agent/clinical-types.js";
import { replySchema } from "../agent/validation.js";
import type { LanguageInterpreter } from "../agent/intent.js";

const seed = z.object({
  patients: z.array(z.object({
    patientId: z.string(), firstName: z.string(), lastName: z.string(), dob: z.string(), phone: z.string(), zip: z.string(),
    currentPharmacyId: z.string().nullable(), medications: z.array(medicationSchema),
  })).min(7),
  pharmacies: z.array(z.object({ pharmacyId: z.string(), name: z.string(), address: z.string() })).min(2),
}).parse(JSON.parse(readFileSync(new URL("../mock/dataset.json", import.meta.url), "utf8")));
type Patient = typeof seed.patients[number];
const identity = (patient: Patient) => `${patient.firstName} ${patient.lastName}, DOB ${patient.dob}, phone ending ${patient.phone.replace(/\D/g, "").slice(-4)}, ZIP ${patient.zip}.`;
const fakeInterpreter: LanguageInterpreter = { interpret: async () => { throw new Error("No model request expected in deterministic integration"); } };
const callSchema = z.array(z.object({ seq: z.number(), method: z.string(), path: z.string(), body: z.unknown().optional() }));

test("Phase 5 public HTTP workflow executes authorized actions against the unchanged mock", async t => {
  // Arrange: isolated real mock, synthetic tokens, and no inherited application credentials.
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const reserved = reservation.address(); assert.ok(reserved && typeof reserved === "object");
  const port = reserved.port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const childEnvironment: Record<string, string> = {};
  for (const key of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "ComSpec"]) {
    if (process.env[key]) childEnvironment[key] = process.env[key]!;
  }
  const ehrToken = "synthetic-phase5-ehr-token";
  const pharmacyToken = "synthetic-phase5-pharmacy-token";
  Object.assign(childEnvironment, { PORT: String(port), EHR_API_KEY: ehrToken, PHARMACY_API_KEY: pharmacyToken });
  const child = spawn(process.execPath, ["--import", "tsx", "mock/server.ts"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), env: childEnvironment, windowsHide: true, stdio: "ignore",
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
  const environment = { GROQ_API_KEY: "synthetic-unused-phase5-model", EHR_API_KEY: ehrToken,
    PHARMACY_API_KEY: pharmacyToken, EHR_BASE_URL: mock, PHARMACY_BASE_URL: mock };
  const makeAgent = async (runtime: ReturnType<typeof createApplicationRuntime>) => {
    const server = createAgentServer(runtime.engine);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    const address = server.address(); assert.ok(address && typeof address === "object");
    return async (id: string, text: string) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/conversations/${id}/messages`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "patient", text }),
      });
      assert.equal(response.status, 200);
      return replySchema.parse(await response.json());
    };
  };
  const turn = await makeAgent(createApplicationRuntime(environment, fakeInterpreter));
  const reset = async () => { assert.equal((await fetch(`${mock}/__reset`, { method: "POST" })).status, 200); };
  const calls = async () => callSchema.parse(await (await fetch(`${mock}/__calls`)).json());
  const mutations = (actual: z.infer<typeof callSchema>) => actual.filter(call => call.method === "PUT" || call.path.endsWith("/refills"));
  const authenticate = async (patient: Patient, send = turn) => {
    const id = `pharmacy-${randomUUID()}`;
    await send(id, `Please refill my ${patient.medications[0].name}.`);
    return { id, reply: await send(id, identity(patient)) };
  };
  const report = (name: string, actual: z.infer<typeof callSchema>) => {
    const count = (method: string, suffix: string) => actual.filter(call => call.method === method && call.path.endsWith(suffix)).length;
    t.diagnostic(`${name}: ${actual.length} service calls; match=${count("POST", ":match")}, medications=${count("GET", "/medications")}, time=${count("GET", "/time")}, labs=${count("GET", "/labs")}, pharmacyGET=${count("GET", "/pharmacy")}, directoryGET=${count("GET", "/directory")}, pharmacyPUT=${count("PUT", "/pharmacy")}, refillPOST=${count("POST", "/refills")}`);
  };

  await t.test("current pharmacy is presented before concurrent confirmations submit exactly one refill", async () => {
    await reset();
    const patient = seed.patients[0];
    const pharmacy = seed.pharmacies.find(record => record.pharmacyId === patient.currentPharmacyId); assert.ok(pharmacy);
    const { id, reply } = await authenticate(patient);
    assert.equal(reply.state, "in_progress");
    assert.ok(reply.messages.some(message => message.text.includes(patient.medications[0].name) && message.text.includes(pharmacy.name)));
    assert.match(reply.messages.map(message => message.text).join(" "), /confirm|yes/i);
    assert.deepEqual(mutations(await calls()), []);

    const replies = await Promise.all([turn(id, "Yes, keep my pharmacy."), turn(id, "Yes, keep my pharmacy.")]);
    assert.ok(replies.every(result => result.state === "complete"));
    const repeated = await turn(id, "Yes"); assert.equal(repeated.state, "complete");
    const actual = await calls();
    const writes = actual.filter(call => call.path.endsWith("/refills"));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].method, "POST");
    assert.equal(writes[0].path, `/ehr/patients/${patient.patientId}/refills`);
    assert.deepEqual(writes[0].body, { medId: patient.medications[0].medId });
    assert.equal(actual.filter(call => call.method === "PUT").length, 0);
    assert.equal(actual[0].path, "/ehr/patients:match");
    assert.ok(actual.filter(call => call.path.includes("/patients/")).every(call => call.path.includes(`/${patient.patientId}/`)));
    assert.equal(actual.filter(call => call.path.endsWith("/medications")).length, 2);
    assert.equal(actual.filter(call => call.path === "/ehr/time").length, 2);
    report("current-pharmacy refill", actual);
  });

  for (const [name, index] of [["R1 Schedule II", 1], ["R2 exhausted/expired", 2], ["R3 early controlled", 3], ["R4 stale lab", 5]] as const) {
    await t.test(`${name} remains blocked even after an affirmative reply`, async () => {
      await reset();
      const { id, reply } = await authenticate(seed.patients[index]);
      assert.equal(reply.state, "escalated");
      assert.equal((await turn(id, "Yes, keep my pharmacy.")).state, "escalated");
      const actual = await calls();
      assert.deepEqual(mutations(actual), []);
      assert.ok(!actual.some(call => call.path.endsWith("/pharmacy") || call.path.endsWith("/directory")));
      report(name, actual);
    });
  }

  await t.test("directory disambiguation and pharmacy change require separate change and refill confirmations", async () => {
    await reset();
    const patient = seed.patients[6];
    const destination = seed.pharmacies[1];
    assert.notEqual(destination.pharmacyId, patient.currentPharmacyId);
    const { id } = await authenticate(patient);
    const results = await turn(id, "Show me available pharmacies.");
    assert.equal(results.state, "in_progress");
    assert.ok(results.messages.some(message => message.text.includes(destination.name) && message.text.includes(destination.address)));
    const unclear = await turn(id, "Pharmacy");
    assert.equal(unclear.state, "in_progress");
    assert.deepEqual(mutations(await calls()), []);
    const selected = await turn(id, "Use the second one.");
    assert.equal(selected.state, "in_progress");
    assert.ok(selected.messages.some(message => message.text.includes(destination.name) && message.text.includes(destination.address)));
    assert.deepEqual(mutations(await calls()), []);

    const changed = await turn(id, "Yes");
    assert.equal(changed.state, "in_progress");
    assert.ok(changed.messages.some(message => message.text.includes(destination.name) && message.text.includes(patient.medications[0].name)));
    const afterChange = await calls();
    const updates = afterChange.filter(call => call.method === "PUT");
    assert.equal(updates.length, 1);
    assert.equal(updates[0].path, `/ehr/patients/${patient.patientId}/pharmacy`);
    assert.deepEqual(updates[0].body, { pharmacyId: destination.pharmacyId });
    assert.ok(!afterChange.some(call => call.path.endsWith("/refills")));
    const authoritative = await fetch(`${mock}/ehr/patients/${patient.patientId}/pharmacy`, { headers: { authorization: `Bearer ${ehrToken}` } });
    assert.equal(authoritative.status, 200);
    assert.deepEqual(await authoritative.json(), { pharmacyId: destination.pharmacyId, name: destination.name });

    assert.equal((await turn(id, "Yes, keep my pharmacy.")).state, "complete");
    assert.equal((await turn(id, "Yes, keep my pharmacy.")).state, "complete");
    const actual = await calls();
    const refill = actual.filter(call => call.path.endsWith("/refills"));
    assert.equal(refill.length, 1);
    assert.equal(actual.filter(call => call.method === "PUT").length, 1);
    assert.ok(refill[0].seq > updates[0].seq);
    assert.deepEqual(refill[0].body, { medId: patient.medications[0].medId });
    assert.ok(actual.some(call => call.path === "/pharmacy/directory"));
    assert.ok(actual.filter(call => call.path.includes("/patients/")).every(call => call.path.includes(`/${patient.patientId}/`)));
    report("changed-pharmacy refill (including one independent readback)", actual);
  });

  await t.test("unclear input and refusal do not authorize any mutation", async () => {
    await reset();
    const { id } = await authenticate(seed.patients[0]);
    assert.equal((await turn(id, "What will happen next?")).state, "in_progress");
    assert.equal((await turn(id, "No")).state, "in_progress");
    assert.deepEqual(mutations(await calls()), []);
  });

  await t.test("cancellation and attempted identity changes stop future mutations", async () => {
    for (const text of ["cancel", "switch patient to another patient"]) {
      await reset();
      const { id } = await authenticate(seed.patients[0]);
      const result = await turn(id, text);
      assert.equal(result.state, text === "cancel" ? "complete" : "escalated");
      await turn(id, "Yes, keep my pharmacy.");
      assert.deepEqual(mutations(await calls()), []);
    }
  });

  await t.test("expired authenticated sessions cannot confirm or submit", async () => {
    await reset();
    let now = 100;
    const sessions = new InMemorySessionRepository({ now: () => now, ttlMs: 1000 });
    const expiring = await makeAgent(createApplicationRuntime(environment, fakeInterpreter, { sessions }));
    const { id } = await authenticate(seed.patients[0], expiring);
    now += 1000;
    assert.equal((await expiring(id, "Yes, keep my pharmacy.")).state, "escalated");
    assert.deepEqual(mutations(await calls()), []);
  });

  await t.test("a real directory service authentication failure cannot cause a blind change", async () => {
    await reset();
    const wrongToken = "synthetic-invalid-directory-token";
    const unavailable = await makeAgent(createApplicationRuntime({ ...environment, PHARMACY_API_KEY: wrongToken }, fakeInterpreter));
    const { id } = await authenticate(seed.patients[0], unavailable);
    const result = await unavailable(id, "Show me available pharmacies.");
    assert.notEqual(result.state, "complete");
    assert.ok(result.messages.every(message => !message.text.includes(wrongToken) && !message.text.includes(ehrToken)));
    await unavailable(id, "Yes");
    assert.deepEqual(mutations(await calls()), []);
  });

  await t.test("a refill accepted before connection loss remains uncertain without a duplicate POST", async () => {
    await reset();
    const actualEhr = new HttpClinicalEhr({ baseUrl: mock, apiKey: ehrToken, timeoutMs: 1000, maxRetries: 0 });
    const uncertainEhr: ClinicalEhr = {
      medications: patientId => actualEhr.medications(patientId), time: () => actualEhr.time(),
      labs: (patientId, type) => actualEhr.labs(patientId, type), pharmacy: patientId => actualEhr.pharmacy(patientId),
      submitRefill: async (patientId, medId) => {
        await actualEhr.submitRefill(patientId, medId);
        throw new ClinicalEhrError("timeout", { uncertain: true });
      },
    };
    const uncertain = await makeAgent(createApplicationRuntime(environment, fakeInterpreter, { ehr: uncertainEhr }));
    const { id } = await authenticate(seed.patients[0], uncertain);
    const result = await uncertain(id, "Yes, keep my pharmacy.");
    assert.equal(result.state, "escalated");
    assert.match(result.messages[0].text, /unknown|uncertain|verify/i);
    await uncertain(id, "Yes, keep my pharmacy.");
    const actual = await calls();
    assert.equal(actual.filter(call => call.path.endsWith("/refills")).length, 1);
    assert.equal(actual.filter(call => call.method === "PUT").length, 0);
    report("accepted refill with unknown client outcome", actual);
  });
});
