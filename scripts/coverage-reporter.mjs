import { tap } from "node:test/reporters";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const excludedDirectories = new Set(["tests", "mock", "scripts", "node_modules"]);

/** Restore native coverage beneath test-named checkout directories when the runtime supports explicit exclusions. */
export function nativeCoverageExclusions() {
  return process.allowedNodeEnvironmentFlags.has("--test-coverage-exclude")
    ? ["--test-coverage-exclude=**/node_modules/**"] : [];
}

/** Restrict application coverage to TypeScript implementation files inside the repository's agent directory. */
function isApplicationFile(path, root) {
  if (typeof path !== "string" || !isAbsolute(path)) return false;
  const withinRepository = relative(root, resolve(path));
  if (!withinRepository || isAbsolute(withinRepository)) return false;
  const segments = withinRepository.split(sep);
  return segments[0] === "agent" && segments.length > 1
    && !segments.some(segment => segment === ".." || excludedDirectories.has(segment))
    && withinRepository.endsWith(".ts") && !withinRepository.endsWith(".d.ts");
}

/** Validate and extract native coverage counters without accepting impossible or unsafe totals. */
function counter(file, coveredKey, totalKey) {
  const covered = file[coveredKey];
  const total = file[totalKey];
  if (!Number.isSafeInteger(covered) || !Number.isSafeInteger(total) || covered < 0 || covered > total) {
    throw new Error("Invalid native coverage counters.");
  }
  return { covered, total };
}

/** Sum native counters rather than averaging percentages from differently sized modules. */
export function summarizeApplicationCoverage(files, root = repositoryRoot) {
  const totals = { line: { covered: 0, total: 0 }, branch: { covered: 0, total: 0 }, function: { covered: 0, total: 0 } };
  let fileCount = 0;
  for (const file of files) {
    if (!isApplicationFile(file.path, resolve(root))) continue;
    const counts = {
      line: counter(file, "coveredLineCount", "totalLineCount"),
      branch: counter(file, "coveredBranchCount", "totalBranchCount"),
      function: counter(file, "coveredFunctionCount", "totalFunctionCount"),
    };
    for (const metric of Object.keys(totals)) {
      totals[metric].covered += counts[metric].covered;
      totals[metric].total += counts[metric].total;
      if (!Number.isSafeInteger(totals[metric].covered) || !Number.isSafeInteger(totals[metric].total)) {
        throw new Error("Native coverage totals exceed safe integer bounds.");
      }
    }
    fileCount++;
  }
  return {
    scope: "collected agent/**/*.ts files only",
    fileCount,
    ...Object.fromEntries(Object.entries(totals).map(([metric, count]) => [metric, {
      ...count, percent: count.total === 0 ? null : Number((100 * count.covered / count.total).toFixed(2)),
    }])),
    statementCoverage: "not available from native reporter",
  };
}

/** Preserve Node's TAP/all-files report and append a separately labelled application summary. */
export default async function* coverageReporter(source) {
  let summary;
  /** Capture application coverage while forwarding every native event to the standard TAP reporter. */
  async function* collect() {
    for await (const event of source) {
      if (event.type === "test:coverage") summary = summarizeApplicationCoverage(event.data.summary.files);
      yield event;
    }
  }
  yield* tap(collect());
  if (summary) yield `# application-only-coverage ${JSON.stringify(summary)}\n`;
}
