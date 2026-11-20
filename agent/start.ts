import { ConfigurationError } from "./config.js";
import { loadLocalEnvironment } from "./local-env.js";

try {
  loadLocalEnvironment();
  await import("./server.js");
} catch (error) {
  console.error(error instanceof ConfigurationError ? error.message : "Agent startup failed.");
  process.exitCode = 1;
}
