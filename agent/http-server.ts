import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { requestSchema, replySchema, parseConversationId, type AgentReply } from "./validation.js";
import type { HttpObservation } from "./observability.js";

export interface TurnHandler {
  handleTurn(conversationId: string, text: string): Promise<AgentReply>;
}

interface HttpServerOptions {
  bodyTimeoutMs?: number;
  observe?: (event: HttpObservation) => void | Promise<void>;
}

const MAX_BODY_BYTES = 16_384;

class RequestError extends Error {
  constructor(readonly status: 400 | 408 | 413) { super("Request rejected."); }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...(status === 408 || status === 413 ? { connection: "close" } : {}),
  });
  res.end(JSON.stringify(body));
}

function readRequestBody(req: IncomingMessage, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (failure?: RequestError, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onError);
      chunks.length = 0;
      if (failure) {
        // Drain without buffering so the response can be sent without retaining input.
        req.resume();
        reject(failure);
      } else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) finish(new RequestError(413));
      else chunks.push(chunk);
    };
    const onEnd = () => {
      try {
        const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
        finish(undefined, JSON.parse(raw) as unknown);
      } catch { finish(new RequestError(400)); }
    };
    const onError = () => finish(new RequestError(400));
    const timer = setTimeout(() => finish(new RequestError(408)), timeoutMs);
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onError);
    if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) finish(new RequestError(413));
  });
}

export function createAgentServer(handler: TurnHandler, options: HttpServerOptions = {}): Server {
  const bodyTimeoutMs = options.bodyTimeoutMs ?? 10_000;
  if (!Number.isInteger(bodyTimeoutMs) || bodyTimeoutMs <= 0 || bodyTimeoutMs > 60_000) {
    throw new Error("Invalid HTTP request timeout configuration.");
  }
  const server = createServer({
    // Leave header parsing + the application body timer time to return its JSON error.
    // The native whole-request fallback must not race that earlier, schema-preserving deadline.
    requestTimeout: bodyTimeoutMs * 3 + 1000,
    headersTimeout: bodyTimeoutMs,
    // Node otherwise scans incomplete headers every 30 seconds, regardless of a shorter deadline.
    connectionsCheckingInterval: Math.min(1000, bodyTimeoutMs),
  }, (req, res) => {
    const requestId = randomUUID();
    const started = performance.now();
    let isHealth = false;
    res.setHeader("x-request-id", requestId);
    res.once("finish", () => {
      const status = res.statusCode;
      const category: HttpObservation["category"] = status === 400 ? "invalid_request"
        : status === 404 ? "not_found" : status === 405 ? "method_not_allowed"
        : status === 408 ? "body_timeout" : status === 413 ? "request_too_large"
        : status >= 500 ? "service_unavailable" : isHealth ? "health" : "conversation";
      try {
        void Promise.resolve(options.observe?.({ event: "http_request", requestId, status, category,
          durationMs: Math.max(0, Math.round(performance.now() - started)) })).catch(() => undefined);
      } catch { /* Diagnostics must never change the response or expose an observer error. */ }
    });
    const processRequest = async () => {
      let pathname: string;
      try { pathname = new URL(req.url ?? "/", "http://localhost").pathname; }
      catch { sendJson(res, 400, { error: "invalid request" }); return; }

      if (pathname === "/healthz") {
        isHealth = true;
        if (req.method !== "GET") {
          res.setHeader("allow", "GET");
          sendJson(res, 405, { error: "method not allowed" });
        } else sendJson(res, 200, { ok: true });
        return;
      }

      const route = /^\/conversations\/([^/]*)\/messages$/.exec(pathname);
      if (!route) { sendJson(res, 404, { error: "not found" }); return; }
      let conversationId: string;
      try { conversationId = parseConversationId(decodeURIComponent(route[1])); }
      catch { sendJson(res, 400, { error: "invalid request" }); return; }
      if (req.method !== "POST") {
        res.setHeader("allow", "POST");
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }

      let body: unknown;
      try { body = await readRequestBody(req, bodyTimeoutMs); }
      catch (error) {
        const status = error instanceof RequestError ? error.status : 400;
        sendJson(res, status, { error: status === 413 ? "request too large" : status === 408 ? "request timed out" : "invalid request" });
        return;
      }
      const parsed = requestSchema.safeParse(body);
      if (!parsed.success) { sendJson(res, 400, { error: "invalid request" }); return; }

      try {
        const reply = replySchema.safeParse(await handler.handleTurn(conversationId, parsed.data.text));
        if (!reply.success) { sendJson(res, 503, { error: "service unavailable" }); return; }
        sendJson(res, 200, reply.data);
      } catch {
        sendJson(res, 503, { error: "service unavailable" });
      }
    };
    void processRequest().catch(() => sendJson(res, 503, { error: "service unavailable" }));
  });
  server.keepAliveTimeout = 5000;
  return server;
}
