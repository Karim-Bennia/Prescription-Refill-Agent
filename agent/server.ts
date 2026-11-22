import { createAgentServer } from "./http-server.js";
import { createApplicationRuntime } from "./runtime.js";
import { createSafeHttpObserver } from "./observability.js";

// Executable composition only; factories have no listen or model/network side effects.
const { config, engine } = createApplicationRuntime(process.env);
const server = createAgentServer(engine, { observe: createSafeHttpObserver() });
server.on("error", () => { console.error("Agent listener failed."); process.exitCode = 1; });
server.listen(config.agentPort, "127.0.0.1", () => {
  console.log(`agent on http://127.0.0.1:${config.agentPort}`);
});
