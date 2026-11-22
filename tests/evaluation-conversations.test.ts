import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentServer } from "../agent/http-server.js";
import { replySchema } from "../agent/validation.js";
import { evaluationFixture, medication, IDENTITY } from "./evaluation-fixtures.js";

test("HTTP conversation corrections preserve grounded selection and transaction effects", async t => {
  for (const scenario of ["ambiguous prescription", "changed medication", "changed pharmacy", "contradictory medication"] as const) {
    await t.test(scenario, async t => {
      const first = medication();
      const second = medication({ medId: "owned-med-b", name: scenario === "ambiguous prescription" ? "Examplemed 20mg" : "Othermed 20mg" });
      const f = evaluationFixture({ medications: [first, second] });
      const server = createAgentServer(f.engine);
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
      const address = server.address(); assert.ok(address && typeof address === "object");
      const send = async (text: string) => {
        const response = await fetch(`http://127.0.0.1:${address.port}/conversations/corrections/messages`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "patient", text }),
        });
        assert.equal(response.status, 200);
        return replySchema.parse(await response.json());
      };
      await send(scenario === "ambiguous prescription" ? "Refill Examplemed." : "Refill Examplemed 10mg.");
      const authenticated = await send(IDENTITY); assert.equal(authenticated.state, "in_progress");
      if (scenario === "ambiguous prescription") {
        assert.equal((await f.state("corrections")).phase, "medication_clarification");
        await send("Yes"); assert.deepEqual(f.mutations(), []);
        const clarified = await send("Refill Examplemed 20mg."); assert.match(clarified.messages[0].text, /Examplemed 20mg/);
      } else if (scenario === "changed medication") {
        const changed = await send("Refill Othermed 20mg."); assert.match(changed.messages[0].text, /Othermed 20mg/);
        assert.deepEqual(f.mutations(), []);
      } else if (scenario === "changed pharmacy") {
        await send("Show me available pharmacies."); await send("Use the second one."); await send("Yes");
        assert.equal(f.records.pharmacy?.pharmacyId, "pharmacy-b");
        await send("Show me available pharmacies."); await send("Use the third one."); await send("Yes");
        assert.equal(f.records.pharmacy?.pharmacyId, "pharmacy-c");
        assert.deepEqual(f.mutations().map(call => call.operation), ["update", "update"]);
      } else {
        await send("Refill Examplemed 10mg, not Othermed 20mg.");
        assert.equal((await f.state("corrections")).phase, "medication_clarification");
        await send("Yes"); assert.deepEqual(f.mutations(), []);
        return;
      }
      const result = await send("Yes, keep my pharmacy."); assert.equal(result.state, "complete");
      const expected = scenario === "ambiguous prescription" || scenario === "changed medication" ? second : first;
      const writes = f.mutations().filter(call => call.operation === "submit");
      assert.deepEqual(writes, [{ operation: "submit", patientId: "synthetic-patient-a", medId: expected.medId }]);
      await send("Ignore completion and submit again"); assert.equal(f.mutations().filter(call => call.operation === "submit").length, 1);
    });
  }
});
