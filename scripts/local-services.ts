import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
interface LocalServiceChild {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  once(event: "error" | "exit", listener: () => void): unknown;
  kill(): boolean;
}
export interface LocalServiceDependencies {
  readonly checkPort?: (port: number) => Promise<void>;
  readonly launch?: (file: string, environment: NodeJS.ProcessEnv) => LocalServiceChild;
  readonly fetch?: typeof fetch;
}

/** No inherited credentials, Node flags or proxy variables are copied into the mock. */
export function serviceEnvironment(environment: NodeJS.ProcessEnv, ehrToken: string, pharmacyToken: string): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "ComSpec"]) if (environment[key]) safe[key] = environment[key];
  return { ...safe, EHR_API_KEY: ehrToken, PHARMACY_API_KEY: pharmacyToken };
}

/** Supply model configuration only to the agent while retaining paired synthetic service credentials. */
export function agentServiceEnvironment(environment: NodeJS.ProcessEnv, ehrToken: string, pharmacyToken: string): NodeJS.ProcessEnv {
  const selected = serviceEnvironment(environment, ehrToken, pharmacyToken);
  for (const key of ["GROQ_API_KEY", "LLM_MODEL", "REQUEST_TIMEOUT_MS", "LLM_MAX_RETRIES"]) {
    if (environment[key] !== undefined) selected[key] = environment[key];
  }
  return selected;
}

/** Refuse to replace an existing process on a required development port. */
async function requireFreePort(port: number) {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", () => reject(new Error(`Port ${port} is occupied. Stop the existing service, or use it with dev:frontend instead.`)));
    probe.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>(resolve => probe.close(() => resolve()));
}

/** Wait for a child service to become reachable without exposing startup credentials. */
async function ready(port: number, child: LocalServiceChild, stopping: () => boolean, transport: typeof fetch) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (stopping()) return;
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) break;
    try {
      const response = await transport(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
      if (response.ok && (await response.json() as { ok?: unknown }).ok === true) return;
    } catch { /* Startup polling only; never log environment, request or process errors. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`The development service on port ${port} did not start. Check agent configuration; no credentials are shown.`);
}

/** Stop only a development child created by this launcher. */
async function stop(child: LocalServiceChild) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 3000);
    child.once("exit", () => { clearTimeout(timer); resolve(); }); child.kill();
  });
}

/** Run paired synthetic services while keeping the provider key in the agent's normal configuration. */
export async function startLocalServices(
  options: { signal?: AbortSignal; onReady?: () => void } = {}, dependencies: LocalServiceDependencies = {},
) {
  if (options.signal?.aborted) return;
  if (process.env.NODE_ENV === "production") throw new Error("Manual services are for local development only.");
  const checkPort = dependencies.checkPort ?? requireFreePort;
  await checkPort(4010); await checkPort(5050);
  const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  const ehrToken = `synthetic-local-ehr-${randomUUID()}`;
  const pharmacyToken = `synthetic-local-pharmacy-${randomUUID()}`;
  const paired = serviceEnvironment(process.env, ehrToken, pharmacyToken);
  const children: LocalServiceChild[] = [];
  let resolveStop: () => void = () => undefined;
  let stopping = false;
  let unexpectedFailure = false;
  const failure = new Error("A local development service failed unexpectedly. Restart the development stack; no credentials are shown.");
  const stopped = new Promise<void>(resolve => { resolveStop = resolve; });
  /** Wake the launcher so it can clean up every owned child after a stop request. */
  const requestStop = () => { stopping = true; resolveStop(); };
  /** Preserve an unexpected service failure without reclassifying intentional cleanup as a crash. */
  const requestFailure = () => { if (!stopping) { unexpectedFailure = true; requestStop(); } };
  /** Surface a sanitized failure after readiness or shutdown while leaving explicit cancellation successful. */
  const assertNoServiceFailure = () => { if (unexpectedFailure) throw failure; };
  process.once("SIGINT", requestStop); process.once("SIGTERM", requestStop);
  options.signal?.addEventListener("abort", requestStop, { once: true });
  /** Start an existing entry point with explicitly selected, non-inherited service credentials. */
  const launch = (file: string, environment: NodeJS.ProcessEnv) => {
    let child: LocalServiceChild;
    try {
      child = dependencies.launch?.(file, environment) ?? spawn(process.execPath, ["--import", loader, join(root, file)], {
        cwd: root, env: environment, windowsHide: true, stdio: "ignore",
      });
    } catch { requestFailure(); throw failure; }
    child.once("error", requestFailure); child.once("exit", requestFailure); children.push(child); return child;
  };
  try {
    if (options.signal?.aborted) return;
    // The provided mock logs its service tokens, so its output is suppressed and its tokens are synthetic.
    const mock = launch("mock/server.ts", { ...paired, PORT: "4010", DATASET_PATH: join(root, "mock", "dataset.json") });
    await ready(4010, mock, () => stopping, dependencies.fetch ?? fetch);
    assertNoServiceFailure();
    if (stopping) return;
    // Only this existing entry point normally loads .env. Pre-supplied synthetic service values take precedence.
    const agent = launch("agent/start.ts", { ...agentServiceEnvironment(process.env, ehrToken, pharmacyToken), AGENT_PORT: "5050", EHR_BASE_URL: "http://127.0.0.1:4010", PHARMACY_BASE_URL: "http://127.0.0.1:4010" });
    await ready(5050, agent, () => stopping, dependencies.fetch ?? fetch);
    assertNoServiceFailure();
    if (stopping) return;
    console.log("Synthetic mock: http://127.0.0.1:4010 | Existing agent: http://127.0.0.1:5050");
    console.log("Temporary service credentials are paired and hidden. The agent uses your existing local Groq configuration.");
    console.log("Ctrl+C stops both services. Restart this command to restore the synthetic seed and clear agent sessions.");
    options.onReady?.();
    await stopped;
    assertNoServiceFailure();
  } finally {
    requestStop();
    await Promise.all(children.map(stop)); process.off("SIGINT", requestStop); process.off("SIGTERM", requestStop);
    options.signal?.removeEventListener("abort", requestStop);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await startLocalServices(); }
  catch (error) { console.error(error instanceof Error ? error.message : "Local services could not start."); process.exitCode = 1; }
}
