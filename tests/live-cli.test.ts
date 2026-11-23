import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { liveMode, LivePreflightError } from "../evaluation/live.js";

test("live evaluation requires explicit rotation acknowledgement and Node 24 before execution", () => {
  assert.throws(() => liveMode([], "v24.0.0"), (error: unknown) => error instanceof LivePreflightError && error.code === "rotation_unconfirmed");
  assert.throws(() => liveMode(["--confirm-rotated-key"], "v20.17.0"), (error: unknown) => error instanceof LivePreflightError && error.code === "runtime");
  assert.throws(() => liveMode(["--force"], "v24.0.0"), (error: unknown) => error instanceof LivePreflightError && error.code === "arguments");
  assert.throws(() => liveMode(["--list", "--confirm-rotated-key"], "v24.0.0"), LivePreflightError);
  assert.equal(liveMode(["--confirm-rotated-key"], "v24.0.0"), "run");
  assert.equal(liveMode(["--list"], "v20.17.0"), "list");
});

test("actual unacknowledged CLI exits before credential validation or any model request", { timeout: 15_000 }, async () => {
  // Arrange: no credentials and no environment file are supplied to the child.
  const cwd = mkdtempSync(join(tmpdir(), "artera-live-preflight-"));
  const env: Record<string, string> = {};
  for (const key of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "ComSpec"]) if (process.env[key]) env[key] = process.env[key]!;
  const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  try {
    // Act
    const child = spawn(process.execPath, ["--import", loader, fileURLToPath(new URL("../evaluation/live.ts", import.meta.url))], {
      cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk.toString(); });
    child.stderr.on("data", chunk => { output += chunk.toString(); });
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject); child.once("exit", resolve);
    });
    // Assert: configuration/provider diagnostics would indicate the guard ran too late.
    assert.equal(exit, 1); assert.match(output, /rotation_unconfirmed/u);
    assert.doesNotMatch(output, /GROQ_API_KEY|Invalid configuration|Sanitized evaluation report/u);
  } finally { rmdirSync(cwd); }
});
