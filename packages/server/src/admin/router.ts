import { Router } from "express";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
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

<!-- Two-column layout: categories + recent errors -->
<div class="grid grid-cols-1 lg:grid-cols-2 gap-8">

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

  <!-- Recent scrape errors -->
  <div class="bg-slate-900 border border-slate-800 rounded-xl p-6">
    <div class="flex items-center justify-between mb-5">
      <h2 class="text-sm font-semibold text-slate-200 uppercase tracking-wider">Recent Errors</h2>
      <button
        hx-post="/admin/scraper/errors/clear"
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
  ${statCard("Categories", stats.byCategory.length.toString(), "violet")}
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
    `<span class="font-mono text-slate-400 text-xs">#${j.id}</span>`,
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

// ── Search page ──────────────────────────────────────────────────────────────

function renderSearchPage(): string {
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
    hx-trigger="submit, input[name='q'] changed delay:400ms"
    class="flex gap-3"
  >
    <input
      name="q"
      type="search"
      placeholder="Search by title, slug, or URL…"
      autofocus
      class="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-slate-100 placeholder-slate-600
             focus:outline-none focus:ring-2 focus:ring-sky-500/50 focus:border-sky-500/50 transition-colors"
    />
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
  q: string
): string {
  if (results.length === 0) {
    return `<div class="text-center py-12 text-slate-500 text-sm">No documents found${q ? ` for "${escapeHtml(q)}"` : ""}.</div>`;
  }

  const rows = results.map((r) => [
    `<span class="font-mono text-slate-500 text-xs">${r.id}</span>`,
    `<span class="font-medium text-slate-200">${escapeHtml(r.title)}</span>`,
    `<span class="font-mono text-xs text-slate-400">${escapeHtml(r.slug)}</span>`,
    escapeHtml(r.doc_type),
    r.category ? escapeHtml(r.category) : `<span class="text-slate-600">—</span>`,
    `<a href="${escapeHtml(r.url)}" target="_blank" rel="noreferrer" class="text-sky-400 hover:text-sky-300 text-xs truncate max-w-xs inline-block transition-colors">${escapeHtml(r.url)}</a>`,
  ]);

  const heading =
    q
      ? `Showing ${results.length.toLocaleString()} of ${total.toLocaleString()} results for "<strong class="text-slate-200">${escapeHtml(q)}</strong>"`
      : `${total.toLocaleString()} documents total`;

  return `<div class="mb-4 text-xs text-slate-500">${heading}</div>
${table(["ID", "Title", "Slug", "Type", "Category", "URL"], rows)}`;
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
      hx-post="/admin/scraper/trigger"
      hx-swap="none"
      hx-confirm="Start a full scrape run?"
      class="bg-sky-600 hover:bg-sky-500 active:bg-sky-700 text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
    >
      Run Scraper
    </button>
    <button
      hx-post="/admin/scraper/kill"
      hx-swap="none"
      class="bg-slate-700 hover:bg-slate-600 active:bg-slate-800 text-slate-200 text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
    >
      Kill
    </button>
    <button
      hx-post="/admin/scraper/errors/clear"
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
        hx-post="/admin/scraper/rebuild-fts"
        hx-swap="none"
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

// ── Router factory ───────────────────────────────────────────────────────────

export function createAdminRouter(db: Database.Database): ReturnType<typeof Router> {
  const router = Router();
  const queries = buildAdminQueries(db);
  const searchParamsSchema = z.object({
    q: z.string().trim().max(500).optional().default(""),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
    offset: z.coerce.number().int().min(0).max(100_000).optional().default(0),
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

  // ── Dashboard ──────────────────────────────────────────────────────────

  router.get("/", (_req: Request, res: Response) => {
    res.send(page("Dashboard", renderDashboardShell(), "dashboard"));
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
    res.send(renderStatsFragment(stats));
  });

  // ── Jobs ───────────────────────────────────────────────────────────────

  router.get("/jobs", (_req: Request, res: Response) => {
    const jobs = queries.getJobs();
    res.send(page("Jobs", renderJobsPage(jobs), "jobs"));
  });

  router.get("/jobs/fragment", (_req: Request, res: Response) => {
    const jobs = queries.getJobs();
    res.send(renderJobsFragment(jobs));
  });

  // ── Search ─────────────────────────────────────────────────────────────

  router.get("/search", (_req: Request, res: Response) => {
    res.send(page("Search", renderSearchPage(), "search"));
  });

  router.get("/search/results", (req: Request, res: Response) => {
    const parsed = searchParamsSchema.safeParse({
      q: req.query["q"],
      limit: req.query["limit"],
      offset: req.query["offset"],
    });
    if (!parsed.success) {
      res.status(400).send("Invalid search query parameters.");
      return;
    }
    const { q, limit, offset } = parsed.data;
    const results = queries.searchDocs(q, limit, offset);
    const total = queries.countSearchDocs(q);
    res.send(renderSearchResults(results, total, q));
  });

  // ── Scraper ────────────────────────────────────────────────────────────

  router.get("/scraper", (_req: Request, res: Response) => {
    res.send(page("Scraper", renderScraperPage(), "scraper"));
  });

  router.post("/scraper/trigger", (_req: Request, res: Response) => {
    if (scraperRunner.status === "running") {
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
      res.status(500).send(details);
      return;
    }

    scraperRunner.addSystemMessage(
      `Resolved scraper entrypoint: ${entrypoint} (source: ${source})`
    );
    void scraperRunner.run(entrypoint, env);

    res
      .status(204)
      .setHeader("HX-Trigger", "scraperStarted")
      .end();
  });

  router.post("/scraper/kill", (_req: Request, res: Response) => {
    scraperRunner.kill();
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

  router.post("/scraper/rebuild-fts", (_req: Request, res: Response) => {
    try {
      queries.rebuildFts();
      res.status(204).end();
    } catch (err) {
      res.status(500).send(String(err));
    }
  });

  router.post("/scraper/wipe", (req: Request, res: Response) => {
    if ((req.query["confirm"] as string) !== "yes") {
      res.status(400).send("Pass ?confirm=yes to confirm wipe");
      return;
    }
    try {
      queries.deleteAllDocs();
      res.redirect("/admin/scraper");
    } catch (err) {
      res.status(500).send(String(err));
    }
  });

  router.post("/scraper/errors/clear", (_req: Request, res: Response) => {
    try {
      queries.deleteScrapeErrors();
      const stats = queries.getStats();
      res.send(renderRecentErrors(stats.recentErrors));
    } catch (err) {
      res.status(500).send(String(err));
    }
  });

  return router;
}
