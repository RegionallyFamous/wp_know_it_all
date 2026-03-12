import type Database from "better-sqlite3";

export interface AdminStats {
  totalDocs: number;
  byCategory: Array<{ category: string; count: number }>;
  bySource: Array<{ source: string; count: number }>;
  lastJob: {
    id: number;
    status: string;
    started_at: number;
    completed_at: number | null;
    total_docs: number;
    total_errors: number;
  } | null;
  recentErrors: Array<{
    source_type: string;
    error_msg: string;
    created_at: number;
  }>;
}

export interface JobRow {
  id: number;
  started_at: number;
  completed_at: number | null;
  status: string;
  total_docs: number;
  total_errors: number;
  summary: string | null;
}

export interface CheckpointRow {
  source_type: string;
  last_run_at: number | null;
  last_page: number;
  status: string;
}

export interface DocSearchResult {
  id: number;
  title: string;
  slug: string;
  doc_type: string;
  source: string;
  category: string | null;
  url: string;
}

export interface ScrapeErrorRow {
  id: number;
  job_id: number;
  source_type: string;
  url: string | null;
  error_msg: string;
  created_at: number;
}

export interface JobAnalytics {
  sampledJobs: number;
  completedJobs: number;
  failedJobs: number;
  avgDurationSec: number;
  p50DurationSec: number;
  p95DurationSec: number;
  avgDocsPerMin: number;
  docsLast24h: number;
  docsLast7d: number;
  topFailingSources: Array<{ source_type: string; count: number }>;
}

export function buildAdminQueries(db: Database.Database) {
  const stmtTotalDocs = db.prepare<[], { total: number }>(
    `SELECT COUNT(*) AS total FROM documents`
  );

  const stmtByCategory = db.prepare<[], { category: string; count: number }>(
    `SELECT COALESCE(category, 'uncategorized') AS category, COUNT(*) AS count
     FROM documents
     GROUP BY category
     ORDER BY count DESC`
  );
  const stmtBySource = db.prepare<[], { source: string; count: number }>(
    `SELECT source, COUNT(*) AS count
     FROM documents
     GROUP BY source
     ORDER BY count DESC`
  );

  const stmtLastJob = db.prepare<
    [],
    {
      id: number;
      status: string;
      started_at: number;
      completed_at: number | null;
      total_docs: number;
      total_errors: number;
    }
  >(
    `SELECT id, status, started_at, completed_at, total_docs, total_errors
     FROM scrape_jobs
     ORDER BY id DESC
     LIMIT 1`
  );

  const stmtRecentErrors = db.prepare<
    [],
    { source_type: string; error_msg: string; created_at: number }
  >(
    `SELECT source_type, error_msg, created_at
     FROM scrape_errors
     ORDER BY created_at DESC
     LIMIT 10`
  );

  const stmtJobs = db.prepare<[number], JobRow>(
    `SELECT id, started_at, completed_at, status, total_docs, total_errors, summary
     FROM scrape_jobs
     ORDER BY id DESC
     LIMIT ?`
  );

  const stmtCheckpoints = db.prepare<[], CheckpointRow>(
    `SELECT source_type, last_run_at, last_page, status
     FROM scrape_checkpoints
     ORDER BY source_type ASC`
  );

  const stmtSearchDocsAll = db.prepare<[number, number], DocSearchResult>(
    `SELECT id, title, slug, doc_type, source, category, url
     FROM documents
     ORDER BY title ASC
     LIMIT ? OFFSET ?`
  );

  const stmtCountAll = db.prepare<[], { total: number }>(
    `SELECT COUNT(*) AS total FROM documents`
  );
  const stmtDeleteScrapeErrors = db.prepare(`DELETE FROM scrape_errors`);
  const stmtTopFailingSources = db.prepare<[number], { source_type: string; count: number }>(
    `SELECT source_type, COUNT(*) AS count
     FROM scrape_errors
     WHERE created_at >= unixepoch() - ?
     GROUP BY source_type
     ORDER BY count DESC
     LIMIT 10`
  );
  const stmtDocGrowth = db.prepare<[number], { count: number }>(
    `SELECT COUNT(*) AS count
     FROM documents
     WHERE indexed_at >= unixepoch() - ?`
  );
  const stmtJobById = db.prepare<[number], JobRow>(
    `SELECT id, started_at, completed_at, status, total_docs, total_errors, summary
     FROM scrape_jobs
     WHERE id = ?
     LIMIT 1`
  );
  const stmtPreviousJob = db.prepare<[number], JobRow>(
    `SELECT id, started_at, completed_at, status, total_docs, total_errors, summary
     FROM scrape_jobs
     WHERE id < ?
     ORDER BY id DESC
     LIMIT 1`
  );
  const stmtErrorsByJob = db.prepare<[number], ScrapeErrorRow>(
    `SELECT id, job_id, source_type, url, error_msg, created_at
     FROM scrape_errors
     WHERE job_id = ?
     ORDER BY created_at DESC
     LIMIT 200`
  );

  return {
    getStats(): AdminStats {
      const { total } = stmtTotalDocs.get()!;
      const byCategory = stmtByCategory.all();
      const bySource = stmtBySource.all();
      const lastJob = stmtLastJob.get() ?? null;
      const recentErrors = stmtRecentErrors.all();
      return { totalDocs: total, byCategory, bySource, lastJob, recentErrors };
    },

    getJobs(limit = 50): JobRow[] {
      return stmtJobs.all(limit);
    },

    getJobById(jobId: number): JobRow | null {
      return stmtJobById.get(jobId) ?? null;
    },

    getPreviousJob(jobId: number): JobRow | null {
      return stmtPreviousJob.get(jobId) ?? null;
    },

    getCheckpoints(): CheckpointRow[] {
      return stmtCheckpoints.all();
    },

    getErrorsForJob(jobId: number): ScrapeErrorRow[] {
      return stmtErrorsByJob.all(jobId);
    },

    getJobAnalytics(sampleSize = 50): JobAnalytics {
      const jobs = stmtJobs.all(sampleSize);
      const completed = jobs.filter((job) => job.status === "completed" && job.completed_at != null);
      const failed = jobs.filter((job) => job.status === "failed");
      const durationsSec = completed
        .map((job) => (job.completed_at! - job.started_at))
        .filter((seconds) => Number.isFinite(seconds) && seconds > 0)
        .sort((a, b) => a - b);
      const percentile = (ratio: number): number => {
        if (durationsSec.length === 0) return 0;
        const index = Math.min(durationsSec.length - 1, Math.floor((durationsSec.length - 1) * ratio));
        return durationsSec[index] ?? 0;
      };
      const docsPerMin = completed
        .map((job) => {
          const durationMin = (job.completed_at! - job.started_at) / 60;
          if (durationMin <= 0) return 0;
          return job.total_docs / durationMin;
        })
        .filter((value) => Number.isFinite(value) && value > 0);
      const avg = (values: number[]): number =>
        values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

      const docsLast24h = stmtDocGrowth.get(24 * 60 * 60)!.count;
      const docsLast7d = stmtDocGrowth.get(7 * 24 * 60 * 60)!.count;
      const topFailingSources = stmtTopFailingSources.all(7 * 24 * 60 * 60);

      return {
        sampledJobs: jobs.length,
        completedJobs: completed.length,
        failedJobs: failed.length,
        avgDurationSec: avg(durationsSec),
        p50DurationSec: percentile(0.5),
        p95DurationSec: percentile(0.95),
        avgDocsPerMin: avg(docsPerMin),
        docsLast24h,
        docsLast7d,
        topFailingSources,
      };
    },

    searchDocs(
      q: string,
      limit = 50,
      offset = 0,
      filters?: { category?: string; source?: string }
    ): DocSearchResult[] {
      const where: string[] = [];
      const params: Array<string | number> = [];

      if (q.trim()) {
        const like = `%${q}%`;
        where.push("(title LIKE ? OR slug LIKE ? OR url LIKE ?)");
        params.push(like, like, like);
      }
      if (filters?.category?.trim()) {
        where.push("category = ?");
        params.push(filters.category.trim());
      }
      if (filters?.source?.trim()) {
        where.push("source = ?");
        params.push(filters.source.trim());
      }

      if (where.length === 0) {
        return stmtSearchDocsAll.all(limit, offset);
      }

      params.push(limit, offset);
      const stmt = db.prepare<
        (string | number)[],
        DocSearchResult
      >(
        `SELECT id, title, slug, doc_type, source, category, url
         FROM documents
         WHERE ${where.join(" AND ")}
         ORDER BY title ASC
         LIMIT ? OFFSET ?`
      );
      return stmt.all(...params);
    },

    countSearchDocs(q: string, filters?: { category?: string; source?: string }): number {
      const where: string[] = [];
      const params: string[] = [];

      if (q.trim()) {
        const like = `%${q}%`;
        where.push("(title LIKE ? OR slug LIKE ? OR url LIKE ?)");
        params.push(like, like, like);
      }
      if (filters?.category?.trim()) {
        where.push("category = ?");
        params.push(filters.category.trim());
      }
      if (filters?.source?.trim()) {
        where.push("source = ?");
        params.push(filters.source.trim());
      }

      if (where.length === 0) {
        return stmtCountAll.get()!.total;
      }

      const stmt = db.prepare<string[], { total: number }>(
        `SELECT COUNT(*) AS total
         FROM documents
         WHERE ${where.join(" AND ")}`
      );
      return stmt.get(...params)!.total;
    },

    deleteAllDocs(): void {
      db.exec(`DELETE FROM documents`);
      // Reset FTS index after wipe
      db.exec(`INSERT INTO documents_fts(documents_fts) VALUES('rebuild')`);
      // Reset checkpoints
      db.exec(`DELETE FROM scrape_checkpoints`);
    },

    deleteScrapeErrors(): number {
      const result = stmtDeleteScrapeErrors.run();
      return result.changes;
    },

    rebuildFts(): void {
      db.exec(`INSERT INTO documents_fts(documents_fts) VALUES('rebuild')`);
    },
  };
}
