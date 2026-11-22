import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The ordinary test command remains the single source of truth for test discovery on Windows.
const root = new URL("../", import.meta.url);
const { scripts } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const prefix = "tsx --test ";
if (!scripts.test.startsWith(prefix)) throw new Error("Unsupported test command; update coverage runner.");
const files = scripts.test.slice(prefix.length).split(/\s+/);
if (!files.length || !files.every(file => /^tests\/[A-Za-z0-9.-]+\.test\.(?:ts|mjs)$/.test(file))) {
  throw new Error("Unexpected test paths.");
}
// An absolute Windows drive path is not a valid ESM specifier; a file URL works on all hosts.
const reporter = new URL("scripts/coverage-reporter.mjs", root).href;
const child = spawn(process.execPath, ["--import", "tsx", "--test", "--experimental-test-coverage", `--test-reporter=${reporter}`, ...files], {
  cwd: fileURLToPath(root), stdio: "inherit", windowsHide: true,
});
child.once("error", () => { console.error("Coverage runner failed to start."); process.exitCode = 1; });
child.once("exit", code => { process.exitCode = code ?? 1; });
