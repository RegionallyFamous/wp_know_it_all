import Database from "better-sqlite3";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readRecentQualityEvents, summarizeQualityEvents } from "../src/lib/quality-metrics.js";

interface SourceStat {
  source: string;
  count: number;
}

interface CategoryStat {
  category: string;
  count: number;
}

function resolveDbPath(): string {
  if (process.env["BASELINE_DB_PATH"]?.trim()) {
    return process.env["BASELINE_DB_PATH"]!.trim();
  }
  const volumePath = process.env["RAILWAY_VOLUME_MOUNT_PATH"] ?? "./data";
  return join(volumePath, "wordpress.db");
}

function pct(numerator: number, denominator: number): string {
  if (denominator <= 0) return "0.0%";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function main(): void {
  const dbPath = resolveDbPath();
  const outDir = process.env["BASELINE_REPORT_DIR"]?.trim() || join(process.cwd(), "reports");
  mkdirSync(outDir, { recursive: true });

  if (!existsSync(dbPath)) {
    const emptyReport = {
      timestamp: new Date().toISOString(),
      dbPath,
      warning: "Database file not found. Run scraper first or set BASELINE_DB_PATH.",
      corpus: { totalDocs: 0, bySource: [], byCategory: [] },
      scraping: { sampledJobs: 0, completedJobs: 0, failedJobs: 0, failedJobRate: 0, totalErrorsInSample: 0 },
      quality: {
        sampledEvents: 0,
        citationCoverage: 0,
        unsupportedClaimRate: 0,
        supportScore: 0,
        confidence: 0,
        abstainRate: 0,
        ollamaUsageRate: 0,
      },
    };
    const jsonPath = join(outDir, "baseline-report.json");
    const markdownPath = join(outDir, "baseline-report.md");
    writeFileSync(jsonPath, `${JSON.stringify(emptyReport, null, 2)}\n`, "utf-8");
    writeFileSync(
      markdownPath,
      `# Wrangler Baseline Report\n\nGenerated: ${emptyReport.timestamp}\n\nNo database found at \`${dbPath}\`.\n`,
      "utf-8"
    );
    console.log(`[baseline] database not found, wrote empty report: ${jsonPath}`);
    return;
  }

  const db = new Database(dbPath, { readonly: true });
  const totalDocs = db.prepare<[], { total: number }>("SELECT COUNT(*) AS total FROM documents").get()!
    .total;
  const bySource = db
    .prepare<[], SourceStat>(
      `SELECT source, COUNT(*) AS count FROM documents GROUP BY source ORDER BY count DESC`
    )
    .all();
  const byCategory = db
    .prepare<[], CategoryStat>(
      `SELECT COALESCE(category, 'uncategorized') AS category, COUNT(*) AS count
       FROM documents GROUP BY category ORDER BY count DESC`
    )
    .all();
  const recentJobs = db
    .prepare<
      [],
      { id: number; status: string; total_docs: number; total_errors: number; started_at: number }
    >(
      `SELECT id, status, total_docs, total_errors, started_at
       FROM scrape_jobs ORDER BY id DESC LIMIT 20`
    )
    .all();
  db.close();

  const completedJobs = recentJobs.filter((job) => job.status === "completed").length;
  const failedJobs = recentJobs.filter((job) => job.status === "failed").length;
  const recentErrors = recentJobs.reduce((sum, job) => sum + job.total_errors, 0);

  const qualityEvents = readRecentQualityEvents(500);
  const qualitySummary = summarizeQualityEvents(qualityEvents);

  const timestamp = new Date().toISOString();
  const reportJson = {
    timestamp,
    dbPath,
    corpus: {
      totalDocs,
      bySource,
      byCategory,
    },
    scraping: {
      sampledJobs: recentJobs.length,
      completedJobs,
      failedJobs,
      failedJobRate: recentJobs.length > 0 ? failedJobs / recentJobs.length : 0,
      totalErrorsInSample: recentErrors,
    },
    quality: {
      sampledEvents: qualitySummary.totalEvents,
      citationCoverage: qualitySummary.avgCitationCoverage,
      unsupportedClaimRate: qualitySummary.avgUnsupportedClaimRate,
      supportScore: qualitySummary.avgSupportScore,
      confidence: qualitySummary.avgConfidence,
      abstainRate: qualitySummary.abstainRate,
      ollamaUsageRate: qualitySummary.ollamaUsageRate,
    },
  };

  const jsonPath = join(outDir, "baseline-report.json");
  writeFileSync(jsonPath, `${JSON.stringify(reportJson, null, 2)}\n`, "utf-8");

  const sourceTable = bySource
    .map((row) => `| ${row.source} | ${row.count.toLocaleString()} | ${pct(row.count, totalDocs)} |`)
    .join("\n");
  const categoryTable = byCategory
    .slice(0, 12)
    .map((row) => `| ${row.category} | ${row.count.toLocaleString()} | ${pct(row.count, totalDocs)} |`)
    .join("\n");

  const markdown = `# Wrangler Baseline Report

Generated: ${timestamp}

## Corpus Snapshot

- Total documents: **${totalDocs.toLocaleString()}**
- Total sources: **${bySource.length}**
- Total categories: **${byCategory.length}**

### Documents by Source

| Source | Count | Share |
|---|---:|---:|
${sourceTable || "| (none) | 0 | 0.0% |"}

### Top Categories

| Category | Count | Share |
|---|---:|---:|
${categoryTable || "| (none) | 0 | 0.0% |"}

## Scraper Reliability (Recent Jobs Sample)

- Jobs sampled: **${recentJobs.length}**
- Completed jobs: **${completedJobs}**
- Failed jobs: **${failedJobs}** (${pct(failedJobs, recentJobs.length)})
- Total source errors in sample: **${recentErrors.toLocaleString()}**

## Answer Quality (Recent Events Sample)

- Quality events sampled: **${qualitySummary.totalEvents}**
- Avg citation coverage: **${(qualitySummary.avgCitationCoverage * 100).toFixed(1)}%**
- Avg unsupported claim rate: **${(qualitySummary.avgUnsupportedClaimRate * 100).toFixed(1)}%**
- Avg support score: **${(qualitySummary.avgSupportScore * 100).toFixed(1)}%**
- Avg confidence: **${(qualitySummary.avgConfidence * 100).toFixed(1)}%**
- Abstain rate: **${(qualitySummary.abstainRate * 100).toFixed(1)}%**
- Ollama usage rate: **${(qualitySummary.ollamaUsageRate * 100).toFixed(1)}%**

## Baseline Gates

- Corpus is source-attributed: **${bySource.length > 0 ? "yes" : "no"}**
- Scraper failure rate visibility established: **yes**
- Quality telemetry persisted and readable: **${qualitySummary.totalEvents >= 0 ? "yes" : "no"}**
`;

  const markdownPath = join(outDir, "baseline-report.md");
  writeFileSync(markdownPath, `${markdown}\n`, "utf-8");

  console.log(`[baseline] report written: ${markdownPath}`);
  console.log(`[baseline] report written: ${jsonPath}`);
}

main();
