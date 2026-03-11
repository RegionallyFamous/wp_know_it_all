import Database from "better-sqlite3";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRecentQualityEvents, summarizeQualityEvents } from "../src/lib/quality-metrics.js";

function resolveDbPath(): string {
  if (process.env["OPS_DB_PATH"]?.trim()) return process.env["OPS_DB_PATH"]!.trim();
  const volumePath = process.env["RAILWAY_VOLUME_MOUNT_PATH"] ?? "./data";
  return join(volumePath, "wordpress.db");
}

function main(): void {
  const dbPath = resolveDbPath();
  const reportDir = process.env["OPS_REPORT_DIR"]?.trim() || join(process.cwd(), "reports");
  mkdirSync(reportDir, { recursive: true });

  if (!existsSync(dbPath)) {
    const outputPath = join(reportDir, "ops-slo-report.md");
    const ts = new Date().toISOString();
    writeFileSync(
      outputPath,
      `# Operations SLO Report\n\nGenerated: ${ts}\n\nNo database found at \`${dbPath}\`.\n`,
      "utf-8"
    );
    console.log(`[ops] database not found, wrote empty report: ${outputPath}`);
    return;
  }

  const db = new Database(dbPath, { readonly: true });
  const jobs = db
    .prepare<[], { status: string; total_errors: number }>(
      `SELECT status, total_errors FROM scrape_jobs ORDER BY id DESC LIMIT 30`
    )
    .all();
  db.close();

  const sampled = jobs.length;
  const completed = jobs.filter((job) => job.status === "completed").length;
  const failed = jobs.filter((job) => job.status === "failed").length;
  const sampleErrors = jobs.reduce((sum, job) => sum + job.total_errors, 0);
  const successRate = sampled > 0 ? completed / sampled : 1;
  const failureRate = sampled > 0 ? failed / sampled : 0;

  const quality = summarizeQualityEvents(readRecentQualityEvents(300));
  const slo = {
    scrapeSuccessRate: {
      target: 0.9,
      current: successRate,
      pass: successRate >= 0.9,
    },
    scrapeFailureRate: {
      targetMax: 0.1,
      current: failureRate,
      pass: failureRate <= 0.1,
    },
    unsupportedClaimRate: {
      targetMax: 0.12,
      current: quality.avgUnsupportedClaimRate,
      pass: quality.avgUnsupportedClaimRate <= 0.12,
    },
    citationCoverage: {
      targetMin: 0.6,
      current: quality.avgCitationCoverage,
      pass: quality.avgCitationCoverage >= 0.6,
    },
  } as const;

  const allPass = Object.values(slo).every((item) => item.pass);
  const ts = new Date().toISOString();
  const markdown = `# Operations SLO Report

Generated: ${ts}

## Scraper Reliability

- Jobs sampled: **${sampled}**
- Completed: **${completed}**
- Failed: **${failed}**
- Source errors in sample: **${sampleErrors}**
- Success rate: **${(successRate * 100).toFixed(1)}%**

## Answer Quality

- Citation coverage: **${(quality.avgCitationCoverage * 100).toFixed(1)}%**
- Unsupported claim rate: **${(quality.avgUnsupportedClaimRate * 100).toFixed(1)}%**
- Support score: **${(quality.avgSupportScore * 100).toFixed(1)}%**
- Abstain rate: **${(quality.abstainRate * 100).toFixed(1)}%**

## SLO Gates

- Scraper success rate >= 90%: **${slo.scrapeSuccessRate.pass ? "pass" : "fail"}**
- Scraper failure rate <= 10%: **${slo.scrapeFailureRate.pass ? "pass" : "fail"}**
- Unsupported claim rate <= 12%: **${slo.unsupportedClaimRate.pass ? "pass" : "fail"}**
- Citation coverage >= 60%: **${slo.citationCoverage.pass ? "pass" : "fail"}**

Overall: **${allPass ? "PASS" : "FAIL"}**
`;

  const outputPath = join(reportDir, "ops-slo-report.md");
  writeFileSync(outputPath, `${markdown}\n`, "utf-8");
  console.log(`[ops] report written: ${outputPath}`);
  if (!allPass) {
    process.exitCode = 1;
  }
}

main();
