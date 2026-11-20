import { createAgentServer } from "./http-server.js";
import { createRuntime } from "./runtime.js";

// Executable composition only; factories have no listen or model/network side effects.
const { config, engine } = createRuntime(process.env);
const server = createAgentServer(engine);
server.on("error", () => { console.error("Agent listener failed."); process.exitCode = 1; });
server.listen(config.agentPort, "127.0.0.1", () => {
  console.log(`agent on http://127.0.0.1:${config.agentPort}`);
});
