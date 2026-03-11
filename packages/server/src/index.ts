import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import express from "express";
import type { Request, Response, RequestHandler } from "express";
import { accessSync, constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "./db/schema.js";
import { buildQueries } from "./db/queries.js";
import { createAuthMiddleware, isMcpAuthConfigured } from "./middleware/auth.js";
import { registerSearchTool } from "./tools/search.js";
import { registerGetDocTool } from "./tools/get-doc.js";
import { registerLookupTool } from "./tools/lookup-hook.js";
import { registerValidateTool } from "./tools/validate.js";
import { registerAnswerQuestionTool } from "./tools/answer-question.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";
import { createAdminRouter } from "./admin/router.js";
import { isAdminPasswordConfigured } from "./admin/session.js";

const isProduction = process.env["NODE_ENV"] === "production";
const mcpToken = process.env["MCP_AUTH_TOKEN"]?.trim() ?? "";
const adminPassword = process.env["ADMIN_PASSWORD"]?.trim() ?? "";

// ── Host allowlist and startup contract ──────────────────────────────────────
function normalizeAllowedHost(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Accept full URLs in env vars and convert them to host[:port].
  if (trimmed.includes("://")) {
    try {
      return new URL(trimmed).host.toLowerCase();
    } catch {
      return null;
    }
  }

  const withoutScheme = trimmed.replace(/^https?:\/\//i, "");
  const host = withoutScheme.split("/")[0]?.trim().toLowerCase() ?? "";
  return host.length > 0 ? host : null;
}

const allowedHostSet = new Set<string>();
for (const rawHost of (process.env["ALLOWED_HOSTS"] ?? "").split(",")) {
  const normalized = normalizeAllowedHost(rawHost);
  if (normalized) allowedHostSet.add(normalized);
}
for (const railwayHost of [
  process.env["RAILWAY_PUBLIC_DOMAIN"] ?? "",
  process.env["RAILWAY_PRIVATE_DOMAIN"] ?? "",
]) {
  const normalized = normalizeAllowedHost(railwayHost);
  if (normalized) allowedHostSet.add(normalized);
}
for (const probeHost of ["localhost", "127.0.0.1", "[::1]"]) {
  allowedHostSet.add(probeHost);
}
const allowedHosts = [...allowedHostSet];

if (isProduction) {
  const missing: string[] = [];
  if (!mcpToken) missing.push("MCP_AUTH_TOKEN");
  if (!adminPassword) missing.push("ADMIN_PASSWORD");
  if (allowedHosts.length === 0) missing.push("ALLOWED_HOSTS");
  if (missing.length > 0) {
    throw new Error(`[startup] Missing required production env vars: ${missing.join(", ")}`);
  }
}

if (!isMcpAuthConfigured()) {
  console.warn("[auth] MCP_AUTH_TOKEN is not set — MCP endpoint is unauthenticated.");
}
if (!isAdminPasswordConfigured()) {
  console.warn("[admin] ADMIN_PASSWORD is not set — admin login is disabled.");
}

// ── Database ────────────────────────────────────────────────────────────────
const volumePath = process.env["RAILWAY_VOLUME_MOUNT_PATH"] ?? "./data";
const dbPath = join(volumePath, "wordpress.db");
console.log(`[db] Opening database at ${dbPath}`);

const db = openDatabase(dbPath);
const queries = buildQueries(db);
const stats = queries.stats();
console.log(`[db] Ready — ${stats.total.toLocaleString()} documents indexed`);

function isDatabaseReady(): { ok: boolean; error?: string } {
  try {
    db.prepare("SELECT 1").get();
    accessSync(volumePath, fsConstants.W_OK);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// ── Express app ──────────────────────────────────────────────────────────────
const app = createMcpExpressApp({
  host: "0.0.0.0",
});

let inFlightRequests = 0;
let isShuttingDown = false;

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getClientIp(req: Request): string {
  const forwardedFor = req.get("x-forwarded-for");
  const firstForwardedIp = forwardedFor
    ?.split(",")[0]
    ?.trim()
    .replace(/^"|"$/g, "")
    .replace(/^::ffff:/i, "");
  if (firstForwardedIp) return firstForwardedIp;

  const forwarded = req.get("x-real-ip")?.trim().replace(/^::ffff:/i, "");
  if (forwarded) return forwarded;

  return (req.ip || req.socket.remoteAddress || "unknown").replace(/^::ffff:/i, "");
}

function createRateLimiter(
  keyPrefix: string,
  windowMs: number,
  maxRequests: number
): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req, res, next) => {
    const ip = getClientIp(req);
    const key = `${keyPrefix}:${ip}`;
    const now = Date.now();
    const existing = hits.get(key);

    if (!existing || now > existing.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    existing.count += 1;
    if (existing.count > maxRequests) {
      const retryAfterSec = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      res.status(429).json({ error: "Rate limit exceeded. Please retry shortly." });
      return;
    }

    next();
  };
}

const rateLimitEnabled = process.env["RATE_LIMIT_ENABLED"] !== "0";
const adminLoginWindowMs = parsePositiveIntEnv("RATE_LIMIT_ADMIN_LOGIN_WINDOW_MS", 60_000);
const adminLoginMax = parsePositiveIntEnv("RATE_LIMIT_ADMIN_LOGIN_MAX", 20);
const mcpWindowMs = parsePositiveIntEnv("RATE_LIMIT_MCP_WINDOW_MS", 60_000);
const mcpMax = parsePositiveIntEnv("RATE_LIMIT_MCP_MAX", 300);

app.use((_req, res, next) => {
  if (isShuttingDown) {
    res.status(503).json({ error: "Server is shutting down. Try again shortly." });
    return;
  }

  inFlightRequests += 1;
  res.on("finish", () => {
    inFlightRequests = Math.max(0, inFlightRequests - 1);
  });
  next();
});

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' https://cdn.jsdelivr.net https://unpkg.com",
      "connect-src 'self' https://cdn.jsdelivr.net https://unpkg.com",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "frame-ancestors 'none'",
    ].join("; ") + ";"
  );
  if (isProduction) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  }
  next();
});

// Parse URL-encoded bodies for admin login form
app.use(express.urlencoded({ extended: false }));
if (rateLimitEnabled) {
  app.use("/admin/login", createRateLimiter("admin-login", adminLoginWindowMs, adminLoginMax));
  app.use("/mcp", createRateLimiter("mcp", mcpWindowMs, mcpMax));
}

const authMiddleware = mcpToken ? createAuthMiddleware(mcpToken) : null;

// ── Health checks (no auth) ─────────────────────────────────────────────────
app.get("/livez", (_req: Request, res: Response) => {
  res.json({ status: "alive" });
});

app.get("/readyz", (_req: Request, res: Response) => {
  const readiness = isDatabaseReady();
  if (!readiness.ok) {
    res.status(503).json({ status: "not_ready", reason: readiness.error ?? "unknown" });
    return;
  }
  const liveStats = queries.stats();
  res.json({ status: "ready", documents: liveStats.total });
});

app.get("/startupz", (_req: Request, res: Response) => {
  const readiness = isDatabaseReady();
  if (!readiness.ok) {
    res.status(503).json({ status: "starting", reason: readiness.error ?? "unknown" });
    return;
  }
  res.json({ status: "started" });
});

app.get("/health", (_req: Request, res: Response) => {
  const readiness = isDatabaseReady();
  if (!readiness.ok) {
    res.status(503).json({ status: "not_ready", reason: readiness.error ?? "unknown" });
    return;
  }
  const liveStats = queries.stats();
  res.json({ status: "ok", documents: liveStats.total });
});

// ── Admin UI ─────────────────────────────────────────────────────────────────
app.use("/admin", createAdminRouter(db));

// ── MCP route factory ────────────────────────────────────────────────────────
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "wp-know-it-all",
    version: "0.2.0",
  });

  registerSearchTool(server, queries);
  registerGetDocTool(server, queries);
  registerLookupTool(server, queries);
  registerValidateTool(server);
  registerAnswerQuestionTool(server, queries);
  registerResources(server, queries);
  registerPrompts(server);

  return server;
}

// ── Stateless Streamable HTTP handler ────────────────────────────────────────
const mcpHandler: RequestHandler = async (req: Request, res: Response) => {
  const startedAt = Date.now();
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body as unknown);
  console.log(`[perf] mcp request handled in ${Date.now() - startedAt}ms`);

  res.on("close", () => {
    void transport.close();
    void server.close();
  });
};

const mcpRoutes: RequestHandler[] = authMiddleware ? [authMiddleware, mcpHandler] : [mcpHandler];

app.post("/mcp", ...mcpRoutes);
app.get("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({ error: "Method not allowed. Use POST for MCP requests." });
});
app.delete("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({ error: "Method not allowed." });
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const httpServer = app.listen(PORT, "0.0.0.0", () => {
  const authStatus = authMiddleware ? "enabled (Bearer token)" : "DISABLED";
  const adminStatus = process.env["ADMIN_PASSWORD"]?.trim()
    ? "password protected"
    : "DISABLED (set ADMIN_PASSWORD)";
  console.log(`[server] WP Know It All v0.2 listening on port ${PORT}`);
  console.log(`[server] MCP auth: ${authStatus}`);
  console.log(`[server] Admin UI: http://0.0.0.0:${PORT}/admin (${adminStatus})`);
  console.log(`[server] MCP endpoint: http://0.0.0.0:${PORT}/mcp`);
  console.log(`[server] Liveness: http://0.0.0.0:${PORT}/livez`);
  console.log(`[server] Readiness: http://0.0.0.0:${PORT}/readyz`);
  console.log(`[server] Startup: http://0.0.0.0:${PORT}/startupz`);
  console.log(`[server] Health check: http://0.0.0.0:${PORT}/health`);
  if (rateLimitEnabled) {
    console.log(
      `[server] Rate limits: admin-login=${adminLoginMax}/${Math.round(adminLoginWindowMs / 1000)}s, mcp=${mcpMax}/${Math.round(mcpWindowMs / 1000)}s`
    );
  } else {
    console.log("[server] Rate limits: DISABLED (RATE_LIMIT_ENABLED=0)");
  }
  if (allowedHosts.length > 0) {
    console.log(`[server] Allowed hosts: ${allowedHosts.join(", ")}`);
  } else {
    console.log("[server] Allowed hosts: not set (use ALLOWED_HOSTS to restrict Host header)");
  }
  if (process.env["OLLAMA_HOST"]) {
    console.log(
      `[server] Ollama: ${process.env["OLLAMA_HOST"]} (${process.env["OLLAMA_MODEL"] ?? "qwen2.5-coder:1.5b"})`
    );
  }
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
process.on("SIGTERM", () => {
  console.log("[server] SIGTERM received, draining connections...");
  isShuttingDown = true;
  httpServer.close(() => {
    db.close();
    process.exit(0);
  });

  const deadlineMs = 10_000;
  const started = Date.now();
  const poll = setInterval(() => {
    if (inFlightRequests === 0 || Date.now() - started > deadlineMs) {
      clearInterval(poll);
      db.close();
      process.exit(0);
    }
  }, 200);
});

process.on("SIGINT", () => {
  isShuttingDown = true;
  httpServer.close();
  db.close();
  process.exit(0);
});
