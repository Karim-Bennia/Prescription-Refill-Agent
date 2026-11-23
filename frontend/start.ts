import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createFrontendServer } from "./server.js";
import { buildFrontend } from "./build.js";

/** Build and bind the local frontend to its documented loopback port without loading credentials. */
export async function startFrontend() {
  await buildFrontend();
  const server = createFrontendServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(5173, "127.0.0.1", resolve);
  });
  console.log("React frontend: http://127.0.0.1:5173");
  console.log("Existing agent: http://127.0.0.1:5050 | Mock health: http://127.0.0.1:4010");
  console.log("Synthetic local development only. No credentials or patient messages are logged here.");
  return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await startFrontend(); }
  catch { console.error("Frontend startup failed. Ensure 127.0.0.1:5173 is free and npm dependencies are installed."); process.exitCode = 1; }
}
