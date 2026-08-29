import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { ErrorRequestHandler, NextFunction, Request, Response } from "express";
import { authenticateHttpRequest, sameIdentity } from "./auth.js";
import type { McpIdentity } from "./config.js";
import type { McpAppContext } from "./context.js";
import { createSorftimeMcpServer } from "./server.js";

interface SessionState {
  id?: string;
  identity: McpIdentity;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastSeenAt: number;
  cleanup(): Promise<void>;
}

export interface RunningHttpServer {
  server: Server;
  close(): Promise<void>;
}

function securityLog(event: "mcp_auth_denied" | "mcp_origin_denied" | "mcp_session_identity_mismatch"): void {
  process.stderr.write(`${JSON.stringify({ level: "warn", event })}\n`);
}

function identityGuard(context: McpAppContext) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const identity = authenticateHttpRequest(context.config, request);
    if (!identity) {
      securityLog("mcp_auth_denied");
      response.setHeader("WWW-Authenticate", "Bearer");
      response.status(401).json({ error: "unauthorized" });
      return;
    }
    response.locals.identity = identity;
    next();
  };
}

function privatePathBearer(request: Request, _response: Response, next: NextFunction): void {
  const token = request.params.privateMcpKey;
  if (typeof token === "string" && !request.header("authorization")) {
    request.headers.authorization = `Bearer ${token}`;
  }
  next();
}

function originGuard(context: McpAppContext) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const origin = request.header("origin");
    if (!origin) return next();
    if (!context.config.http.allowedOrigins.includes(origin)) {
      securityLog("mcp_origin_denied");
      response.status(403).json({ error: "origin_not_allowed" });
      return;
    }
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID, X-Sorftime-Proxy-Secret, X-Company-User, X-Company-Tenant, X-Company-Role");
    response.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    next();
  };
}

function concurrencyGuard(maximum: number) {
  let active = 0;
  return (request: Request, response: Response, next: NextFunction): void => {
    if (request.body?.method !== "tools/call") return next();
    if (active >= maximum) {
      response.status(429).json({ jsonrpc: "2.0", error: { code: -32_001, message: "Server is busy; retry later" }, id: null });
      return;
    }
    active += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      active -= 1;
    };
    response.once("finish", release);
    response.once("close", release);
    next();
  };
}

function rejectJsonRpcBatch(request: Request, response: Response, next: NextFunction): void {
  if (!Array.isArray(request.body)) return next();
  response.status(400).json({
    jsonrpc: "2.0",
    error: { code: -32_600, message: "JSON-RPC batch requests are not supported" },
    id: null,
  });
}

export function startMcpHttpServer(context: McpAppContext): RunningHttpServer {
  const app = createMcpExpressApp({
    host: context.config.http.host,
    ...(context.config.http.allowedHosts.length > 0 ? { allowedHosts: context.config.http.allowedHosts } : {}),
  });
  app.disable("x-powered-by");
  const authenticate = identityGuard(context);
  const checkOrigin = originGuard(context);
  const mcpPaths = ["/mcp", "/:privateMcpKey/mcp"];
  const sessions = new Map<string, SessionState>();
  const activeCleanups = new Set<() => Promise<void>>();
  let initializing = 0;

  const reaper = setInterval(() => {
    const oldest = Date.now() - context.config.http.sessionTtlMs;
    for (const session of sessions.values()) {
      if (session.lastSeenAt < oldest) void session.cleanup();
    }
  }, Math.min(60_000, context.config.http.sessionTtlMs));
  reaper.unref();

  app.get("/healthz", (_request, response) => {
    response.json({ status: "ok", service: "sorftime-governed-mcp", version: "1.0.0", policy: "free_read_only" });
  });
  app.get("/readyz", async (_request, response) => {
    try {
      await context.audit.checkReady();
      response.json({ status: "ready", upstreamConfigured: true, auditConfigured: true });
    } catch {
      response.status(503).json({ status: "not_ready", upstreamConfigured: true, auditConfigured: false });
    }
  });
  app.options(mcpPaths, checkOrigin, (_request, response) => response.status(204).end());

  app.post(mcpPaths, checkOrigin, privatePathBearer, authenticate, rejectJsonRpcBatch, concurrencyGuard(context.config.http.maxConcurrentRequests), async (request, response) => {
    const identity = response.locals.identity as McpIdentity;
    const requestedSessionId = request.header("mcp-session-id");
    let session = requestedSessionId ? sessions.get(requestedSessionId) : undefined;
    try {
      if (session && !sameIdentity(session.identity, identity)) {
        securityLog("mcp_session_identity_mismatch");
        response.status(403).json({ error: "session_identity_mismatch" });
        return;
      }
      if (!session && !requestedSessionId && isInitializeRequest(request.body)) {
        if (sessions.size + initializing >= context.config.http.maxSessions) {
          response.status(503).json({ jsonrpc: "2.0", error: { code: -32_001, message: "Too many active MCP sessions" }, id: null });
          return;
        }
        initializing += 1;
        const mcpServer = createSorftimeMcpServer(context, { identity, transport: "http" });
        const stateRef: { current?: SessionState } = {};
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sessionId) => {
            const current = stateRef.current;
            if (!current) return;
            current.id = sessionId;
            sessions.set(sessionId, current);
          },
        });
        let cleanupPromise: Promise<void> | undefined;
        const cleanup = (): Promise<void> => {
          cleanupPromise ??= (async () => {
            if (state.id) sessions.delete(state.id);
            transport.onclose = undefined;
            await Promise.allSettled([mcpServer.close(), transport.close()]);
            activeCleanups.delete(cleanup);
          })();
          return cleanupPromise;
        };
        const state: SessionState = { identity, server: mcpServer, transport, lastSeenAt: Date.now(), cleanup };
        stateRef.current = state;
        transport.onclose = () => void cleanup();
        activeCleanups.add(cleanup);
        session = state;
        await mcpServer.connect(transport as unknown as Parameters<McpServer["connect"]>[0]);
      }
      if (!session) {
        response.status(requestedSessionId ? 404 : 400).json({ jsonrpc: "2.0", error: { code: -32_000, message: "Invalid or missing MCP session" }, id: null });
        return;
      }
      session.lastSeenAt = Date.now();
      await session.transport.handleRequest(request, response, request.body);
    } catch {
      if (!response.headersSent) response.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      await session?.cleanup();
    } finally {
      initializing = Math.max(0, initializing - 1);
    }
  });

  app.get(mcpPaths, checkOrigin, privatePathBearer, authenticate, async (request, response) => {
    const identity = response.locals.identity as McpIdentity;
    const sessionId = request.header("mcp-session-id");
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session || !sameIdentity(session.identity, identity)) {
      response.status(400).json({ error: "invalid_or_missing_mcp_session" });
      return;
    }
    session.lastSeenAt = Date.now();
    await session.transport.handleRequest(request, response);
  });

  app.delete(mcpPaths, checkOrigin, privatePathBearer, authenticate, async (request, response) => {
    const identity = response.locals.identity as McpIdentity;
    const sessionId = request.header("mcp-session-id");
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session || !sameIdentity(session.identity, identity)) {
      response.status(400).json({ error: "invalid_or_missing_mcp_session" });
      return;
    }
    try {
      await session.transport.handleRequest(request, response);
    } finally {
      await session.cleanup();
    }
  });

  const errors: ErrorRequestHandler = (_error, _request, response, next) => {
    void next;
    if (!response.headersSent) response.status(400).json({ error: "invalid_request" });
  };
  app.use(errors);

  const server = app.listen(context.config.http.port, context.config.http.host, () => {
    process.stderr.write(`${JSON.stringify({ level: "info", event: "mcp_http_started", host: context.config.http.host, port: context.config.http.port, authMode: context.config.http.authMode })}\n`);
  });
  return {
    server,
    close: async () => {
      clearInterval(reaper);
      await Promise.allSettled([...activeCleanups].map((cleanup) => cleanup()));
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
