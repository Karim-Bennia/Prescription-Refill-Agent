import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve, join } from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { nativeCoverageExclusions, summarizeApplicationCoverage } from "../scripts/coverage-reporter.mjs";

const root = resolve("synthetic-coverage-root");
const record = (path, covered, total) => ({ path,
  coveredLineCount: covered, totalLineCount: total,
  coveredBranchCount: covered, totalBranchCount: total,
  coveredFunctionCount: covered, totalFunctionCount: total,
  // The summary must derive its result from counters, even if percentages are misleading.
  coveredLinePercent: 100, coveredBranchPercent: 100, coveredFunctionPercent: 100,
});

test("application coverage excludes support/dependency/outside paths and weights native counters", () => {
  const summary = summarizeApplicationCoverage([
    { ...record(join(root, "agent", "small.ts"), 1, 1), coveredBranchCount: 1, totalBranchCount: 2,
      coveredFunctionCount: 0, totalFunctionCount: 1 },
    { ...record(join(root, "agent", "domain", "large.ts"), 0, 99), coveredBranchCount: 2, totalBranchCount: 8,
      coveredFunctionCount: 2, totalFunctionCount: 4 },
    record(join(root, "tests", "large.test.ts"), 1000, 1000),
    record(join(root, "mock", "server.ts"), 1000, 1000),
    record(join(root, "scripts", "report.mjs"), 1000, 1000),
    record(join(root, "agent", "node_modules", "dependency.ts"), 1000, 1000),
    record(join(root, "agent-elsewhere", "unrelated.ts"), 1000, 1000),
    record(join(root, "..", "agent", "outside.ts"), 1000, 1000),
    record(join(root, "agent", "types.d.ts"), 1000, 1000),
    record("agent/relative.ts", 1000, 1000),
  ], root);
  assert.equal(summary.fileCount, 2);
  assert.deepEqual(summary.line, { covered: 1, total: 100, percent: 1 });
  assert.deepEqual(summary.branch, { covered: 3, total: 10, percent: 30 });
  assert.deepEqual(summary.function, { covered: 2, total: 5, percent: 40 });
  assert.equal(summary.statementCoverage, "not available from native reporter");
});

test("empty coverage stays unmeasured and invalid native counters cannot fabricate percentages", () => {
  const empty = summarizeApplicationCoverage([], root);
  assert.equal(empty.fileCount, 0);
  assert.equal(empty.line.percent, null);
  assert.equal(empty.branch.percent, null);
  assert.equal(empty.function.percent, null);
  for (const bad of [record(join(root, "agent", "bad.ts"), 2, 1), record(join(root, "agent", "bad.ts"), -1, 1),
    record(join(root, "agent", "bad.ts"), NaN, 1)]) {
    assert.throws(() => summarizeApplicationCoverage([bad], root), /Invalid native coverage counters/);
  }
});

test("native coverage collects application sources beneath a directory named test", async t => {
  // Arrange: Node 24's default test-path coverage exclusion also matches checkout parents named test.
  const fixture = await mkdtemp(join(tmpdir(), "artera-native-coverage-"));
  assert.ok(resolve(fixture).startsWith(`${resolve(tmpdir())}\\`) || resolve(fixture).startsWith(`${resolve(tmpdir())}/`));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const project = join(fixture, "test", "project");
  await mkdir(join(project, "agent"), { recursive: true }); await mkdir(join(project, "tests"), { recursive: true });
  const source = join(project, "agent", "sample.ts");
  const target = join(project, "tests", "sample.test.mjs");
  const reporter = join(project, "reporter.mjs");
  await writeFile(source, "export const sample = () => 42;\n");
  await writeFile(target, "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { sample } from '../agent/sample.ts'; test('sample', () => assert.equal(sample(), 42));\n");
  await writeFile(reporter, "export default async function* (events) { for await (const event of events) if (event.type === 'test:coverage') yield JSON.stringify(event.data.summary.files.map(file => ({path:file.path,lines:file.totalLineCount}))) + '\\n'; }\n");
  // Act: the native reporter, not manufactured counter fixtures, must observe the imported application file.
  const environment = {};
  for (const name of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "ComSpec"]) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  // Do not inherit NODE_TEST_CONTEXT: the independently launched native runner is not a worker of this test.
  const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", loader, "--test", "--experimental-test-coverage", ...nativeCoverageExclusions(),
    `--test-reporter=${pathToFileURL(reporter).href}`, target], { cwd: project, env: environment, windowsHide: true, maxBuffer: 1_048_576 });
  // Assert
  const files = JSON.parse(stdout.trim());
  assert.ok(files.some(file => resolve(file.path) === resolve(source) && file.lines > 0), "Native coverage silently excluded application code under a parent named test.");
});
