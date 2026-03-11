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

    getCheckpoints(): CheckpointRow[] {
      return stmtCheckpoints.all();
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
