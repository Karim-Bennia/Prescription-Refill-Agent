import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve, join } from "node:path";
import { summarizeApplicationCoverage } from "../scripts/coverage-reporter.mjs";

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
