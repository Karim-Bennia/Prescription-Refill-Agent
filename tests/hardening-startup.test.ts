import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { EVALUATION_ENV } from "./evaluation-fixtures.js";

const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
async function start(t: { after(fn: () => Promise<void>): unknown }, port: number, missingKey = false) {
  const directory = mkdtempSync(join(tmpdir(), "artera-startup-review-"));
  assert.equal(existsSync(join(directory, ".env")), false);
  const environment: Record<string, string> = {};
  for (const key of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "ComSpec"]) if (process.env[key]) environment[key] = process.env[key]!;
  Object.assign(environment, EVALUATION_ENV, { AGENT_PORT: String(port) });
  if (missingKey) delete environment.GROQ_API_KEY;
  const child = spawn(process.execPath, ["--import", loader, fileURLToPath(new URL("../agent/start.ts", import.meta.url))], {
    cwd: directory, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output = (output + chunk.toString()).slice(-16384); });
  child.stderr.on("data", chunk => { output = (output + chunk.toString()).slice(-16384); });
  const exited = new Promise<number | null>(resolve => { child.once("exit", resolve); child.once("error", () => resolve(-1)); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    rmdirSync(directory); // Only remove the empty directory created above; no recursive cleanup.
  });
  const assertRedacted = () => { for (const value of Object.values(EVALUATION_ENV)) assert.ok(!output.includes(value)); };
  return { child, exited, assertRedacted, output: () => output };
}

test("actual startup entry point uses injected configuration and sanitized HTTP diagnostics without a local env file", { timeout: 15000 }, async t => {
  const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address(); assert.ok(address && typeof address === "object");
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const app = await start(t, address.port);
  let healthy = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (app.child.exitCode !== null) break;
    try { healthy = (await fetch(`http://127.0.0.1:${address.port}/healthz`, { signal: AbortSignal.timeout(300) })).ok; } catch {}
    if (healthy) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(healthy, true);
  await new Promise<void>(resolve => setImmediate(resolve));
  app.assertRedacted(); assert.match(app.output(), /agent on http:\/\/127\.0\.0\.1:/);
});

test("actual startup fails safely on missing credentials and an occupied listener", { timeout: 15000 }, async t => {
  const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => listener.close(() => resolve())));
  const address = listener.address(); assert.ok(address && typeof address === "object");
  const invalid = await start(t, address.port, true);
  assert.equal(await invalid.exited, 1); invalid.assertRedacted(); assert.match(invalid.output(), /Invalid configuration: GROQ_API_KEY/);
  const occupied = await start(t, address.port);
  assert.equal(await occupied.exited, 1); occupied.assertRedacted(); assert.match(occupied.output(), /Agent listener failed/);
});
