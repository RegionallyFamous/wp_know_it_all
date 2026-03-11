import { join } from "node:path";
import { DEVHUB_CONTENT_TYPES } from "@wp-know-it-all/shared";
import { openWriterDb, applyScraperSchema, buildWriter } from "./db/writer.js";
import { ingestDevhubContentType } from "./ingestors/devhub-api.js";
import { ingestGutenbergDocs } from "./ingestors/gutenberg-docs.js";
import { ingestWpCliHandbook } from "./ingestors/wpcli-handbook.js";
import { getCuratedBestPractices } from "./lib/best-practices.js";
import { JobTracker } from "./lib/job-tracker.js";
import type { InsertableDocument } from "./db/writer.js";

// ── Config ───────────────────────────────────────────────────────────────────
const volumePath = process.env["RAILWAY_VOLUME_MOUNT_PATH"] ?? "./data";
const dbPath = join(volumePath, "wordpress.db");

// INGEST_TYPES=wp-parser-function,plugin-handbook  — run a subset only
const typeFilter = process.env["INGEST_TYPES"]?.split(",").map((s) => s.trim());

// INCREMENTAL=1 — only fetch docs modified since last successful run
const isIncremental = process.env["INCREMENTAL"] === "1";

// SKIP_GITHUB=1 — skip GitHub clone sources (useful in memory-constrained envs)
const skipGithub = process.env["SKIP_GITHUB"] === "1";

// SKIP_CURATED=1 — skip curated best-practice examples
const skipCurated = process.env["SKIP_CURATED"] === "1";

async function main(): Promise<void> {
  console.log(`\n[scraper] WP Know It All — Documentation Scraper`);
  console.log(`[scraper] Database: ${dbPath}`);
  console.log(`[scraper] Mode: ${isIncremental ? "incremental" : "full"}`);
  console.log(`[scraper] Started at: ${new Date().toISOString()}\n`);

  const db = openWriterDb(dbPath);
  applyScraperSchema(db);
  const writer = buildWriter(db);
  const tracker = new JobTracker(db);

  const jobId = tracker.createJob();
  console.log(`[scraper] Job ID: ${jobId}`);

  const startCount = writer.count();
  console.log(`[scraper] Existing documents: ${startCount.toLocaleString()}`);

  const summary: Record<string, { docs: number; errors: number }> = {};
  let totalDocs = 0;
  let totalErrors = 0;
  let hasSourceFailures = false;

  // ── Phase 1: DevHub REST API ────────────────────────────────────────────────
  const contentTypes = typeFilter
    ? DEVHUB_CONTENT_TYPES.filter((t) => typeFilter.includes(t.type))
    : DEVHUB_CONTENT_TYPES;

  console.log(`\n[scraper] Phase 1: DevHub REST API (${contentTypes.length} content types)`);

  for (const typeConfig of contentTypes) {
    tracker.startSource(jobId, typeConfig.type);

    // Determine incremental cutoff from last checkpoint
    let modifiedAfter: string | undefined;
    let startPage = 1;

    if (isIncremental) {
      const cp = tracker.getCheckpoint(typeConfig.type);
      if (cp?.last_run_at) {
        modifiedAfter = new Date(cp.last_run_at * 1000).toISOString();
        console.log(`[scraper] ${typeConfig.type}: incremental from ${modifiedAfter}`);
      }
      // If a previous run was interrupted mid-page, resume from there
      if (cp?.status === "running" && cp.last_page > 0) {
        startPage = cp.last_page;
        console.log(`[scraper] ${typeConfig.type}: resuming from page ${startPage}`);
      }
    }

    let sourceDocs = 0;
    let sourceErrors = 0;

    try {
      const result = await ingestDevhubContentType(typeConfig, {
        modifiedAfter,
        startPage,
        onPageComplete: (page, _total, _fetched) => {
          tracker.saveCheckpoint(typeConfig.type, page);
        },
      });
      const docs = result.documents;
      const failedPages = result.failedPages;

      if (docs.length > 0) {
        writer.insertBatch(docs);
        sourceDocs = docs.length;
        totalDocs += docs.length;
        console.log(
          `[scraper] ✓ ${typeConfig.type}: ${docs.length} docs (total: ${writer.count().toLocaleString()})`
        );
      }

      if (failedPages.length > 0) {
        hasSourceFailures = true;
        sourceErrors += failedPages.length;
        totalErrors += failedPages.length;
        const errorMsg = `Failed pages: ${failedPages.join(", ")}`;
        tracker.logError(jobId, typeConfig.type, null, errorMsg);
        tracker.failSource(jobId, typeConfig.type, errorMsg);
        console.warn(`[scraper] ✗ ${typeConfig.type}: ${errorMsg}`);
      } else {
        tracker.completeSource(jobId, typeConfig.type, sourceDocs, sourceErrors);
      }
    } catch (err) {
      const msg = String(err);
      console.error(`[scraper] ✗ ${typeConfig.type} failed: ${msg}`);
      tracker.logError(jobId, typeConfig.type, null, msg);
      tracker.failSource(jobId, typeConfig.type, msg);
      sourceErrors++;
      totalErrors++;
      hasSourceFailures = true;
    }

    summary[typeConfig.type] = { docs: sourceDocs, errors: sourceErrors };
  }

  // ── Phase 2: GitHub sources ─────────────────────────────────────────────────
  if (!skipGithub) {
    console.log("\n[scraper] Phase 2: GitHub sources");

    for (const [name, ingest] of [
      ["gutenberg-docs", ingestGutenbergDocs],
      ["wpcli-handbook", ingestWpCliHandbook],
    ] as [string, () => Promise<InsertableDocument[]>][]) {
      tracker.startSource(jobId, name);

      try {
        const docs = await ingest();
        if (docs.length > 0) {
          writer.insertBatch(docs);
          totalDocs += docs.length;
          console.log(
            `[scraper] ✓ ${name}: ${docs.length} docs (total: ${writer.count().toLocaleString()})`
          );
        }
        tracker.completeSource(jobId, name, docs.length, 0);
        summary[name] = { docs: docs.length, errors: 0 };
      } catch (err) {
        const msg = String(err);
        console.error(`[scraper] ✗ ${name} failed: ${msg}`);
        tracker.logError(jobId, name, null, msg);
        tracker.failSource(jobId, name, msg);
        totalErrors++;
        hasSourceFailures = true;
        summary[name] = { docs: 0, errors: 1 };
      }
    }
  }

  // ── Phase 3: Curated best practices ─────────────────────────────────────────
  if (!skipCurated) {
    console.log("\n[scraper] Phase 3: Curated best practices");
    tracker.startSource(jobId, "curated");

    try {
      const bestPractices = getCuratedBestPractices();
      writer.insertBatch(bestPractices);
      totalDocs += bestPractices.length;
      tracker.completeSource(jobId, "curated", bestPractices.length, 0);
      summary["curated"] = { docs: bestPractices.length, errors: 0 };
      console.log(`[scraper] ✓ Curated best practices: ${bestPractices.length} docs`);
    } catch (err) {
      const msg = String(err);
      console.error(`[scraper] ✗ Curated best practices failed: ${msg}`);
      tracker.logError(jobId, "curated", null, msg);
      tracker.failSource(jobId, "curated", msg);
      totalErrors++;
      hasSourceFailures = true;
    }
  }

  // ── Finalize ─────────────────────────────────────────────────────────────────
  const finalCount = writer.count();
  const summaryPayload = { summary, totalDocs, totalErrors, finalCount };
  if (hasSourceFailures) {
    tracker.failJob(jobId, summaryPayload);
  } else {
    tracker.completeJob(jobId, summaryPayload);
  }

  console.log(`\n[scraper] ══════════════════════════════════`);
  console.log(`[scraper] Run complete at: ${new Date().toISOString()}`);
  console.log(`[scraper] Documents processed this run: ${totalDocs.toLocaleString()}`);
  console.log(`[scraper] Total in database: ${finalCount.toLocaleString()}`);
  console.log(`[scraper] Errors: ${totalErrors}`);
  console.log(`[scraper] ══════════════════════════════════\n`);

  db.close();
  process.exit(hasSourceFailures ? 1 : 0);
}

main().catch((err) => {
  console.error("[scraper] Fatal error:", err);
  process.exit(1);
});
