import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, basename, join, resolve } from "node:path";
import { loadLocalEnvironment } from "../agent/local-env.js";

test("optional local environment preserves caller variables and the file", t => {
  // Arrange: only a new synthetic temporary file is ever opened by this test.
  const originalDirectory = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), "artera-env-test-"));
  const variable = "ARTERA_SYNTHETIC_ENV_TEST";
  const originalValue = process.env[variable];
  t.after(() => {
    process.chdir(originalDirectory);
    if (originalValue === undefined) delete process.env[variable];
    else process.env[variable] = originalValue;
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith("artera-env-test-")) {
      throw new Error("Refusing to remove an unexpected temporary directory.");
    }
    rmSync(directory, { recursive: true, force: true });
  });
  process.chdir(directory);
  delete process.env[variable];
  // Act / Assert: env-only deployment works without a local file.
  assert.doesNotThrow(() => loadLocalEnvironment());
  const contents = `${variable}=synthetic-file-value\n`;
  writeFileSync(".env", contents);
  loadLocalEnvironment();
  assert.equal(process.env[variable], "synthetic-file-value");
  process.env[variable] = "synthetic-caller-value";
  loadLocalEnvironment();
  assert.equal(process.env[variable], "synthetic-caller-value");
  assert.equal(readFileSync(".env", "utf8"), contents);
});
