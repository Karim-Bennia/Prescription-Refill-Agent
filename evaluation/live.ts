import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { loadConfig, ConfigurationError } from "../agent/config.js";
import { loadLocalEnvironment } from "../agent/local-env.js";
import { GroqLanguageInterpreter } from "../agent/llm-client.js";
import type { LanguageInterpreter } from "../agent/intent.js";
import { LiveEvaluationObserver, latencySummary } from "./live-observer.js";
import { buildLiveScenarios, liveDatasetSchema } from "./live-scenarios.js";
import { runMockScenario, LiveRunnerError, type LiveScenarioResult } from "./live-runner.js";
import { redactReport, scoreModelProposal, summarizeModelScores } from "./live-report.js";
import { assessLiveProvider } from "./live-validation.js";

export const LIVE_MODEL = "openai/gpt-oss-120b";
export class LivePreflightError extends Error {
  /** Represent a sanitized opt-in, credential-rotation, runtime or model preflight blocker. */
  constructor(readonly code: "arguments" | "rotation_unconfirmed" | "runtime" | "model") {
    super(`Live evaluation blocked (${code}).`); this.name = "LivePreflightError";
  }
}

// The flag is human acknowledgement, not independent evidence that the provider revoked an old key.
/** Validate evaluation opt-in, rotation acknowledgement and runtime before loading credentials. */
export function liveMode(args: readonly string[], version: string): "list" | "run" {
  if (args.length === 1 && args[0] === "--list") return "list";
  if (args.some(arg => arg !== "--confirm-rotated-key") || args.length > 1) throw new LivePreflightError("arguments");
  if (!args.includes("--confirm-rotated-key")) throw new LivePreflightError("rotation_unconfirmed");
  if (!/^v24\./u.test(version)) throw new LivePreflightError("runtime");
  return "run";
}

/** Run opt-in isolated live conversations and persist only sanitized reproducible evaluation evidence. */
export async function main(args: readonly string[]): Promise<void> {
  const mode = liveMode(args, process.version);
  const dataset = liveDatasetSchema.parse(JSON.parse(readFileSync(new URL("../mock/dataset.json", import.meta.url), "utf8")));
  const scenarios = buildLiveScenarios(dataset);
  if (mode === "list") {
    console.log(JSON.stringify({ mode: "plan_only", liveRequests: 0,
      scenarios: scenarios.map(({ id, title, notes }) => ({ id, title, notes })) }, null, 2));
    return;
  }

  // Normal runtime loading only after opt-in and rotation acknowledgement; never inspect the file.
  loadLocalEnvironment();
  const config = loadConfig({ ...process.env,
    EHR_API_KEY: "synthetic-unused-preflight-ehr", PHARMACY_API_KEY: "synthetic-unused-preflight-pharmacy" });
  if (config.groq.model !== LIVE_MODEL) throw new LivePreflightError("model");
  // Reserve one additional call for the separately executed existing smoke:groq command.
  const observer = new LiveEvaluationObserver({ maxRequests: 39, minIntervalMs: 2000, expectedModel: LIVE_MODEL });
  const provider = observer.wrap(new GroqLanguageInterpreter({ ...config.groq, maxRetries: 0 }, { fetch: observer.fetch }));
  const results: LiveScenarioResult[] = [];
  const labels: { scenarioId: string; turnIndex: number; score: ReturnType<typeof scoreModelProposal> }[] = [];
  const missedLabels: { scenarioId: string; turnIndex: number }[] = [];
  let runnerFailure: string | null = null;
  for (const scenario of scenarios) {
    if (observer.stopReason) break;
    let activeTurn = -1;
    const scored = new Set<number>();
    const interpreter: LanguageInterpreter = {
      /** Score an actual validated model proposal against the current synthetic turn label. */
      interpret: async text => {
        const proposal = await provider.interpret(text);
        const expected = scenario.modelExpected.find(label => label.turnIndex === activeTurn);
        if (expected && !scored.has(activeTurn)) {
          labels.push({ scenarioId: scenario.id, turnIndex: activeTurn, score: scoreModelProposal(expected, proposal) });
          scored.add(activeTurn);
        }
        return proposal;
      }
    };
    try {
      const result = await runMockScenario(scenario, {
        interpreter,
        /** Bind subsequent interpretation metrics to the active conversation turn index. */
        onTurnStart: index => { activeTurn = index; }
      });
      results.push(result);
      console.log(JSON.stringify({ scenario: scenario.id, passed: result.passed, state: result.finalState,
        refillPosts: result.effects.refillPosts, pharmacyUpdates: result.effects.pharmacyUpdates }));
    } catch (error) {
      runnerFailure = error instanceof LiveRunnerError ? error.code : "unexpected";
      break;
    } finally {
      for (const label of scenario.modelExpected) {
        if (!scored.has(label.turnIndex)) missedLabels.push({ scenarioId: scenario.id, turnIndex: label.turnIndex });
      }
    }
  }
  const providerSummary = observer.summary();
  const providerValidation = assessLiveProvider(observer.requests(), observer.interpretations());
  const plannedLabels = scenarios.reduce((sum, scenario) => sum + scenario.modelExpected.length, 0);
  const complete = runnerFailure === null && results.length === scenarios.length
    && !observer.stopReason && providerValidation.passed && labels.length === plannedLabels;
  const backendTotals = {
    refillPosts: results.reduce((sum, result) => sum + result.effects.refillPosts, 0),
    pharmacyUpdates: results.reduce((sum, result) => sum + result.effects.pharmacyUpdates, 0),
    clinicallyBlockedRefillPosts: results.filter(result => scenarios.find(scenario => scenario.id === result.scenarioId)?.expectations.policyReason)
      .reduce((sum, result) => sum + result.effects.refillPosts, 0),
    unexpectedRefillPosts: results.reduce((sum, result) => sum + Math.max(0, result.effects.refillPosts
      - scenarios.find(scenario => scenario.id === result.scenarioId)!.expectations.refills), 0),
  };
  const report = redactReport({
    mode: "live_groq", recordedAt: new Date().toISOString(), node: process.version,
    provider: "Groq", model: LIVE_MODEL, credentialRotation: "human_acknowledged",
    settings: { temperature: 0, maxCompletionTokens: 2048, reasoningEffort: "low", reasoningFormat: "hidden",
      requestTimeoutMs: config.groq.timeoutMs, modelRetries: 0, minIntervalMs: 2000, maxHarnessRequests: 39, separateSmokeBudget: 1 },
    complete, plannedScenarios: scenarios.length, executedScenarios: results.length,
    passedScenarios: results.filter(result => result.passed).length,
    runnerFailure, backendEvidence: { scope: "completed scenarios only", countedScenarios: results.length,
      partialScenarioEffects: runnerFailure ? "unknown; excluded from totals" : "none" },
    backendTotals, observer: providerSummary, providerValidation, requests: observer.requests(), interpretations: observer.interpretations(),
    labels, missedLabels, modelScores: summarizeModelScores(labels.map(label => label.score), plannedLabels),
    turnLatency: latencySummary(results.flatMap(result => result.transcript.map(turn => turn.elapsedMs))),
    results,
    limitations: ["Small synthetic sample; label agreement is not population accuracy.",
      "Mock request logs alone are not authoritative upstream transaction reconciliation.",
      "Caller ownership, durable/global deduplication, and atomic clinical/write semantics remain unsupported.",
      "Existing deterministic fault tests are separate evidence from live provider behavior."],
  }, [config.groq.apiKey, process.env.EHR_API_KEY, process.env.PHARMACY_API_KEY].filter((value): value is string => Boolean(value)));
  const directory = fileURLToPath(new URL("results/", import.meta.url));
  mkdirSync(directory, { recursive: true });
  const path = resolve(directory, `live-${Date.now()}-${randomUUID()}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  // POSIX mode is advisory on Windows; this generated synthetic report has no patient production data.
  console.log(`Sanitized evaluation report: ${path}`);
  if (!complete || results.some(result => !result.passed)) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    if (error instanceof LivePreflightError || error instanceof ConfigurationError) console.error(error.message);
    else console.error("Live evaluation failed during setup; no raw error details retained.");
    process.exitCode = 1;
  }
}
