import { Router } from "express";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import cookieParser from "cookie-parser";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { LogLine } from "./runner.js";
import {
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  requireAdminAuth,
  requireSameOriginPost,
  verifyAdminPassword,
} from "./session.js";
import { scraperRunner } from "./runner.js";
import { buildAdminQueries } from "./queries.js";
import {
  escapeHtml,
  page,
  statCard,
  table,
  statusBadge,
  logLine,
  loginPage,
} from "./templates.js";
import type { Request, Response } from "express";
import { readRecentQualityEvents, summarizeQualityEvents } from "../lib/quality-metrics.js";
import { buildQueries } from "../db/queries.js";
import { buildGroundedAnswer } from "../tools/answer-question.js";
import { verifyGroundedAnswer } from "../lib/answer-verifier.js";
import { getBeyondRagFlags } from "../lib/feature-flags.js";
import { logError, logInfo, logWarn } from "../lib/logger.js";

function resolveScraperEntrypoint(): {
  entrypoint: string;
  source: string;
  checkedPaths: string[];
} {
  const checkedPaths: string[] = [];
  const addPath = (path: string): void => {
    if (!checkedPaths.includes(path)) checkedPaths.push(path);
  };

  const override = process.env["SCRAPER_ENTRY"]?.trim();
  if (override) {
    const overridePath = resolve(override);
    addPath(overridePath);
    if (existsSync(overridePath)) {
      return { entrypoint: overridePath, source: "SCRAPER_ENTRY", checkedPaths };
    }
  }

  // Works for both src/admin/router.ts and dist/admin/router.js layouts.
  const relativeToServerBundle = fileURLToPath(
    new URL("../../../scraper/dist/index.js", import.meta.url)
  );
  addPath(relativeToServerBundle);
  if (existsSync(relativeToServerBundle)) {
    return {
      entrypoint: relativeToServerBundle,
      source: "relative-to-server-bundle",
      checkedPaths,
    };
  }

  const cwdWorkspacePath = join(process.cwd(), "packages/scraper/dist/index.js");
  addPath(cwdWorkspacePath);
  if (existsSync(cwdWorkspacePath)) {
    return { entrypoint: cwdWorkspacePath, source: "cwd-workspace", checkedPaths };
  }

  const dockerDefaultPath = "/app/packages/scraper/dist/index.js";
  addPath(dockerDefaultPath);
  return {
    entrypoint: dockerDefaultPath,
    source: "docker-default-fallback",
    checkedPaths,
  };
}

function formatTs(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatDuration(startedAt: number, completedAt: number | null): string {
  if (!completedAt) return "—";
  const ms = (completedAt - startedAt) * 1000;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts * 1000) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

interface AdminActionEvent {
  ts: number;
  action: string;
  status: "started" | "ok" | "error";
  detail: string;
}

interface EvalRunState {
  status: "idle" | "running" | "success" | "failed";
  startedAt: number | null;
  completedAt: number | null;
  lastMessage: string;
}

interface ReportStatus {
  name: string;
  exists: boolean;
  generatedAt: string | null;
  pass: boolean | null;
  summary: string;
}

interface AdminAssistantTurn {
  ts: number;
  question: string;
  answer: string;
  synthesisEngine: "deterministic" | "ollama";
  confidence: number;
  abstained: boolean;
}

const adminActionEvents: AdminActionEvent[] = [];
const adminAssistantTurns: AdminAssistantTurn[] = [];
const evalRunStates: Record<"baseline" | "ops", EvalRunState> = {
  baseline: { status: "idle", startedAt: null, completedAt: null, lastMessage: "Not run from admin yet." },
  ops: { status: "idle", startedAt: null, completedAt: null, lastMessage: "Not run from admin yet." },
};
let retrievalDiagnosticsInFlight = 0;
const retrievalDiagnosticsMaxInFlight = (() => {
  const parsed = Number.parseInt(process.env["ADMIN_RETRIEVAL_MAX_IN_FLIGHT"] ?? "2", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
})();
const reportStatusCache = new Map<
  string,
  { mtimeMs: number; size: number; value: ReportStatus }
>();
const adminActionRateLimit = new Map<string, { count: number; resetAt: number }>();
let adminActionRateLimitLastCleanupAt = 0;

function pushAdminAction(action: string, status: AdminActionEvent["status"], detail: string): void {
  const boundedDetail = detail.length > 600 ? `${detail.slice(0, 600)}…` : detail;
  adminActionEvents.push({ ts: Date.now(), action, status, detail: boundedDetail });
  while (adminActionEvents.length > 200) adminActionEvents.shift();
  logInfo("admin.action", { action, status, detail: boundedDetail });
}

function formatDurationSeconds(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "0s";
  if (totalSeconds < 60) return `${Math.round(totalSeconds)}s`;
  const mins = Math.floor(totalSeconds / 60);
  const secs = Math.round(totalSeconds % 60);
  return `${mins}m ${secs}s`;
}

function isConfirmYes(req: Request): boolean {
  const body = req.body as Record<string, unknown> | undefined;
  const bodyConfirm = body?.["confirm"];
  return (
    (req.query["confirm"] as string | undefined)?.toLowerCase() === "yes" ||
    (typeof bodyConfirm === "string" && bodyConfirm.toLowerCase() === "yes")
  );
}

function safeExternalHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.toString();
  } catch {
    return null;
  }
  return null;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timeout);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
}

function allowAdminAction(req: Request, action: string): boolean {
  const windowMs = 10_000;
  const maxRequests = 10;
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const key = `${action}:${ip}`;
  const now = Date.now();
  if (now - adminActionRateLimitLastCleanupAt >= 30_000) {
    for (const [rateKey, value] of adminActionRateLimit.entries()) {
      if (now > value.resetAt) adminActionRateLimit.delete(rateKey);
    }
    adminActionRateLimitLastCleanupAt = now;
  }
  const existing = adminActionRateLimit.get(key);
  if (!existing || now > existing.resetAt) {
    adminActionRateLimit.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  existing.count += 1;
  return existing.count <= maxRequests;
}

function renderStageStatus(label: string, status: "green" | "amber" | "red", detail: string): string {
  const style =
    status === "green"
      ? "bg-emerald-500/10 border-emerald-400/30 text-emerald-300"
      : status === "amber"
        ? "bg-amber-500/10 border-amber-400/30 text-amber-300"
        : "bg-rose-500/10 border-rose-400/30 text-rose-300";
  const dot = status === "green" ? "bg-emerald-400" : status === "amber" ? "bg-amber-400" : "bg-rose-400";
  return `<div class="border rounded-lg p-4 ${style}">
  <div class="flex items-center gap-2 text-sm font-semibold"><span class="w-2 h-2 rounded-full ${dot}"></span>${escapeHtml(label)}</div>
  <p class="text-xs mt-2 opacity-90">${escapeHtml(detail)}</p>
</div>`;
}

function formatMultilineText(input: string): string {
  return escapeHtml(input).replace(/\n/g, "<br>");
}

function readReportStatus(name: "baseline" | "ops"): ReportStatus {
  const fileName = name === "baseline" ? "baseline-report.md" : "ops-slo-report.md";
  const candidates = [
    process.env[name === "baseline" ? "BASELINE_REPORT_DIR" : "OPS_REPORT_DIR"]?.trim() ?? "",
    join(process.cwd(), "reports"),
    join(process.cwd(), "packages/server/reports"),
  ].filter((dir) => dir.length > 0);
  for (const dir of candidates) {
    const path = join(dir, fileName);
    if (!existsSync(path)) continue;
    const stat = statSync(path);
    const cacheKey = `${name}:${path}`;
    const cached = reportStatusCache.get(cacheKey);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.value;
    }
    const body = readFileSync(path, "utf-8");
    const generatedAt = body.match(/Generated:\s*([^\n]+)/i)?.[1]?.trim() ?? null;
    const passMatch = body.match(/Overall:\s*\*\*(PASS|FAIL)\*\*/i)?.[1];
    const pass = passMatch ? passMatch.toUpperCase() === "PASS" : null;
    const summary =
      name === "baseline"
        ? body.match(/Total documents:\s*\*\*([^*]+)\*\*/i)?.[1]?.trim() ?? "Baseline report available"
        : body.match(/Overall:\s*\*\*(PASS|FAIL)\*\*/i)?.[1]?.toUpperCase() ?? "Ops report available";
    const value = { name, exists: true, generatedAt, pass, summary };
    reportStatusCache.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  }
  return { name, exists: false, generatedAt: null, pass: null, summary: "No report found yet." };
}

function spawnEvalScript(kind: "baseline" | "ops", fallbackRunner?: () => string): void {
  const state = evalRunStates[kind];
  if (state.status === "running") return;
  if (state.completedAt && Date.now() - state.completedAt < 10_000) {
    return;
  }

  state.status = "running";
  state.startedAt = Date.now();
  state.lastMessage = `Running ${kind} report...`;
  pushAdminAction(`eval:${kind}`, "started", "Triggered from admin controls.");
  logInfo("admin.eval.start", { kind });

  const script = kind === "baseline" ? "eval:baseline" : "eval:ops";
  const child = spawn("pnpm", ["--filter", "@wp-know-it-all/server", script], {
    cwd: process.cwd(),
    stdio: "pipe",
  });

  let output = "";
  let spawnFailed = false;
  const maxOutputChars = 20_000;
  const appendChunk = (chunk: unknown): void => {
    if (output.length >= maxOutputChars) return;
    output += String(chunk);
    if (output.length > maxOutputChars) {
      output = output.slice(0, maxOutputChars);
    }
  };
  const timeoutMs = kind === "baseline" ? 90_000 : 60_000;
  let timeoutTriggered = false;
  const timeout = setTimeout(() => {
    timeoutTriggered = true;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 5_000).unref();
    state.status = "failed";
    state.completedAt = Date.now();
    state.lastMessage = `Timed out after ${Math.round(timeoutMs / 1000)}s`;
    pushAdminAction(`eval:${kind}`, "error", state.lastMessage);
    logWarn("admin.eval.timeout", { kind, timeoutMs });
  }, timeoutMs);
  child.stdout.on("data", (chunk) => {
    appendChunk(chunk);
  });
  child.stderr.on("data", (chunk) => {
    appendChunk(chunk);
  });

  child.on("error", (error) => {
    clearTimeout(timeout);
    spawnFailed = true;
    const message = String(error);
    if (fallbackRunner && message.includes("ENOENT")) {
      logWarn("admin.eval.spawn.enoent", { kind, message });
      try {
        const fallbackMessage = fallbackRunner();
        state.status = "success";
        state.completedAt = Date.now();
        state.lastMessage = fallbackMessage;
        pushAdminAction(`eval:${kind}`, "ok", `Ran in-process fallback: ${fallbackMessage}`);
        logInfo("admin.eval.fallback.success", { kind, fallbackMessage });
      } catch (fallbackError) {
        state.status = "failed";
        state.completedAt = Date.now();
        state.lastMessage = `Fallback failed: ${String(fallbackError)}`;
        pushAdminAction(`eval:${kind}`, "error", state.lastMessage);
        logError("admin.eval.fallback.failed", { kind, error: String(fallbackError) });
      }
      return;
    }
    state.status = "failed";
    state.completedAt = Date.now();
    state.lastMessage = `Failed to start: ${message}`;
    pushAdminAction(`eval:${kind}`, "error", state.lastMessage);
    logError("admin.eval.spawn.failed", { kind, message });
  });

  child.on("close", (code, signal) => {
    clearTimeout(timeout);
    if (
      timeoutTriggered ||
      spawnFailed ||
      (state.status === "failed" && state.lastMessage.includes("Timed out"))
    ) {
      return;
    }
    state.completedAt = Date.now();
    if (code === 0) {
      state.status = "success";
      state.lastMessage = output.trim().split("\n").slice(-2).join(" | ") || "Completed successfully.";
      pushAdminAction(`eval:${kind}`, "ok", state.lastMessage);
      logInfo("admin.eval.success", { kind, message: state.lastMessage });
      return;
    }
    state.status = "failed";
    const trailer = output.trim().split("\n").slice(-3).join(" | ");
    const exitDetail =
      signal != null ? `Exited via signal ${signal}` : `Exited with code ${String(code)}`;
    state.lastMessage = trailer || exitDetail;
    pushAdminAction(`eval:${kind}`, "error", state.lastMessage);
    logError("admin.eval.failed", {
      kind,
      signal,
      code,
      message: state.lastMessage,
    });
  });
}

// ── Dashboard page body ─────────────────────────────────────────────────────

function renderDashboardShell(): string {
  return `
<div class="mb-8">
  <h1 class="text-2xl font-bold text-slate-100">Dashboard</h1>
  <p class="text-sm text-slate-500 mt-1">Overview of the WordPress documentation index</p>
</div>

<!-- Hero stats (HTMX polled every 10s) -->
<div
  id="stats-container"
  hx-get="/admin/stats"
  hx-trigger="load, every 10s"
  hx-swap="innerHTML"
  class="mb-10"
>
  <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 animate-pulse">
    ${Array.from({ length: 4 }, () => `<div class="bg-slate-800 rounded-xl h-28"></div>`).join("")}
  </div>
</div>

<!-- Three-column layout: categories + sources + recent errors -->
<div class="grid grid-cols-1 lg:grid-cols-3 gap-8">

  <!-- Category breakdown -->
  <div class="bg-slate-900 border border-slate-800 rounded-xl p-6">
    <h2 class="text-sm font-semibold text-slate-200 uppercase tracking-wider mb-5">Documents by Category</h2>
    <div
      id="category-chart"
      hx-get="/admin/stats?fragment=categories"
      hx-trigger="load"
      hx-swap="innerHTML"
      class="space-y-2"
    >
      <div class="text-slate-600 text-sm">Loading…</div>
    </div>
  </div>

  <!-- Source breakdown -->
  <div class="bg-slate-900 border border-slate-800 rounded-xl p-6">
    <h2 class="text-sm font-semibold text-slate-200 uppercase tracking-wider mb-5">Documents by Source</h2>
    <div
      id="source-chart"
      hx-get="/admin/stats?fragment=sources"
      hx-trigger="load"
      hx-swap="innerHTML"
      class="space-y-2"
    >
      <div class="text-slate-600 text-sm">Loading…</div>
    </div>
  </div>

  <!-- Recent scrape errors -->
  <div class="bg-slate-900 border border-slate-800 rounded-xl p-6">
    <div class="flex items-center justify-between mb-5">
      <h2 class="text-sm font-semibold text-slate-200 uppercase tracking-wider">Recent Errors</h2>
      <button
        hx-post="/admin/scraper/errors/clear?confirm=yes"
        hx-target="#recent-errors"
        hx-swap="innerHTML"
        hx-confirm="Clear all scraper error history?"
        class="text-xs text-slate-500 hover:text-slate-300 transition-colors px-2 py-1 rounded hover:bg-slate-800"
      >
        Clear Errors
      </button>
    </div>
    <div
      id="recent-errors"
      hx-get="/admin/stats?fragment=errors"
      hx-trigger="load"
      hx-swap="innerHTML"
      class="space-y-2"
    >
      <div class="text-slate-600 text-sm">Loading…</div>
    </div>
  </div>
</div>`;
}

// ── Stats fragment ───────────────────────────────────────────────────────────

function renderStatsFragment(
  stats: ReturnType<ReturnType<typeof buildAdminQueries>["getStats"]>
): string {
  const lastRunTime = stats.lastJob?.started_at
    ? formatTs(stats.lastJob.started_at)
    : "Never";
  const jobStatus = stats.lastJob?.status ?? "none";

  return `
<div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
  ${statCard("Total Documents", stats.totalDocs.toLocaleString(), "sky")}
  ${statCard("Last Run", lastRunTime, "slate")}
  ${statCard("Last Status", jobStatus.charAt(0).toUpperCase() + jobStatus.slice(1), jobStatus === "completed" ? "emerald" : jobStatus === "failed" ? "rose" : "amber")}
  ${statCard("Sources", stats.bySource.length.toString(), "violet")}
</div>`;
}

function renderCategoryChart(
  byCategory: Array<{ category: string; count: number }>,
  total: number
): string {
  if (byCategory.length === 0) {
    return `<p class="text-slate-600 text-sm">No documents yet.</p>`;
  }
  const max = byCategory[0]?.count ?? 1;
  return byCategory
    .map(({ category, count }) => {
      const pct = Math.round((count / max) * 100);
      const totalPct = total > 0 ? ((count / total) * 100).toFixed(1) : "0";
      return `<div class="space-y-1">
  <div class="flex justify-between items-baseline">
    <span class="text-xs text-slate-300 font-medium">${escapeHtml(category)}</span>
    <span class="text-xs text-slate-500">${count.toLocaleString()} <span class="text-slate-600">(${totalPct}%)</span></span>
  </div>
  <div class="h-1.5 bg-slate-800 rounded-full overflow-hidden">
    <div class="h-full bg-sky-500 rounded-full transition-all duration-500" style="width:${pct}%"></div>
  </div>
</div>`;
    })
    .join("\n");
}

function renderRecentErrors(
  errors: Array<{ source_type: string; error_msg: string; created_at: number }>
): string {
  if (errors.length === 0) {
    return `<p class="text-slate-600 text-sm">No recent errors.</p>`;
  }
  return errors
    .map(
      (e) => `<div class="flex gap-3 py-2 border-b border-slate-800/50 last:border-0">
  <div class="shrink-0 w-1.5 h-1.5 rounded-full bg-rose-500 mt-1.5"></div>
  <div class="min-w-0">
    <div class="flex items-center gap-2 mb-0.5">
      <span class="text-xs font-medium text-rose-300">${escapeHtml(e.source_type)}</span>
      <span class="text-xs text-slate-600">${timeAgo(e.created_at)}</span>
    </div>
    <p class="text-xs text-slate-500 truncate" title="${escapeHtml(e.error_msg)}">${escapeHtml(e.error_msg)}</p>
  </div>
</div>`
    )
    .join("\n");
}

function renderSourceChart(bySource: Array<{ source: string; count: number }>, total: number): string {
  if (bySource.length === 0) {
    return `<p class="text-slate-600 text-sm">No documents yet.</p>`;
  }
  const max = bySource[0]?.count ?? 1;
  return bySource
    .map(({ source, count }) => {
      const pct = Math.round((count / max) * 100);
      const totalPct = total > 0 ? ((count / total) * 100).toFixed(1) : "0";
      return `<div class="space-y-1">
  <div class="flex justify-between items-baseline">
    <span class="text-xs text-slate-300 font-medium">${escapeHtml(source)}</span>
    <span class="text-xs text-slate-500">${count.toLocaleString()} <span class="text-slate-600">(${totalPct}%)</span></span>
  </div>
  <div class="h-1.5 bg-slate-800 rounded-full overflow-hidden">
    <div class="h-full bg-violet-500 rounded-full transition-all duration-500" style="width:${pct}%"></div>
  </div>
</div>`;
    })
    .join("\n");
}

// ── Jobs page ────────────────────────────────────────────────────────────────

function renderJobsPage(jobs: ReturnType<ReturnType<typeof buildAdminQueries>["getJobs"]>): string {
  return `
<div class="mb-8">
  <h1 class="text-2xl font-bold text-slate-100">Scrape Jobs</h1>
  <p class="text-sm text-slate-500 mt-1">History of all scraper runs</p>
</div>

<!-- Auto-refresh fragment -->
<div
  id="jobs-table"
  hx-get="/admin/jobs/fragment"
  hx-trigger="every 5s"
  hx-swap="outerHTML"
>
  ${renderJobsFragment(jobs)}
</div>`;
}

function renderJobsFragment(
  jobs: ReturnType<ReturnType<typeof buildAdminQueries>["getJobs"]>
): string {
  const rows = jobs.map((j) => [
    `<a href="/admin/jobs/${j.id}" class="font-mono text-sky-400 hover:text-sky-300 text-xs">#${j.id}</a>`,
    formatTs(j.started_at),
    formatTs(j.completed_at),
    formatDuration(j.started_at, j.completed_at),
    statusBadge(j.status),
    j.total_docs.toLocaleString(),
    j.total_errors > 0
      ? `<span class="text-rose-400">${j.total_errors.toLocaleString()}</span>`
      : "0",
    j.summary
      ? `<span class="text-slate-500 text-xs max-w-xs truncate inline-block" title="${escapeHtml(j.summary)}">${escapeHtml(j.summary)}</span>`
      : "—",
  ]);

  return `<div id="jobs-table" hx-get="/admin/jobs/fragment" hx-trigger="every 5s" hx-swap="outerHTML">
  ${table(
    ["ID", "Started", "Completed", "Duration", "Status", "Docs", "Errors", "Summary"],
    rows
  )}
</div>`;
}

function renderJobsAnalytics(
  analytics: ReturnType<ReturnType<typeof buildAdminQueries>["getJobAnalytics"]>
): string {
  return `<div class="grid grid-cols-2 lg:grid-cols-6 gap-4 mb-6">
  ${statCard("Sampled Jobs", analytics.sampledJobs.toLocaleString(), "slate")}
  ${statCard("Completed", analytics.completedJobs.toLocaleString(), "emerald")}
  ${statCard("Failed", analytics.failedJobs.toLocaleString(), analytics.failedJobs > 0 ? "rose" : "emerald")}
  ${statCard("Avg Duration", formatDurationSeconds(analytics.avgDurationSec), "sky")}
  ${statCard("P95 Duration", formatDurationSeconds(analytics.p95DurationSec), "amber")}
  ${statCard("Avg Docs/Min", analytics.avgDocsPerMin.toFixed(1), "violet")}
</div>
<div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
  <div class="bg-slate-900 border border-slate-800 rounded-xl p-5">
    <h2 class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Document Growth</h2>
    <div class="text-sm text-slate-300">Last 24h: <span class="text-slate-100 font-semibold">${analytics.docsLast24h.toLocaleString()}</span></div>
    <div class="text-sm text-slate-300 mt-1">Last 7d: <span class="text-slate-100 font-semibold">${analytics.docsLast7d.toLocaleString()}</span></div>
  </div>
  <div class="bg-slate-900 border border-slate-800 rounded-xl p-5">
    <h2 class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Top Failing Sources (7d)</h2>
    ${
      analytics.topFailingSources.length === 0
        ? `<p class="text-sm text-slate-500">No recent scrape errors by source.</p>`
        : analytics.topFailingSources
            .map(
              (row) =>
                `<div class="flex justify-between text-sm py-1 border-b border-slate-800/60 last:border-0"><span class="text-slate-300">${escapeHtml(row.source_type)}</span><span class="text-rose-300">${row.count.toLocaleString()}</span></div>`
            )
            .join("\n")
    }
  </div>
</div>`;
}

function renderJobDetailPage(
  job: ReturnType<ReturnType<typeof buildAdminQueries>["getJobById"]>,
  previousJob: ReturnType<ReturnType<typeof buildAdminQueries>["getPreviousJob"]>,
  errors: ReturnType<ReturnType<typeof buildAdminQueries>["getErrorsForJob"]>
): string {
  if (!job) {
    return `<div class="text-slate-500 text-sm">Job not found.</div>`;
  }
  const docsDelta = previousJob ? job.total_docs - previousJob.total_docs : job.total_docs;
  const errorDelta = previousJob ? job.total_errors - previousJob.total_errors : job.total_errors;
  const errorRows = errors.map((error) => [
    formatTs(error.created_at),
    escapeHtml(error.source_type),
    (() => {
      const safeUrl = safeExternalHref(error.url);
      if (!safeUrl || !error.url) return "—";
      return `<a href="${escapeHtml(safeUrl)}" class="text-sky-400 hover:text-sky-300 text-xs" target="_blank" rel="noreferrer">${escapeHtml(error.url)}</a>`;
    })(),
    `<span class="text-xs text-slate-400">${escapeHtml(error.error_msg)}</span>`,
  ]);

  return `
<div class="mb-8">
  <h1 class="text-2xl font-bold text-slate-100">Job #${job.id}</h1>
  <p class="text-sm text-slate-500 mt-1">Detailed run diagnostics and deltas</p>
</div>
<div class="grid grid-cols-2 lg:grid-cols-6 gap-4 mb-6">
  ${statCard("Status", job.status, job.status === "completed" ? "emerald" : job.status === "failed" ? "rose" : "amber")}
  ${statCard("Started", formatTs(job.started_at), "slate")}
  ${statCard("Completed", formatTs(job.completed_at), "slate")}
  ${statCard("Duration", formatDuration(job.started_at, job.completed_at), "sky")}
  ${statCard("Docs Delta", docsDelta >= 0 ? `+${docsDelta}` : `${docsDelta}`, docsDelta >= 0 ? "emerald" : "rose")}
  ${statCard("Errors Delta", errorDelta >= 0 ? `+${errorDelta}` : `${errorDelta}`, errorDelta > 0 ? "rose" : "emerald")}
</div>
<div class="mb-4 text-xs text-slate-500">Summary: ${job.summary ? escapeHtml(job.summary) : "—"}</div>
<h2 class="text-sm font-semibold text-slate-300 mb-3">Source Errors (${errors.length})</h2>
${table(["Timestamp", "Source", "URL", "Error"], errorRows)}
`;
}

// ── Search page ──────────────────────────────────────────────────────────────

function renderSearchPage(): string {
  const sourceOptions = [
    { value: "", label: "All sources" },
    { value: "devhub-api", label: "WordPress DevHub API" },
    { value: "gutenberg-github", label: "Gutenberg (GitHub)" },
    { value: "wpcli-github", label: "WP-CLI (GitHub)" },
    { value: "wordpress-github-docs", label: "WordPress GitHub Docs (Curated)" },
    { value: "wordpress-github-code", label: "WordPress GitHub Code (Curated)" },
    { value: "php-manual", label: "PHP Manual" },
    { value: "nodejs-docs", label: "Node.js Docs" },
    { value: "mdn-webdocs", label: "MDN Web Docs" },
    { value: "ietf-rfcs", label: "IETF RFCs" },
    { value: "python-docs", label: "Python Docs" },
  ];
  const categoryOptions = [
    { value: "", label: "All categories" },
    { value: "code-reference", label: "code-reference" },
    { value: "plugin-handbook", label: "plugin-handbook" },
    { value: "theme-handbook", label: "theme-handbook" },
    { value: "block-editor", label: "block-editor" },
    { value: "rest-api", label: "rest-api" },
    { value: "common-apis", label: "common-apis" },
    { value: "coding-standards", label: "coding-standards" },
    { value: "admin", label: "admin" },
    { value: "scf", label: "scf" },
    { value: "php-core", label: "php-core" },
    { value: "nodejs-runtime", label: "nodejs-runtime" },
    { value: "web-platform", label: "web-platform" },
    { value: "software-engineering", label: "software-engineering" },
    { value: "python-runtime", label: "python-runtime" },
  ];
  const renderSelectOptions = (options: Array<{ value: string; label: string }>): string =>
    options
      .map((opt) => `<option value="${escapeHtml(opt.value)}">${escapeHtml(opt.label)}</option>`)
      .join("");

  return `
<div class="mb-8">
  <h1 class="text-2xl font-bold text-slate-100">Search Documents</h1>
  <p class="text-sm text-slate-500 mt-1">Browse the indexed WordPress documentation</p>
</div>

<div class="bg-slate-900 border border-slate-800 rounded-xl p-6 mb-6">
  <form
    hx-get="/admin/search/results"
    hx-target="#search-results"
    hx-push-url="false"
    hx-trigger="submit, input[name='q'] changed delay:400ms, select[name='source'] change, select[name='category'] change"
    class="grid grid-cols-1 lg:grid-cols-5 gap-3"
  >
    <input
      name="q"
      type="search"
      placeholder="Search by title, slug, or URL…"
      autofocus
      class="lg:col-span-2 bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-slate-100 placeholder-slate-600
             focus:outline-none focus:ring-2 focus:ring-sky-500/50 focus:border-sky-500/50 transition-colors"
    />
    <select
      name="source"
      class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/50 focus:border-sky-500/50 transition-colors"
    >
      ${renderSelectOptions(sourceOptions)}
    </select>
    <select
      name="category"
      class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/50 focus:border-sky-500/50 transition-colors"
    >
      ${renderSelectOptions(categoryOptions)}
    </select>
    <button
      type="submit"
      class="bg-sky-600 hover:bg-sky-500 text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
    >
      Search
    </button>
  </form>
</div>

<div id="search-results"
  hx-get="/admin/search/results"
  hx-trigger="load"
  hx-swap="innerHTML"
>
  <div class="text-slate-600 text-sm text-center py-8">Loading…</div>
</div>`;
}

function renderSearchResults(
  results: ReturnType<ReturnType<typeof buildAdminQueries>["searchDocs"]>,
  total: number,
  q: string,
  filters: { source?: string; category?: string }
): string {
  if (results.length === 0) {
    return `<div class="text-center py-12 text-slate-500 text-sm">No documents found${q ? ` for "${escapeHtml(q)}"` : ""}.</div>`;
  }

  const rows = results.map((r) => [
    `<span class="font-mono text-slate-500 text-xs">${r.id}</span>`,
    `<span class="font-medium text-slate-200">${escapeHtml(r.title)}</span>`,
    `<span class="font-mono text-xs text-slate-400">${escapeHtml(r.slug)}</span>`,
    escapeHtml(r.doc_type),
    `<span class="font-mono text-xs text-slate-400">${escapeHtml(r.source)}</span>`,
    r.category ? escapeHtml(r.category) : `<span class="text-slate-600">—</span>`,
    (() => {
      const safeUrl = safeExternalHref(r.url);
      return safeUrl
        ? `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noreferrer" class="text-sky-400 hover:text-sky-300 text-xs truncate max-w-xs inline-block transition-colors">${escapeHtml(r.url)}</a>`
        : `<span class="text-slate-600">invalid-url</span>`;
    })(),
  ]);

  const activeFilters = [filters.source ? `source=${filters.source}` : "", filters.category ? `category=${filters.category}` : ""]
    .filter(Boolean)
    .join(", ");
  const heading =
    q
      ? `Showing ${results.length.toLocaleString()} of ${total.toLocaleString()} results for "<strong class="text-slate-200">${escapeHtml(q)}</strong>"${activeFilters ? ` (${escapeHtml(activeFilters)})` : ""}`
      : `${total.toLocaleString()} documents total${activeFilters ? ` (${escapeHtml(activeFilters)})` : ""}`;

  return `<div class="mb-4 text-xs text-slate-500">${heading}</div>
${table(["ID", "Title", "Slug", "Type", "Source", "Category", "URL"], rows)}`;
}

// ── Scraper page ─────────────────────────────────────────────────────────────

function renderScraperPage(): string {
  return `
<div class="flex items-start justify-between mb-8">
  <div>
    <h1 class="text-2xl font-bold text-slate-100">Scraper</h1>
    <p class="text-sm text-slate-500 mt-1">Control the WordPress documentation scraper</p>
  </div>

  <!-- Action buttons -->
  <div class="flex items-center gap-3">
    <button
      hx-post="/admin/scraper/trigger?confirm=yes"
      hx-swap="none"
      hx-confirm="Start a full scrape run?"
      class="bg-sky-600 hover:bg-sky-500 active:bg-sky-700 text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
    >
      Run Scraper
    </button>
    <button
      hx-post="/admin/scraper/kill?confirm=yes"
      hx-swap="none"
      hx-confirm="Kill the active scraper process?"
      class="bg-slate-700 hover:bg-slate-600 active:bg-slate-800 text-slate-200 text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
    >
      Kill
    </button>
    <button
      hx-post="/admin/scraper/errors/clear?confirm=yes"
      hx-target="#scraper-log"
      hx-swap="none"
      hx-confirm="Clear all scraper error history?"
      class="bg-slate-700 hover:bg-slate-600 active:bg-slate-800 text-slate-200 text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
    >
      Clear Errors
    </button>
  </div>
</div>

<div class="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">

  <!-- Status card -->
  <div class="bg-slate-900 border border-slate-800 rounded-xl p-6">
    <h2 class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-4">Scraper Status</h2>
    <div
      id="scraper-status"
      hx-get="/admin/scraper/status"
      hx-trigger="load, every 2s"
      hx-swap="innerHTML"
    >
      <div class="text-slate-600 text-sm">Loading…</div>
    </div>
  </div>

  <!-- Checkpoints -->
  <div class="bg-slate-900 border border-slate-800 rounded-xl p-6 lg:col-span-2">
    <h2 class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-4">Checkpoints</h2>
    <div
      id="scraper-checkpoints"
      hx-get="/admin/scraper/checkpoints"
      hx-trigger="load, every 10s"
      hx-swap="innerHTML"
    >
      <div class="text-slate-600 text-sm">Loading…</div>
    </div>
  </div>
</div>

<!-- Console log viewer -->
<div class="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
  <div class="flex items-center justify-between px-5 py-3 border-b border-slate-800 bg-slate-900/80">
    <div class="flex items-center gap-2">
      <div class="flex gap-1.5">
        <span class="w-3 h-3 rounded-full bg-slate-700"></span>
        <span class="w-3 h-3 rounded-full bg-slate-700"></span>
        <span class="w-3 h-3 rounded-full bg-slate-700"></span>
      </div>
      <span class="text-xs text-slate-500 font-mono ml-2">scraper.log</span>
    </div>
    <div class="flex items-center gap-3">
      <button
        hx-post="/admin/scraper/rebuild-fts?confirm=yes"
        hx-swap="none"
        hx-confirm="Rebuild full-text index now?"
        class="text-xs text-slate-500 hover:text-slate-300 transition-colors px-2 py-1 rounded hover:bg-slate-800"
      >
        Rebuild FTS
      </button>
      <button
        hx-post="/admin/scraper/wipe?confirm=yes"
        hx-swap="none"
        hx-confirm="Delete ALL documents and reset checkpoints? This cannot be undone."
        class="text-xs text-rose-600 hover:text-rose-400 transition-colors px-2 py-1 rounded hover:bg-slate-800"
      >
        Wipe All Docs
      </button>
    </div>
  </div>

  <!-- Log output -->
  <div
    id="scraper-log"
    hx-get="/admin/scraper/log"
    hx-trigger="load, every 2s"
    hx-swap="innerHTML scroll:bottom"
    class="h-96 overflow-y-auto p-4 font-mono text-xs bg-slate-950/60"
  >
    <div class="text-slate-600">Waiting for log output…</div>
  </div>
</div>`;
}

function renderScraperStatus(
  status: string,
  exitCode: number | null,
  startedAt: number | null
): string {
  const badge = statusBadge(status);
  const started = startedAt
    ? new Date(startedAt).toLocaleTimeString("en-US", { hour12: false })
    : null;

  return `<div class="space-y-3">
  <div>${badge}</div>
  ${started ? `<div class="text-xs text-slate-500">Started: <span class="text-slate-400">${escapeHtml(started)}</span></div>` : ""}
  ${exitCode !== null ? `<div class="text-xs text-slate-500">Exit code: <span class="font-mono ${exitCode === 0 ? "text-emerald-400" : "text-rose-400"}">${exitCode}</span></div>` : ""}
</div>`;
}

function renderCheckpoints(
  checkpoints: ReturnType<ReturnType<typeof buildAdminQueries>["getCheckpoints"]>
): string {
  if (checkpoints.length === 0) {
    return `<p class="text-slate-600 text-sm">No checkpoints recorded yet.</p>`;
  }
  const rows = checkpoints.map((c) => [
    escapeHtml(c.source_type),
    c.last_run_at ? formatTs(c.last_run_at) : "—",
    c.last_page.toString(),
    statusBadge(c.status),
  ]);
  return table(["Source", "Last Run", "Last Page", "Status"], rows);
}

function renderLogOutput(lines: LogLine[]): string {
  if (lines.length === 0) {
    return `<div class="text-slate-600">No output yet. Run the scraper to see logs here.</div>`;
  }
  return lines.map(logLine).join("\n");
}

function renderQualityPage(): string {
  const events = readRecentQualityEvents(250);
  const summary = summarizeQualityEvents(events);
  const recentRows = events
    .slice(-30)
    .reverse()
    .map((event) => [
      new Date(event.ts).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }),
      escapeHtml(event.tool),
      event.routeIntent ? escapeHtml(event.routeIntent) : "n/a",
      event.synthesisEngine ? escapeHtml(event.synthesisEngine) : "deterministic",
      event.abstained ? `<span class="text-amber-400">yes</span>` : "no",
      event.policyViolated ? `<span class="text-rose-400">yes</span>` : "no",
      event.policyReasons && event.policyReasons.length > 0
        ? escapeHtml(event.policyReasons.slice(0, 2).join(" | "))
        : "—",
      `${Math.round(event.citationCoverage * 100)}%`,
      `${Math.round((event.averageSupportScore ?? 0) * 100)}%`,
      `${Math.round(event.confidence * 100)}%`,
      `${event.answerLatencyMs}ms`,
    ]);

  return `
<div class="mb-8">
  <h1 class="text-2xl font-bold text-slate-100">Quality</h1>
  <p class="text-sm text-slate-500 mt-1">Wrangler answer quality and reliability telemetry</p>
</div>
<div class="grid grid-cols-2 lg:grid-cols-7 gap-4 mb-8">
  ${statCard("Events", summary.totalEvents.toLocaleString(), "sky")}
  ${statCard("Citation", `${Math.round(summary.avgCitationCoverage * 100)}%`, "emerald")}
  ${statCard("Support", `${Math.round(summary.avgSupportScore * 100)}%`, "violet")}
  ${statCard("Unsupported", `${Math.round(summary.avgUnsupportedClaimRate * 100)}%`, "rose")}
  ${statCard("Abstain", `${Math.round(summary.abstainRate * 100)}%`, "amber")}
  ${statCard("Policy Viol.", `${Math.round(summary.policyViolationRate * 100)}%`, "rose")}
  ${statCard("Ollama Use", `${Math.round(summary.ollamaUsageRate * 100)}%`, "slate")}
</div>
${table(["Timestamp", "Tool", "Intent", "Engine", "Abstained", "Policy", "Policy Reasons", "Citation", "Support", "Confidence", "Latency"], recentRows)}
`;
}

function renderHealthPageShell(): string {
  return `
<div class="mb-8">
  <h1 class="text-2xl font-bold text-slate-100">Pipeline Health</h1>
  <p class="text-sm text-slate-500 mt-1">End-to-end status across ingestion, retrieval, quality, and release gates</p>
</div>
<div id="health-fragment" hx-get="/admin/health/fragment" hx-trigger="load, every 5s" hx-swap="innerHTML">
  <div class="text-slate-600 text-sm">Loading health signals…</div>
</div>`;
}

function renderHealthFragment(args: {
  stats: ReturnType<ReturnType<typeof buildAdminQueries>["getStats"]>;
  analytics: ReturnType<ReturnType<typeof buildAdminQueries>["getJobAnalytics"]>;
  qualitySummary: ReturnType<typeof summarizeQualityEvents>;
  baseline: ReportStatus;
  ops: ReportStatus;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const lastStarted = args.stats.lastJob?.started_at ?? 0;
  const freshnessAge = lastStarted > 0 ? now - lastStarted : Number.POSITIVE_INFINITY;
  const ingestStatus: "green" | "amber" | "red" =
    args.stats.lastJob?.status === "completed" && freshnessAge <= 48 * 60 * 60
      ? "green"
      : args.stats.lastJob
          ? "amber"
          : "red";
  const growthStatus: "green" | "amber" | "red" =
    args.analytics.docsLast24h > 0 ? "green" : args.analytics.docsLast7d > 0 ? "amber" : "red";
  const qualityStatus: "green" | "amber" | "red" =
    args.qualitySummary.totalEvents > 0 &&
    args.qualitySummary.avgCitationCoverage >= 0.6 &&
    args.qualitySummary.avgUnsupportedClaimRate <= 0.12
      ? "green"
      : args.qualitySummary.totalEvents > 0
        ? "amber"
        : "red";
  const opsStatus: "green" | "amber" | "red" =
    args.ops.pass === true ? "green" : args.ops.exists ? "red" : "amber";

  return `
<div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
  ${renderStageStatus(
    "Ingest Freshness",
    ingestStatus,
    args.stats.lastJob
      ? `Last job ${args.stats.lastJob.status} at ${formatTs(args.stats.lastJob.started_at)}`
      : "No scrape jobs found yet."
  )}
  ${renderStageStatus(
    "Document Growth",
    growthStatus,
    `+${args.analytics.docsLast24h.toLocaleString()} docs (24h), +${args.analytics.docsLast7d.toLocaleString()} docs (7d)`
  )}
  ${renderStageStatus(
    "Retrieval Quality",
    qualityStatus,
    `Citation ${(args.qualitySummary.avgCitationCoverage * 100).toFixed(1)}%, Unsupported ${(args.qualitySummary.avgUnsupportedClaimRate * 100).toFixed(1)}%`
  )}
  ${renderStageStatus(
    "Ops Gate",
    opsStatus,
    args.ops.exists
      ? `Ops report: ${args.ops.summary}${args.ops.generatedAt ? ` (${args.ops.generatedAt})` : ""}`
      : "No ops report found yet."
  )}
</div>
<div class="grid grid-cols-2 lg:grid-cols-5 gap-4">
  ${statCard("Total Docs", args.stats.totalDocs.toLocaleString(), "sky")}
  ${statCard("Jobs Sampled", args.analytics.sampledJobs.toLocaleString(), "slate")}
  ${statCard("Failed Jobs", args.analytics.failedJobs.toLocaleString(), args.analytics.failedJobs > 0 ? "rose" : "emerald")}
  ${statCard("Quality Events", args.qualitySummary.totalEvents.toLocaleString(), "violet")}
  ${statCard("Baseline", args.baseline.exists ? "available" : "missing", args.baseline.exists ? "emerald" : "amber")}
</div>`;
}

function renderRetrievalPage(): string {
  return `
<div class="mb-8">
  <h1 class="text-2xl font-bold text-slate-100">Retrieval Diagnostics</h1>
  <p class="text-sm text-slate-500 mt-1">Inspect intent routing, evidence selection, and grounding metrics.</p>
</div>
<div class="bg-slate-900 border border-slate-800 rounded-xl p-6 mb-6">
  <form hx-post="/admin/retrieval/run" hx-target="#retrieval-output" hx-swap="innerHTML" class="grid grid-cols-1 lg:grid-cols-6 gap-3">
    <input name="question" type="text" required placeholder="Ask a WordPress question..." class="lg:col-span-3 bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-slate-100" />
    <input name="category" type="text" placeholder="category (optional)" class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-100" />
    <input name="doc_type" type="text" placeholder="doc_type (optional)" class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-100" />
    <button type="submit" class="bg-sky-600 hover:bg-sky-500 text-white text-sm font-medium px-5 py-2.5 rounded-lg">Run Diagnostic</button>
  </form>
</div>
<div id="retrieval-output" class="text-slate-500 text-sm">Submit a query to inspect retrieval behavior.</div>`;
}

function renderEvalsPageShell(): string {
  return `
<div class="mb-8">
  <h1 class="text-2xl font-bold text-slate-100">Eval + Ops Center</h1>
  <p class="text-sm text-slate-500 mt-1">View latest report outcomes and trigger report refreshes.</p>
</div>
<div class="flex items-center gap-3 mb-6">
  <button hx-post="/admin/evals/run-baseline?confirm=yes" hx-swap="none" hx-confirm="Run baseline report now?" class="bg-sky-600 hover:bg-sky-500 text-white text-sm font-medium px-4 py-2 rounded-lg">Run Baseline Report</button>
  <button hx-post="/admin/evals/run-ops?confirm=yes" hx-swap="none" hx-confirm="Run ops report now?" class="bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium px-4 py-2 rounded-lg">Run Ops Report</button>
</div>
<div id="evals-fragment" hx-get="/admin/evals/fragment" hx-trigger="load, every 5s" hx-swap="innerHTML">
  <div class="text-slate-600 text-sm">Loading eval state…</div>
</div>`;
}

function renderAssistantPage(): string {
  const historyRows = adminAssistantTurns
    .slice(-10)
    .reverse()
    .map((turn) => [
      new Date(turn.ts).toLocaleString(),
      `<span class="text-xs text-slate-200">${escapeHtml(turn.question)}</span>`,
      turn.synthesisEngine === "ollama"
        ? `<span class="text-emerald-300">ollama</span>`
        : `<span class="text-amber-300">deterministic</span>`,
      `${Math.round(turn.confidence * 100)}%`,
      turn.abstained ? `<span class="text-amber-300">yes</span>` : "no",
    ]);
  return `
<div class="mb-8">
  <h1 class="text-2xl font-bold text-slate-100">Wrangler AI</h1>
  <p class="text-sm text-slate-500 mt-1">Ask grounded questions and inspect how Wrangler answers using Ollama-enhanced synthesis when available.</p>
</div>
<div class="bg-slate-900 border border-slate-800 rounded-xl p-6 mb-6">
  <form hx-post="/admin/assistant/ask" hx-target="#assistant-output" hx-swap="innerHTML" class="grid grid-cols-1 lg:grid-cols-8 gap-3">
    <input name="question" type="text" required placeholder="Ask Wrangler how to improve WordPress implementation quality..." class="lg:col-span-4 bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-slate-100" />
    <input name="category" type="text" placeholder="category (optional)" class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-100" />
    <input name="doc_type" type="text" placeholder="doc_type (optional)" class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-100" />
    <input name="top_k" type="number" min="3" max="12" value="6" class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-100" />
    <button type="submit" class="bg-sky-600 hover:bg-sky-500 text-white text-sm font-medium px-5 py-2.5 rounded-lg">Ask Wrangler</button>
  </form>
</div>
<div id="assistant-output" class="bg-slate-900 border border-slate-800 rounded-xl p-6 text-slate-500 text-sm mb-6">
  Ask a question to run the Wrangler answer pipeline from admin.
</div>
<h2 class="text-sm font-semibold text-slate-300 mb-3">Recent Questions</h2>
${table(["Timestamp", "Question", "Engine", "Confidence", "Abstained"], historyRows)}
`;
}

function renderEvalsFragment(baseline: ReportStatus, ops: ReportStatus): string {
  const runRows = (["baseline", "ops"] as const).map((kind) => {
    const state = evalRunStates[kind];
    return [
    escapeHtml(kind),
    statusBadge(state.status),
    state.startedAt ? new Date(state.startedAt).toLocaleString() : "—",
    state.completedAt ? new Date(state.completedAt).toLocaleString() : "—",
    `<span class="text-xs text-slate-400">${escapeHtml(state.lastMessage)}</span>`,
    ];
  });
  const reportRows = [baseline, ops].map((report) => [
    escapeHtml(report.name),
    report.exists ? "yes" : "no",
    report.generatedAt ? escapeHtml(report.generatedAt) : "—",
    report.pass == null ? "—" : report.pass ? `<span class="text-emerald-300">PASS</span>` : `<span class="text-rose-300">FAIL</span>`,
    escapeHtml(report.summary),
  ]);
  return `
<div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
  ${statCard("Baseline", baseline.exists ? "ready" : "missing", baseline.exists ? "emerald" : "amber")}
  ${statCard("Ops", ops.exists ? "ready" : "missing", ops.exists ? "emerald" : "amber")}
  ${statCard("Baseline Run", evalRunStates.baseline.status, "sky")}
  ${statCard("Ops Run", evalRunStates.ops.status, "violet")}
</div>
<h2 class="text-sm font-semibold text-slate-300 mb-3">Report Status</h2>
${table(["Report", "Exists", "Generated", "Overall", "Summary"], reportRows)}
<h2 class="text-sm font-semibold text-slate-300 mt-6 mb-3">Run History</h2>
${table(["Run", "State", "Started", "Completed", "Message"], runRows)}
`;
}

function renderControlsPage(flags: ReturnType<typeof getBeyondRagFlags>): string {
  const flagRows = Object.entries(flags).map(([key, value]) => [
    `<span class="font-mono text-xs text-slate-300">${escapeHtml(key)}</span>`,
    value ? `<span class="text-emerald-300">enabled</span>` : `<span class="text-amber-300">disabled</span>`,
    `<code class="text-xs text-slate-400">railway variables set ${escapeHtml(key)}=${value ? "0" : "1"}</code>`,
  ]);
  return `
<div class="mb-8">
  <h1 class="text-2xl font-bold text-slate-100">Operational Controls</h1>
  <p class="text-sm text-slate-500 mt-1">High-impact admin actions with explicit risk labels and audit trail.</p>
</div>
<div class="bg-slate-900 border border-slate-800 rounded-xl p-6 mb-6">
  <h2 class="text-sm font-semibold text-slate-300 mb-4">Safe Controls</h2>
  <div class="flex flex-wrap gap-3">
    <button hx-post="/admin/scraper/trigger?confirm=yes" hx-swap="none" hx-confirm="Start scraper run?" class="bg-sky-600 hover:bg-sky-500 text-white text-sm font-medium px-4 py-2 rounded-lg">Run Scraper</button>
    <button hx-post="/admin/scraper/kill?confirm=yes" hx-swap="none" hx-confirm="Kill active scraper process?" class="bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium px-4 py-2 rounded-lg">Kill Scraper</button>
    <button hx-post="/admin/scraper/rebuild-fts?confirm=yes" hx-swap="none" hx-confirm="Rebuild full-text index now?" class="bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium px-4 py-2 rounded-lg">Rebuild FTS</button>
    <button hx-post="/admin/scraper/errors/clear?confirm=yes" hx-swap="none" hx-confirm="Clear all scrape errors?" class="bg-slate-700 hover:bg-slate-600 text-slate-100 text-sm font-medium px-4 py-2 rounded-lg">Clear Errors</button>
    <button hx-post="/admin/scraper/wipe?confirm=yes" hx-swap="none" hx-confirm="Delete ALL docs and checkpoints?" class="bg-rose-700 hover:bg-rose-600 text-white text-sm font-medium px-4 py-2 rounded-lg">Wipe All Docs</button>
  </div>
</div>
<div class="bg-slate-900 border border-slate-800 rounded-xl p-6 mb-6">
  <h2 class="text-sm font-semibold text-slate-300 mb-3">Feature Flags</h2>
  ${table(["Flag", "Current", "Rollback Command"], flagRows)}
</div>
<div class="bg-slate-900 border border-slate-800 rounded-xl p-6">
  <h2 class="text-sm font-semibold text-slate-300 mb-3">Action Log</h2>
  <div id="controls-log" hx-get="/admin/controls/log" hx-trigger="load, every 3s" hx-swap="innerHTML">
    <div class="text-slate-500 text-sm">Loading action log…</div>
  </div>
</div>`;
}

function renderControlsLogFragment(): string {
  if (adminActionEvents.length === 0) {
    return `<div class="text-slate-500 text-sm">No admin actions recorded in this process yet.</div>`;
  }
  const rows = adminActionEvents
    .slice(-40)
    .reverse()
    .map((entry) => [
      new Date(entry.ts).toLocaleString(),
      `<span class="text-xs font-mono text-slate-300">${escapeHtml(entry.action)}</span>`,
      statusBadge(entry.status),
      `<span class="text-xs text-slate-400">${escapeHtml(entry.detail)}</span>`,
    ]);
  return table(["Timestamp", "Action", "Status", "Detail"], rows);
}

// ── Router factory ───────────────────────────────────────────────────────────

export function createAdminRouter(db: Database.Database): ReturnType<typeof Router> {
  const router = Router();
  const queries = buildAdminQueries(db);
  const searchQueries = buildQueries(db);
  const resolveReportDir = (kind: "baseline" | "ops"): string => {
    const envDir =
      kind === "baseline"
        ? process.env["BASELINE_REPORT_DIR"]?.trim()
        : process.env["OPS_REPORT_DIR"]?.trim();
    const dir = envDir || join(process.cwd(), "reports");
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const runBaselineReportInProcess = (): string => {
    const stats = queries.getStats();
    const analytics = queries.getJobAnalytics(50);
    const quality = summarizeQualityEvents(readRecentQualityEvents(500));
    const ts = new Date().toISOString();
    const markdown = `# Wrangler Baseline Report

Generated: ${ts}

## Corpus Snapshot

- Total documents: **${stats.totalDocs.toLocaleString()}**
- Sources: **${stats.bySource.length}**
- Categories: **${stats.byCategory.length}**

## Scraper Reliability (Recent Sample)

- Jobs sampled: **${analytics.sampledJobs}**
- Completed: **${analytics.completedJobs}**
- Failed: **${analytics.failedJobs}**
- Avg docs/min: **${analytics.avgDocsPerMin.toFixed(1)}**

## Quality Snapshot

- Events: **${quality.totalEvents}**
- Citation coverage: **${(quality.avgCitationCoverage * 100).toFixed(1)}%**
- Unsupported claim rate: **${(quality.avgUnsupportedClaimRate * 100).toFixed(1)}%**
- Support score: **${(quality.avgSupportScore * 100).toFixed(1)}%**
- Confidence: **${(quality.avgConfidence * 100).toFixed(1)}%**
`;
    const path = join(resolveReportDir("baseline"), "baseline-report.md");
    writeFileSync(path, `${markdown}\n`, "utf-8");
    return `baseline report written: ${path}`;
  };
  const runOpsReportInProcess = (): string => {
    const analytics = queries.getJobAnalytics(50);
    const quality = summarizeQualityEvents(readRecentQualityEvents(300));
    const sampled = Math.max(1, analytics.sampledJobs);
    const successRate = analytics.completedJobs / sampled;
    const failureRate = analytics.failedJobs / sampled;
    const pass =
      successRate >= 0.9 &&
      failureRate <= 0.1 &&
      quality.avgUnsupportedClaimRate <= 0.12 &&
      quality.avgCitationCoverage >= 0.6;
    const ts = new Date().toISOString();
    const markdown = `# Operations SLO Report

Generated: ${ts}

## Scraper Reliability

- Jobs sampled: **${analytics.sampledJobs}**
- Completed: **${analytics.completedJobs}**
- Failed: **${analytics.failedJobs}**
- Success rate: **${(successRate * 100).toFixed(1)}%**

## Answer Quality

- Citation coverage: **${(quality.avgCitationCoverage * 100).toFixed(1)}%**
- Unsupported claim rate: **${(quality.avgUnsupportedClaimRate * 100).toFixed(1)}%**
- Support score: **${(quality.avgSupportScore * 100).toFixed(1)}%**

Overall: **${pass ? "PASS" : "FAIL"}**
`;
    const path = join(resolveReportDir("ops"), "ops-slo-report.md");
    writeFileSync(path, `${markdown}\n`, "utf-8");
    return `ops report written: ${path}`;
  };
  const searchParamsSchema = z.object({
    q: z.string().trim().max(500).optional().default(""),
    source: z
      .enum([
        "devhub-api",
        "gutenberg-github",
        "wpcli-github",
        "wordpress-github-docs",
        "wordpress-github-code",
        "php-manual",
        "nodejs-docs",
        "mdn-webdocs",
        "ietf-rfcs",
        "python-docs",
      ])
      .optional(),
    category: z
      .enum([
        "code-reference",
        "plugin-handbook",
        "theme-handbook",
        "block-editor",
        "rest-api",
        "common-apis",
        "coding-standards",
        "admin",
        "scf",
        "php-core",
        "nodejs-runtime",
        "web-platform",
        "software-engineering",
        "python-runtime",
      ])
      .optional(),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
    offset: z.coerce.number().int().min(0).max(100_000).optional().default(0),
  });
  const retrievalParamsSchema = z.object({
    question: z.string().trim().min(3).max(1500),
    category: z.string().trim().optional(),
    doc_type: z.string().trim().optional(),
    top_k: z.coerce.number().int().min(3).max(12).default(6),
  });
  const assistantParamsSchema = z.object({
    question: z.string().trim().min(3).max(1500),
    category: z.string().trim().optional(),
    doc_type: z.string().trim().optional(),
    top_k: z.coerce.number().int().min(3).max(12).default(6),
  });

  // Cookie parser (scoped to admin router)
  router.use(cookieParser());
  router.use(requireSameOriginPost);

  // ── Auth ─────────────────────────────────────────────────────────────────

  router.get("/login", (_req: Request, res: Response) => {
    res.send(loginPage());
  });

  router.post("/login", (req: Request, res: Response) => {
    const password = (req.body as Record<string, string>)["password"] ?? "";
    if (!verifyAdminPassword(password)) {
      res.send(loginPage("Incorrect password. Please try again."));
      return;
    }
    const token = createSession("admin");
    setSessionCookie(res, token);
    res.redirect("/admin");
  });

  router.post("/logout", (req: Request, res: Response) => {
    const token = req.cookies?.["wp_admin_sid"] as string | undefined;
    if (token) destroySession(token);
    clearSessionCookie(res);
    res.redirect("/admin/login");
  });

  // All routes below require auth
  router.use(requireAdminAuth);
  router.use((_req: Request, res: Response, next) => {
    // Admin pages include operational data and controls; avoid browser/proxy caching.
    res.setHeader("Cache-Control", "no-store, private, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    next();
  });

  // ── Dashboard ──────────────────────────────────────────────────────────

  router.get("/", (_req: Request, res: Response) => {
    res.send(page("Dashboard", renderDashboardShell(), "dashboard"));
  });

  router.get("/health", (_req: Request, res: Response) => {
    res.send(page("Health", renderHealthPageShell(), "health"));
  });

  router.get("/health/fragment", (_req: Request, res: Response) => {
    const stats = queries.getStats();
    const analytics = queries.getJobAnalytics(50);
    const qualitySummary = summarizeQualityEvents(readRecentQualityEvents(300));
    const baseline = readReportStatus("baseline");
    const ops = readReportStatus("ops");
    res.send(renderHealthFragment({ stats, analytics, qualitySummary, baseline, ops }));
  });

  router.get("/stats", (req: Request, res: Response) => {
    const stats = queries.getStats();
    const fragment = (req.query["fragment"] as string) ?? "";

    if (fragment === "categories") {
      res.send(renderCategoryChart(stats.byCategory, stats.totalDocs));
      return;
    }
    if (fragment === "errors") {
      res.send(renderRecentErrors(stats.recentErrors));
      return;
    }
    if (fragment === "sources") {
      res.send(renderSourceChart(stats.bySource, stats.totalDocs));
      return;
    }
    res.send(renderStatsFragment(stats));
  });

  // ── Jobs ───────────────────────────────────────────────────────────────

  router.get("/jobs", (_req: Request, res: Response) => {
    const jobs = queries.getJobs();
    const analytics = queries.getJobAnalytics(50);
    res.send(page("Jobs", `${renderJobsAnalytics(analytics)}${renderJobsPage(jobs)}`, "jobs"));
  });

  router.get("/jobs/fragment", (_req: Request, res: Response) => {
    const jobs = queries.getJobs();
    res.send(renderJobsFragment(jobs));
  });

  router.get("/jobs/:id", (req: Request, res: Response) => {
    const rawId = req.params["id"];
    const idValue = Array.isArray(rawId) ? rawId[0] ?? "" : rawId ?? "";
    const id = Number.parseInt(idValue, 10);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).send("Invalid job id.");
      return;
    }
    const job = queries.getJobById(id);
    const previousJob = queries.getPreviousJob(id);
    const errors = queries.getErrorsForJob(id);
    res.send(page(`Job #${id}`, renderJobDetailPage(job, previousJob, errors), "jobs"));
  });

  // ── Search ─────────────────────────────────────────────────────────────

  router.get("/search", (_req: Request, res: Response) => {
    res.send(page("Search", renderSearchPage(), "search"));
  });

  router.get("/quality", (_req: Request, res: Response) => {
    res.send(page("Quality", renderQualityPage(), "quality"));
  });

  router.get("/retrieval", (_req: Request, res: Response) => {
    res.send(page("Retrieval", renderRetrievalPage(), "retrieval"));
  });

  router.get("/assistant", (_req: Request, res: Response) => {
    res.send(page("Wrangler AI", renderAssistantPage(), "assistant"));
  });

  router.post("/assistant/ask", async (req: Request, res: Response) => {
    if (retrievalDiagnosticsInFlight >= Math.max(1, retrievalDiagnosticsMaxInFlight)) {
      res
        .status(429)
        .send(`<div class="text-amber-300 text-sm">Wrangler is busy right now. Try again in a moment.</div>`);
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    const parsed = assistantParamsSchema.safeParse({
      question: body?.["question"],
      category: body?.["category"],
      doc_type: body?.["doc_type"],
      top_k: body?.["top_k"],
    });
    if (!parsed.success) {
      res.status(400).send(`<div class="text-rose-300 text-sm">Invalid assistant input.</div>`);
      return;
    }

    const timeoutMs = (() => {
      const parsedTimeout = Number.parseInt(process.env["ADMIN_ASSISTANT_TIMEOUT_MS"] ?? "16000", 10);
      return Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 16_000;
    })();
    const { question, category, doc_type, top_k } = parsed.data;
    retrievalDiagnosticsInFlight += 1;
    try {
      const result = await withTimeout(
        buildGroundedAnswer(searchQueries, {
          question,
          category: category || undefined,
          doc_type: doc_type || undefined,
          top_k,
          mode: "answer",
        }),
        timeoutMs,
        "assistant answer"
      );
      const verification = verifyGroundedAnswer(result.answer, searchQueries);
      adminAssistantTurns.push({
        ts: Date.now(),
        question,
        answer: result.answer.answer,
        synthesisEngine: result.synthesisEngine,
        confidence: result.answer.confidence,
        abstained: result.answer.abstained,
      });
      while (adminAssistantTurns.length > 100) adminAssistantTurns.shift();

      const citationRows = result.answer.citations.slice(0, 8).map((citation) => [
        `${citation.docId}`,
        escapeHtml(citation.title),
        `<span class="font-mono text-xs text-slate-400">${escapeHtml(citation.slug)}</span>`,
        (() => {
          const safeUrl = safeExternalHref(citation.url);
          return safeUrl
            ? `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noreferrer" class="text-sky-400 hover:text-sky-300 text-xs">open</a>`
            : `<span class="text-slate-600">invalid-url</span>`;
        })(),
      ]);

      res.send(`
<div class="grid grid-cols-2 lg:grid-cols-6 gap-4 mb-4">
  ${statCard("Engine", result.synthesisEngine, result.synthesisEngine === "ollama" ? "emerald" : "amber")}
  ${statCard("Confidence", `${Math.round(result.answer.confidence * 100)}%`, "sky")}
  ${statCard("Abstained", result.answer.abstained ? "yes" : "no", result.answer.abstained ? "amber" : "emerald")}
  ${statCard("Citation", `${Math.round(verification.citationCoverage * 100)}%`, "violet")}
  ${statCard("Unsupported", `${Math.round(verification.unsupportedClaimRate * 100)}%`, verification.unsupportedClaimRate > 0 ? "rose" : "emerald")}
  ${statCard("Latency", `${result.answerLatencyMs}ms`, "slate")}
</div>
<div class="bg-slate-950/50 border border-slate-800 rounded-lg p-4 mb-4 text-sm text-slate-200 leading-relaxed">${formatMultilineText(result.answer.answer)}</div>
<div class="text-xs text-slate-500 mb-4">Retrieval ${result.retrievalLatencyMs}ms | Rerank ${result.rerankLatencyMs}ms | Answer ${result.answerLatencyMs}ms</div>
<h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Top Citations</h3>
${table(["ID", "Title", "Slug", "Link"], citationRows)}
`);
    } catch (error) {
      res.status(500).send(`<div class="text-rose-300 text-sm">Assistant failed: ${escapeHtml(String(error))}</div>`);
    } finally {
      retrievalDiagnosticsInFlight = Math.max(0, retrievalDiagnosticsInFlight - 1);
    }
  });

  router.post("/retrieval/run", async (req: Request, res: Response) => {
    if (retrievalDiagnosticsInFlight >= Math.max(1, retrievalDiagnosticsMaxInFlight)) {
      res
        .status(429)
        .send(`<div class="text-amber-300 text-sm">Retrieval diagnostics are busy. Try again in a moment.</div>`);
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    const parsed = retrievalParamsSchema.safeParse({
      question: body?.["question"],
      category: body?.["category"],
      doc_type: body?.["doc_type"],
      top_k: body?.["top_k"],
    });
    if (!parsed.success) {
      res.status(400).send(`<div class="text-rose-300 text-sm">Invalid retrieval parameters.</div>`);
      return;
    }
    const { question, category, doc_type, top_k } = parsed.data;
    retrievalDiagnosticsInFlight += 1;
    try {
      const timeoutMs = (() => {
        const parsedTimeout = Number.parseInt(process.env["ADMIN_RETRIEVAL_TIMEOUT_MS"] ?? "12000", 10);
        return Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 12_000;
      })();
      const timedResult = await withTimeout(
        buildGroundedAnswer(searchQueries, {
          question,
          category: category || undefined,
          doc_type: doc_type || undefined,
          top_k,
          mode: "answer",
        }),
        timeoutMs,
        "retrieval diagnostics"
      );
      const verification = verifyGroundedAnswer(timedResult.answer, searchQueries);
      const evidenceRows = timedResult.evidence.map((item, idx) => [
        `${idx + 1}`,
        escapeHtml(item.title),
        `<span class="text-xs font-mono text-slate-400">${escapeHtml(item.slug)}</span>`,
        escapeHtml(item.source),
        item.category ? escapeHtml(item.category) : "—",
        (() => {
          const safeUrl = safeExternalHref(item.url);
          return safeUrl
            ? `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noreferrer" class="text-sky-400 hover:text-sky-300 text-xs">open</a>`
            : `<span class="text-slate-600">invalid-url</span>`;
        })(),
      ]);
      res.send(`
<div class="grid grid-cols-2 lg:grid-cols-6 gap-4 mb-6">
  ${statCard("Intent", timedResult.routeIntent, "sky")}
  ${statCard("Evidence", timedResult.evidence.length.toString(), "violet")}
  ${statCard("Citation", `${Math.round(verification.citationCoverage * 100)}%`, "emerald")}
  ${statCard("Unsupported", `${Math.round(verification.unsupportedClaimRate * 100)}%`, verification.unsupportedClaimRate > 0 ? "rose" : "emerald")}
  ${statCard("Confidence", `${Math.round(timedResult.answer.confidence * 100)}%`, "amber")}
  ${statCard("Abstained", timedResult.answer.abstained ? "yes" : "no", timedResult.answer.abstained ? "amber" : "emerald")}
</div>
<div class="bg-slate-900 border border-slate-800 rounded-xl p-5 mb-6">
  <h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Planner Trace</h3>
  <p class="text-xs text-slate-400">${escapeHtml(
    timedResult.answer.plannerTrace?.subquestions.join(" | ") || "No planner trace for this run."
  )}</p>
</div>
<div class="mb-3 text-xs text-slate-500">Answer latency: ${timedResult.answerLatencyMs}ms | Retrieval: ${timedResult.retrievalLatencyMs}ms | Rerank: ${timedResult.rerankLatencyMs}ms</div>
${table(["Rank", "Title", "Slug", "Source", "Category", "Link"], evidenceRows)}
`);
    } catch (error) {
      res.status(500).send(`<div class="text-rose-300 text-sm">Retrieval diagnostic failed: ${escapeHtml(String(error))}</div>`);
    } finally {
      retrievalDiagnosticsInFlight = Math.max(0, retrievalDiagnosticsInFlight - 1);
    }
  });

  router.get("/evals", (_req: Request, res: Response) => {
    res.send(page("Eval/Ops", renderEvalsPageShell(), "evals"));
  });

  router.get("/evals/fragment", (_req: Request, res: Response) => {
    const baseline = readReportStatus("baseline");
    const ops = readReportStatus("ops");
    res.send(renderEvalsFragment(baseline, ops));
  });

  router.post("/evals/run-baseline", (req: Request, res: Response) => {
    if (!allowAdminAction(req, "evals:run-baseline")) {
      res.status(429).send("Too many eval run requests. Please retry shortly.");
      return;
    }
    if (!isConfirmYes(req)) {
      res.status(400).send("Pass ?confirm=yes to run baseline report.");
      return;
    }
    spawnEvalScript("baseline", runBaselineReportInProcess);
    res.status(204).end();
  });

  router.post("/evals/run-ops", (req: Request, res: Response) => {
    if (!allowAdminAction(req, "evals:run-ops")) {
      res.status(429).send("Too many eval run requests. Please retry shortly.");
      return;
    }
    if (!isConfirmYes(req)) {
      res.status(400).send("Pass ?confirm=yes to run ops report.");
      return;
    }
    spawnEvalScript("ops", runOpsReportInProcess);
    res.status(204).end();
  });

  router.get("/controls", (_req: Request, res: Response) => {
    res.send(page("Controls", renderControlsPage(getBeyondRagFlags()), "controls"));
  });

  router.get("/controls/log", (_req: Request, res: Response) => {
    res.send(renderControlsLogFragment());
  });

  router.get("/search/results", (req: Request, res: Response) => {
    const parsed = searchParamsSchema.safeParse({
      q: req.query["q"],
      source: req.query["source"],
      category: req.query["category"],
      limit: req.query["limit"],
      offset: req.query["offset"],
    });
    if (!parsed.success) {
      res.status(400).send("Invalid search query parameters.");
      return;
    }
    const { q, source, category, limit, offset } = parsed.data;
    const results = queries.searchDocs(q, limit, offset, { source, category });
    const total = queries.countSearchDocs(q, { source, category });
    res.send(renderSearchResults(results, total, q, { source, category }));
  });

  // ── Scraper ────────────────────────────────────────────────────────────

  router.get("/scraper", (_req: Request, res: Response) => {
    res.send(page("Scraper", renderScraperPage(), "scraper"));
  });

  router.post("/scraper/trigger", (req: Request, res: Response) => {
    if (!allowAdminAction(req, "scraper:trigger")) {
      pushAdminAction("scraper:trigger", "error", "Rate limited high-frequency trigger attempts.");
      res.status(429).send("Too many trigger attempts. Please retry shortly.");
      return;
    }
    if (!isConfirmYes(req)) {
      pushAdminAction("scraper:trigger", "error", "Rejected because confirm=yes was missing.");
      res.status(400).send("Pass ?confirm=yes to trigger scraper.");
      return;
    }
    if (scraperRunner.status === "running") {
      pushAdminAction("scraper:trigger", "error", "Rejected because scraper is already running.");
      res.status(409).send("Scraper is already running");
      return;
    }

    const ingestTypes = process.env["INGEST_TYPES"];
    const env = ingestTypes ? { INGEST_TYPES: ingestTypes } : undefined;
    const { entrypoint, source, checkedPaths } = resolveScraperEntrypoint();

    if (!existsSync(entrypoint)) {
      const details =
        `Scraper entrypoint not found at "${entrypoint}". ` +
        `cwd="${process.cwd()}". Checked: ${checkedPaths.join(", ")}`;
      scraperRunner.addSystemMessage(details);
      pushAdminAction("scraper:trigger", "error", details);
      res.status(500).send(details);
      return;
    }

    scraperRunner.addSystemMessage(
      `Resolved scraper entrypoint: ${entrypoint} (source: ${source})`
    );
    void scraperRunner.run(entrypoint, env);
    pushAdminAction("scraper:trigger", "ok", `Started run with entrypoint ${entrypoint}.`);

    res
      .status(204)
      .setHeader("HX-Trigger", "scraperStarted")
      .end();
  });

  router.post("/scraper/kill", (req: Request, res: Response) => {
    if (!allowAdminAction(req, "scraper:kill")) {
      pushAdminAction("scraper:kill", "error", "Rate limited high-frequency kill attempts.");
      res.status(429).send("Too many kill attempts. Please retry shortly.");
      return;
    }
    if (!isConfirmYes(req)) {
      pushAdminAction("scraper:kill", "error", "Rejected because confirm=yes was missing.");
      res.status(400).send("Pass ?confirm=yes to kill scraper.");
      return;
    }
    scraperRunner.kill();
    pushAdminAction("scraper:kill", "ok", "Sent kill signal to scraper process.");
    res.status(204).end();
  });

  router.get("/scraper/status", (_req: Request, res: Response) => {
    const { status, exitCode, startedAt } = scraperRunner;
    res.send(renderScraperStatus(status, exitCode, startedAt));
  });

  router.get("/scraper/log", (_req: Request, res: Response) => {
    const lines = scraperRunner.tail(100);
    res.send(renderLogOutput(lines));
  });

  router.get("/scraper/checkpoints", (_req: Request, res: Response) => {
    const checkpoints = queries.getCheckpoints();
    res.send(renderCheckpoints(checkpoints));
  });

  router.post("/scraper/rebuild-fts", (req: Request, res: Response) => {
    if (!allowAdminAction(req, "scraper:rebuild-fts")) {
      pushAdminAction("scraper:rebuild-fts", "error", "Rate limited high-frequency rebuild attempts.");
      res.status(429).send("Too many rebuild attempts. Please retry shortly.");
      return;
    }
    if (!isConfirmYes(req)) {
      pushAdminAction("scraper:rebuild-fts", "error", "Rejected because confirm=yes was missing.");
      res.status(400).send("Pass ?confirm=yes to rebuild FTS.");
      return;
    }
    try {
      queries.rebuildFts();
      pushAdminAction("scraper:rebuild-fts", "ok", "Triggered FTS rebuild.");
      res.status(204).end();
    } catch (err) {
      pushAdminAction("scraper:rebuild-fts", "error", String(err));
      res.status(500).send(String(err));
    }
  });

  router.post("/scraper/wipe", (req: Request, res: Response) => {
    if ((req.query["confirm"] as string) !== "yes") {
      pushAdminAction("scraper:wipe", "error", "Rejected because confirm=yes was missing.");
      res.status(400).send("Pass ?confirm=yes to confirm wipe");
      return;
    }
    try {
      queries.deleteAllDocs();
      pushAdminAction("scraper:wipe", "ok", "Deleted all documents and reset checkpoints.");
      res.redirect("/admin/scraper");
    } catch (err) {
      pushAdminAction("scraper:wipe", "error", String(err));
      res.status(500).send(String(err));
    }
  });

  router.post("/scraper/errors/clear", (req: Request, res: Response) => {
    if (!allowAdminAction(req, "scraper:clear-errors")) {
      pushAdminAction("scraper:clear-errors", "error", "Rate limited high-frequency clear attempts.");
      res.status(429).send("Too many clear attempts. Please retry shortly.");
      return;
    }
    if (!isConfirmYes(req)) {
      pushAdminAction("scraper:clear-errors", "error", "Rejected because confirm=yes was missing.");
      res.status(400).send("Pass ?confirm=yes to clear scrape errors.");
      return;
    }
    try {
      queries.deleteScrapeErrors();
      const stats = queries.getStats();
      pushAdminAction("scraper:clear-errors", "ok", "Cleared scrape error history.");
      res.send(renderRecentErrors(stats.recentErrors));
    } catch (err) {
      pushAdminAction("scraper:clear-errors", "error", String(err));
      res.status(500).send(String(err));
    }
  });

  return router;
}
