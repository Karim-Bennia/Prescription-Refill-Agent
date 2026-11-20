// Skeleton agent. The conversation endpoint and the EHR/pharmacy clients are wired up; the
// LOGIC is yours to build. You can extend this or replace it entirely with any stack, as long
// as it implements POST /conversations/{id}/messages (see docs/API.md).
//
//   npm run agent      # serves on AGENT_PORT (default 5050)
//
// Where to plug in your reasoning model: your own model + key, read from ENVIRONMENT VARIABLES
// (do not hardcode keys). Disclose the provider/model + the env var names in SUBMISSION.md —
// Artera runs your agent to evaluate it, so it must start from env config alone.

import { createServer } from "node:http";
import { createRuntime } from "./runtime.js";

const { config } = createRuntime(process.env);
const AGENT_PORT = config.agentPort;
const EHR = config.backend.ehrBaseUrl;
const PHARM = config.backend.pharmacyBaseUrl;
const EHR_KEY = config.backend.ehrApiKey;
const PHARM_KEY = config.backend.pharmacyApiKey;

/** Call the EHR service (auth header attached). e.g. ehr("/ehr/time") or
 *  ehr("/ehr/patients:match", { method: "POST", body: JSON.stringify({ factors }) }). */
export const ehr = (path: string, init?: RequestInit) =>
  fetch(`${EHR}${path}`, { ...init, headers: { authorization: `Bearer ${EHR_KEY}`, "content-type": "application/json", ...(init?.headers ?? {}) } });
export const pharmacy = (path: string, init?: RequestInit) =>
  fetch(`${PHARM}${path}`, { ...init, headers: { authorization: `Bearer ${PHARM_KEY}`, "content-type": "application/json", ...(init?.headers ?? {}) } });

// Keep whatever per-conversation state you need, keyed by conversationId.
const conversations = new Map<string, unknown>();

interface AgentReply { messages: { from: "agent"; text: string }[]; state: "in_progress" | "complete" | "escalated"; }

async function handleTurn(conversationId: string, patientText: string): Promise<AgentReply> {
  // TODO: build the agent that handles the patient's refill request. See README.md for the five
  // goals and docs/API.md for the conversation contract, the EHR/pharmacy API, and the clinical
  // rules you must enforce (the EHR will not enforce them for you). Use ehr()/pharmacy() above,
  // and GET /ehr/time as "now".
  void conversationId; void patientText; void conversations;
  return {
    messages: [{ from: "agent", text: "Agent not implemented yet. See agent/server.ts and docs/API.md." }],
    state: "in_progress",
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz") { res.writeHead(200, { "content-type": "application/json" }); return res.end(`{"ok":true}`); }
  const m = url.pathname.match(/^\/conversations\/([^/]+)\/messages$/);
  if (m && req.method === "POST") {
    let raw = ""; for await (const ch of req) raw += ch;
    const body = raw ? JSON.parse(raw) : {};
    const reply = await handleTurn(m[1], String(body.text ?? ""));
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(reply));
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(`{"error":"not found"}`);
});

server.on("error", () => { console.error("Agent listener failed."); process.exitCode = 1; });
server.listen(AGENT_PORT, "127.0.0.1", () => console.log(`agent (skeleton) on http://127.0.0.1:${AGENT_PORT}`));
