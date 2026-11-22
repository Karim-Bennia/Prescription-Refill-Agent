import assert from "node:assert/strict";
import { test } from "node:test";
import { createConnection } from "node:net";
import { createAgentServer } from "../agent/http-server.js";
import { ConfigurationError, loadConfig } from "../agent/config.js";

test("incomplete HTTP headers are closed promptly under the configured request deadline", async t => {
  let turns = 0;
  const server = createAgentServer({ handleTurn: async () => {
    turns++;
    return { state: "in_progress", messages: [{ from: "agent", text: "Synthetic reply" }] };
  } }, { bodyTimeoutMs: 25 });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const socket = createConnection({ host: "127.0.0.1", port: address.port });
  socket.on("error", () => undefined);
  t.after(() => new Promise<void>(resolve => {
    socket.destroy(); server.closeAllConnections(); server.close(() => resolve());
  }));
  await new Promise<void>(resolve => socket.once("connect", resolve));
  let response = "";
  socket.on("data", chunk => { response += chunk.toString("utf8"); });
  socket.write("POST /conversations/synthetic/messages HTTP/1.1\r\nHost: localhost\r\nX-Incomplete: ");
  const closed = await new Promise<boolean>(resolve => {
    const deadline = setTimeout(() => resolve(false), 1500);
    socket.once("close", () => { clearTimeout(deadline); resolve(true); });
  });
  assert.equal(closed, true, "Incomplete headers must not retain a socket until Node's default 30-second scan");
  assert.match(response, /408/);
  assert.equal(turns, 0);
});

test("configuration rejects nonprinting credential characters before outbound clients are created", () => {
  const environment = { GROQ_API_KEY: "synthetic-review-groq", EHR_API_KEY: "synthetic-review-ehr", PHARMACY_API_KEY: "synthetic-review-pharmacy" };
  for (const name of ["GROQ_API_KEY", "EHR_API_KEY", "PHARMACY_API_KEY"] as const) {
    for (const control of ["\u0000", "\u001b", "\u007f"]) {
      assert.throws(() => loadConfig({ ...environment, [name]: `synthetic${control}marker` }), error => {
        assert.ok(error instanceof ConfigurationError);
        assert.deepEqual(error.variables, [name]);
        assert.ok(!error.message.includes("marker"));
        return true;
      });
    }
  }
});
