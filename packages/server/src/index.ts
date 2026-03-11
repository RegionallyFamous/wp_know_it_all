import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import express from "express";
import type { Request, Response, RequestHandler } from "express";
import { join } from "node:path";
import { openDatabase } from "./db/schema.js";
import { buildQueries } from "./db/queries.js";
import { authMiddleware } from "./middleware/auth.js";
import { registerSearchTool } from "./tools/search.js";
import { registerGetDocTool } from "./tools/get-doc.js";
import { registerLookupTool } from "./tools/lookup-hook.js";
import { registerValidateTool } from "./tools/validate.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";
import { createAdminRouter } from "./admin/router.js";

// ── Database ────────────────────────────────────────────────────────────────
const volumePath = process.env["RAILWAY_VOLUME_MOUNT_PATH"] ?? "./data";
const dbPath = join(volumePath, "wordpress.db");
console.log(`[db] Opening database at ${dbPath}`);

const db = openDatabase(dbPath);
const queries = buildQueries(db);
const stats = queries.stats();
console.log(`[db] Ready — ${stats.total.toLocaleString()} documents indexed`);

// ── Express app ──────────────────────────────────────────────────────────────
const allowedHosts = (process.env["ALLOWED_HOSTS"] ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter((host) => host.length > 0);

// host: '0.0.0.0' is required for Railway; ALLOWED_HOSTS restores host-header protection.
const app = createMcpExpressApp({
  host: "0.0.0.0",
  ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
});

// Parse URL-encoded bodies for admin login form
app.use(express.urlencoded({ extended: false }));

// ── Health check (no auth) ───────────────────────────────────────────────────
app.get("/health", (_req: Request, res: Response) => {
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
  registerResources(server, queries);
  registerPrompts(server);

  return server;
}

// ── Stateless Streamable HTTP handler ────────────────────────────────────────
const mcpHandler: RequestHandler = async (req: Request, res: Response) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body as unknown);

  res.on("close", () => {
    void transport.close();
    void server.close();
  });
};

const mcpRoutes: RequestHandler[] = authMiddleware
  ? [authMiddleware, mcpHandler]
  : [mcpHandler];

app.post("/mcp", ...mcpRoutes);
app.get("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({ error: "Method not allowed. Use POST for MCP requests." });
});
app.delete("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({ error: "Method not allowed." });
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
app.listen(PORT, "0.0.0.0", () => {
  const authStatus = authMiddleware
    ? "enabled (Bearer token)"
    : "DISABLED (set MCP_AUTH_TOKEN)";
  const adminStatus = process.env["ADMIN_PASSWORD"]
    ? "password protected"
    : "open (set ADMIN_PASSWORD)";
  console.log(`[server] WP Know It All v0.2 listening on port ${PORT}`);
  console.log(`[server] MCP auth: ${authStatus}`);
  console.log(`[server] Admin UI: http://0.0.0.0:${PORT}/admin (${adminStatus})`);
  console.log(`[server] MCP endpoint: http://0.0.0.0:${PORT}/mcp`);
  console.log(`[server] Health check: http://0.0.0.0:${PORT}/health`);
  if (allowedHosts.length > 0) {
    console.log(`[server] Allowed hosts: ${allowedHosts.join(", ")}`);
  } else {
    console.log("[server] Allowed hosts: not set (use ALLOWED_HOSTS to restrict Host header)");
  }
  if (process.env["OLLAMA_HOST"]) {
    console.log(`[server] Ollama: ${process.env["OLLAMA_HOST"]} (${process.env["OLLAMA_MODEL"] ?? "qwen2.5-coder:1.5b"})`);
  }
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
process.on("SIGTERM", () => {
  console.log("[server] SIGTERM received, closing database...");
  db.close();
  process.exit(0);
});

process.on("SIGINT", () => {
  db.close();
  process.exit(0);
});
