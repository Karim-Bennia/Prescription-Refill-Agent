import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { conversationIdSchema, replySchema, requestSchema } from "../agent/validation.js";

const AGENT = "http://127.0.0.1:5050";
const MOCK = "http://127.0.0.1:4010";
const MAX_REQUEST_BYTES = 16_384;
const MAX_RESPONSE_BYTES = 262_144;
const assets = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/styles.css", { file: "app.css", type: "text/css; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
]);
const agentErrors = new Set(["invalid request", "method not allowed", "not found", "request too large", "request timed out", "service unavailable"]);
class BodyError extends Error {
  /** Carry only a public transport status without retaining request contents. */
  constructor(readonly status: number) { super("Invalid frontend request."); }
}

/** Return an explicit JSON response without reflecting internal exception details. */
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body));
}

/** Bound incoming bytes and time before decoding the public patient-message contract. */
function readPatientBody(req: IncomingMessage, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0; let settled = false; const chunks: Buffer[] = [];
    // Settle once and detach request listeners without retaining patient contents.
    const finish = (error?: BodyError, value?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      req.off("data", data); req.off("end", end); req.off("error", broken); req.off("aborted", broken);
      chunks.length = 0;
      if (error) { req.resume(); reject(error); } else resolve(value);
    };
    // Refuse oversized streaming bodies before any upstream operation.
    const data = (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_REQUEST_BYTES) finish(new BodyError(413)); else chunks.push(chunk);
    };
    // Decode only a complete bounded UTF-8 request body.
    const end = () => {
      try { finish(undefined, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown); }
      catch { finish(new BodyError(400)); }
    };
    // Treat disconnected or aborted uploads as invalid requests.
    const broken = () => finish(new BodyError(400));
    const timer = setTimeout(() => finish(new BodyError(408)), timeoutMs);
    req.on("data", data); req.once("end", end); req.once("error", broken); req.once("aborted", broken);
    if (Number(req.headers["content-length"]) > MAX_REQUEST_BYTES) finish(new BodyError(413));
  });
}

/** Bound upstream response memory before parsing potentially malformed service data. */
async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new Error("Missing response.");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; if (size > MAX_RESPONSE_BYTES) throw new Error("Response too large.");
      chunks.push(part.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export interface FrontendServerOptions { fetch?: typeof fetch; upstreamTimeoutMs?: number; bodyTimeoutMs?: number }

/** Development transport only: no credential loading, clinical logic, sessions, or upstream tools. */
export function createFrontendServer(options: FrontendServerOptions = {}) {
  const transport = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.upstreamTimeoutMs ?? 90_000;
  const bodyTimeoutMs = options.bodyTimeoutMs ?? 5000;
  if (![timeoutMs, bodyTimeoutMs].every(value => Number.isInteger(value) && value > 0 && value <= 120_000)) throw new Error("Invalid tester timeout.");
  // Probe only a fixed configured local service, without inherited request credentials.
  const health = async (origin: string) => {
    try {
      const response = await transport(`${origin}/healthz`, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(2000) });
      const body = await readJson(response);
      return { ok: response.ok && !!body && typeof body === "object" && "ok" in body && body.ok === true, status: response.status };
    } catch { return { ok: false, status: null }; }
  };
  return createServer({ headersTimeout: 10_000, requestTimeout: 20_000, connectionsCheckingInterval: 1000 }, (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    // Dispatch only allowlisted static, health, and exact conversation proxy routes.
    const run = async () => {
      const host = `127.0.0.1:${req.socket.localPort}`;
      if (req.headers.host !== host || (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`)
        || req.headers["sec-fetch-site"] === "cross-site") {
        req.resume(); json(res, 403, { error: "Only this localhost interface may use the tester." }); return;
      }
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (url.search) { req.resume(); json(res, 404, { error: "Not found." }); return; }
      const asset = assets.get(url.pathname);
      if (asset && req.method === "GET") {
        const content = await readFile(new URL(`dist/${asset.file}`, import.meta.url));
        res.writeHead(200, { "content-type": asset.type }); res.end(content); return;
      }
      if (url.pathname === "/healthz" && req.method === "GET") { json(res, 200, { ok: true }); return; }
      if (url.pathname === "/status" && req.method === "GET") {
        const [agent, mock] = await Promise.all([health(AGENT), health(MOCK)]);
        json(res, 200, { agent, mock }); return;
      }
      const route = /^\/conversations\/([^/]+)\/messages$/u.exec(url.pathname);
      if (!route) { req.resume(); json(res, 404, { error: "Not found." }); return; }
      if (req.method !== "POST") { req.resume(); res.setHeader("allow", "POST"); json(res, 405, { error: "Use POST for patient messages." }); return; }
      if (!/^application\/json(?:\s*;|$)/iu.test(req.headers["content-type"] ?? "")) { req.resume(); json(res, 415, { error: "Patient messages require application/json." }); return; }
      let id: string;
      try { id = decodeURIComponent(route[1]); } catch { json(res, 400, { error: "Invalid conversation identifier." }); return; }
      if (!conversationIdSchema.safeParse(id).success) { req.resume(); json(res, 400, { error: "Invalid conversation identifier." }); return; }
      let input: unknown;
      try { input = await readPatientBody(req, bodyTimeoutMs); }
      catch (error) { json(res, error instanceof BodyError ? error.status : 400, { error: "Invalid, oversized or incomplete message." }); return; }
      const parsed = requestSchema.safeParse(input);
      if (!parsed.success) { json(res, 400, { error: "Use {from: patient, text: a message of 1–4000 characters}." }); return; }

      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        // Construct this request afresh: never forward cookies, Authorization, Origin or arbitrary URLs.
        // A conversation POST is sent once only. The application owns patient authorization and mutations.
        const response = await transport(`${AGENT}/conversations/${encodeURIComponent(id)}/messages`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(parsed.data),
          redirect: "error", cache: "no-store", signal: controller.signal,
        });
        const body = await readJson(response);
        if (response.ok && replySchema.safeParse(body).success) { json(res, response.status, body); return; }
        if (!response.ok && body && typeof body === "object" && Object.keys(body).length === 1
          && "error" in body && typeof body.error === "string" && agentErrors.has(body.error)) {
          json(res, response.status, body); return;
        }
        json(res, 502, { error: "The agent returned an invalid response. Check the agent terminal before resending.", outcome: "unknown" });
      } catch {
        json(res, controller.signal.aborted ? 504 : 502, {
          error: controller.signal.aborted
            ? "The agent response timed out. An action may already have been processed; verify before resending."
            : "The agent could not be reached or its response was interrupted. Check npm run agent and the mock, and verify any pending action before resending.",
          outcome: "unknown",
        });
      } finally { clearTimeout(timer); }
    };
    void run().catch(() => { if (!res.headersSent) json(res, 500, { error: "The local tester could not process this request." }); else res.end(); });
  });
}
