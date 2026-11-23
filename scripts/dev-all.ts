import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { Server } from "node:http";
import { startFrontend } from "../frontend/start.js";
import { startLocalServices } from "./local-services.js";

/** Start the React interface and paired mock/agent, then clean up all owned services together. */
export async function runDevelopment(options: { signal?: AbortSignal; onReady?: () => void } = {}) {
  const controller = new AbortController(); let frontend: Server | undefined;
  /** Propagate a requested shutdown to every owned development service. */
  const shutdown = () => controller.abort();
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
  options.signal?.addEventListener("abort", shutdown, { once: true });
  try {
    if (options.signal?.aborted) return;
    frontend = await startFrontend();
    frontend.once("close", shutdown); frontend.once("error", shutdown);
    await startLocalServices({ signal: controller.signal, onReady: () => {
      console.log("All services ready. Open http://127.0.0.1:5173. Ctrl+C stops this development stack.");
      options.onReady?.();
    } });
  } finally {
    controller.abort();
    if (frontend?.listening) {
      frontend.closeAllConnections();
      await new Promise<void>(resolve => frontend!.close(() => resolve()));
    }
    process.off("SIGINT", shutdown); process.off("SIGTERM", shutdown);
    options.signal?.removeEventListener("abort", shutdown);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await runDevelopment(); }
  catch (error) { console.error(error instanceof Error ? error.message : "Development startup failed."); process.exitCode = 1; }
}
