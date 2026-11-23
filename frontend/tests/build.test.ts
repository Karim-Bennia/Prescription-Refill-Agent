import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { buildFrontend } from "../build.js";

test("production browser assets contain React without server credentials, environment loaders or model clients", async () => {
  const previous = process.env.FRONTEND_BUILD_PRIVATE_MARKER;
  process.env.FRONTEND_BUILD_PRIVATE_MARKER = "synthetic-browser-exclusion-canary-9d5f13";
  try { await buildFrontend(); }
  finally {
    if (previous === undefined) delete process.env.FRONTEND_BUILD_PRIVATE_MARKER;
    else process.env.FRONTEND_BUILD_PRIVATE_MARKER = previous;
  }
  const [html, script, styles] = await Promise.all(["index.html", "app.js", "app.css"].map(file => readFile(new URL(`../dist/${file}`, import.meta.url), "utf8")));
  assert.match(html, /id="root"/); assert.match(html, /src="\/app\.js"/); assert.match(html, /href="\/styles\.css"/);
  assert.match(script, /react\.production|react\.transitional\.element/);
  assert.ok(styles.length > 0);
  for (const forbidden of ["synthetic-browser-exclusion-canary-9d5f13", "GROQ_API_KEY", "EHR_API_KEY", "PHARMACY_API_KEY",
    "api.groq.com", "loadLocalEnvironment", "readFileSync", "dotenv"]) {
    assert.ok(!script.includes(forbidden), `Browser bundle must exclude ${forbidden}`);
  }
  assert.ok(!/gsk_[A-Za-z0-9]{20,}/u.test(script));
});
