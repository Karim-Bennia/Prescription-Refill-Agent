import { existsSync } from "node:fs";

// Called only by executable entry points, never by domain modules or unit tests.
// Node preserves variables already supplied by the caller. No child mock is spawned.
export function loadLocalEnvironment(): void {
  if (!existsSync(".env")) return;
  try { process.loadEnvFile(".env"); }
  catch { throw new Error("Local environment file could not be loaded."); }
}
