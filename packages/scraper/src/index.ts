import { join } from "node:path";
import { DEVHUB_CONTENT_TYPES } from "@wp-know-it-all/shared";
import { openWriterDb, applyScraperSchema, buildWriter } from "./db/writer.js";
import { ingestDevhubContentType } from "./ingestors/devhub-api.js";
import { ingestGutenbergDocs } from "./ingestors/gutenberg-docs.js";
import { ingestWpCliHandbook } from "./ingestors/wpcli-handbook.js";
import { ingestPhpManual } from "./ingestors/php-manual.js";
import { ingestNodejsDocs } from "./ingestors/nodejs-docs.js";
import { ingestMdnWebDocs } from "./ingestors/mdn-webdocs.js";
import { ingestIetfRfcs } from "./ingestors/ietf-rfcs.js";
import { ingestPythonDocs } from "./ingestors/python-docs.js";
import { getCuratedBestPractices } from "./lib/best-practices.js";
import { JobTracker } from "./lib/job-tracker.js";
import type { InsertableDocument } from "./db/writer.js";
import { ADJACENT_SOURCE_ORDER, type AdjacentSourceType } from "./ingestors/adjacent-manifests.js";
import {
  ingestWordPressGithubRepo,
  selectWordPressGithubRepos,
} from "./ingestors/wordpress-github-generic.js";

// ── Config ───────────────────────────────────────────────────────────────────
const volumePath = process.env["RAILWAY_VOLUME_MOUNT_PATH"] ?? "./data";
const dbPath = join(volumePath, "wordpress.db");

// INGEST_TYPES=wp-parser-function,plugin-handbook  — run a subset only
const typeFilter = process.env["INGEST_TYPES"]?.split(",").map((s) => s.trim());

// INCREMENTAL=1 — only fetch docs modified since last successful run
const isIncremental = process.env["INCREMENTAL"] === "1";

// SKIP_GITHUB=1 — skip GitHub clone sources (useful in memory-constrained envs)
const skipGithub = process.env["SKIP_GITHUB"] === "1";

// SKIP_GITHUB_WORDPRESS=1 — skip curated WordPress GitHub source manifests.
const skipGithubWordPress = process.env["SKIP_GITHUB_WORDPRESS"] === "1";

// SKIP_CURATED=1 — skip curated best-practice examples
const skipCurated = process.env["SKIP_CURATED"] === "1";

// SKIP_ADJACENT=1 — skip adjacent ecosystem docs (PHP/Node/MDN)
const skipAdjacent = process.env["SKIP_ADJACENT"] === "1";

// INGEST_ADJACENT_TYPES=php-manual,nodejs-docs — run subset of adjacent sources
const adjacentTypeFilter = process.env["INGEST_ADJACENT_TYPES"]
  ?.split(",")
  .map((s) => s.trim())
  .filter((s): s is AdjacentSourceType =>
    (ADJACENT_SOURCE_ORDER as string[]).includes(s)
  );

// GITHUB_REPOS=wordpress-develop,playground — select a subset of WordPress GitHub repos
const githubRepoFilter = process.env["GITHUB_REPOS"]
  ?.split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

// GITHUB_TIER=tier1|tier2 — tier1 defaults to curated high-signal repos
const githubTier = process.env["GITHUB_TIER"] === "tier2" ? "tier2" : "tier1";

// GITHUB_MAX_DOCS_PER_REPO=120 — optional hard cap over manifest defaults
const githubMaxDocsPerRepo = process.env["GITHUB_MAX_DOCS_PER_REPO"]
  ? Number.parseInt(process.env["GITHUB_MAX_DOCS_PER_REPO"], 10)
  : undefined;

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
        onDocumentsBatch: (docs) => {
          if (docs.length === 0) return;
          writer.insertBatch(docs);
          sourceDocs += docs.length;
          totalDocs += docs.length;
        },
      });
      const failedPages = result.failedPages;

      if (sourceDocs > 0) {
        console.log(
          `[scraper] ✓ ${typeConfig.type}: ${sourceDocs} docs (total: ${writer.count().toLocaleString()})`
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

  // ── Phase 2: Adjacent ecosystem sources ─────────────────────────────────────
  if (!skipAdjacent) {
    const adjacentSources = adjacentTypeFilter
      ? ADJACENT_SOURCE_ORDER.filter((type) => adjacentTypeFilter.includes(type))
      : ADJACENT_SOURCE_ORDER;
    console.log(`\n[scraper] Phase 2: Adjacent docs (${adjacentSources.length} sources)`);

    const ingestorsByType: Record<AdjacentSourceType, () => Promise<InsertableDocument[]>> = {
      "php-manual": ingestPhpManual,
      "nodejs-docs": ingestNodejsDocs,
      "mdn-webdocs": ingestMdnWebDocs,
      "ietf-rfcs": ingestIetfRfcs,
      "python-docs": ingestPythonDocs,
    };

    for (const sourceType of adjacentSources) {
      tracker.startSource(jobId, sourceType);
      let docsCount = 0;
      try {
        const docs = await ingestorsByType[sourceType]();
        if (docs.length > 0) {
          writer.insertBatch(docs);
          totalDocs += docs.length;
          docsCount = docs.length;
          console.log(
            `[scraper] ✓ ${sourceType}: ${docs.length} docs (total: ${writer.count().toLocaleString()})`
          );
        }
        tracker.completeSource(jobId, sourceType, docs.length, 0);
        summary[sourceType] = { docs: docs.length, errors: 0 };
      } catch (err) {
        const msg = String(err);
        console.error(`[scraper] ✗ ${sourceType} failed: ${msg}`);
        tracker.logError(jobId, sourceType, null, msg);
        tracker.failSource(jobId, sourceType, msg);
        totalErrors++;
        hasSourceFailures = true;
        summary[sourceType] = { docs: docsCount, errors: 1 };
      }
    }
  }

  // ── Phase 3: GitHub sources ─────────────────────────────────────────────────
  if (!skipGithub) {
    console.log("\n[scraper] Phase 3: GitHub sources");

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

    if (!skipGithubWordPress) {
      const wpRepos = selectWordPressGithubRepos({
        tier: githubTier,
        repoKeys: githubRepoFilter,
      });
      console.log(
        `[scraper] Phase 3b: WordPress GitHub curated repos (${wpRepos.length} selected, tier=${githubTier})`
      );

      for (const repo of wpRepos) {
        const sourceKey = `wordpress-github:${repo.key}`;
        tracker.startSource(jobId, sourceKey);

        try {
          const docs = await ingestWordPressGithubRepo({
            repoKey: repo.key,
            maxDocs: githubMaxDocsPerRepo && githubMaxDocsPerRepo > 0 ? githubMaxDocsPerRepo : undefined,
          });
          if (docs.length > 0) {
            writer.insertBatch(docs);
            totalDocs += docs.length;
            console.log(
              `[scraper] ✓ ${sourceKey}: ${docs.length} docs (total: ${writer.count().toLocaleString()})`
            );
          }
          tracker.completeSource(jobId, sourceKey, docs.length, 0);
          summary[sourceKey] = { docs: docs.length, errors: 0 };
        } catch (err) {
          const msg = String(err);
          console.error(`[scraper] ✗ ${sourceKey} failed: ${msg}`);
          tracker.logError(jobId, sourceKey, null, msg);
          tracker.failSource(jobId, sourceKey, msg);
          totalErrors++;
          hasSourceFailures = true;
          summary[sourceKey] = { docs: 0, errors: 1 };
        }
      }
    }
  }

  // ── Phase 4: Curated best practices ─────────────────────────────────────────
  if (!skipCurated) {
    console.log("\n[scraper] Phase 4: Curated best practices");
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
