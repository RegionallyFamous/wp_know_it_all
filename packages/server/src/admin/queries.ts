import type Database from "better-sqlite3";

export interface AdminStats {
  totalDocs: number;
  byCategory: Array<{ category: string; count: number }>;
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

  const stmtSearchDocs = db.prepare<[string, string, string, number, number], DocSearchResult>(
    `SELECT id, title, slug, doc_type, category, url
     FROM documents
     WHERE title LIKE ? OR slug LIKE ? OR url LIKE ?
     ORDER BY title ASC
     LIMIT ? OFFSET ?`
  );

  const stmtSearchDocsAll = db.prepare<[number, number], DocSearchResult>(
    `SELECT id, title, slug, doc_type, category, url
     FROM documents
     ORDER BY title ASC
     LIMIT ? OFFSET ?`
  );

  const stmtCountSearch = db.prepare<[string, string, string], { total: number }>(
    `SELECT COUNT(*) AS total
     FROM documents
     WHERE title LIKE ? OR slug LIKE ? OR url LIKE ?`
  );

  const stmtCountAll = db.prepare<[], { total: number }>(
    `SELECT COUNT(*) AS total FROM documents`
  );

  return {
    getStats(): AdminStats {
      const { total } = stmtTotalDocs.get()!;
      const byCategory = stmtByCategory.all();
      const lastJob = stmtLastJob.get() ?? null;
      const recentErrors = stmtRecentErrors.all();
      return { totalDocs: total, byCategory, lastJob, recentErrors };
    },

    getJobs(limit = 50): JobRow[] {
      return stmtJobs.all(limit);
    },

    getCheckpoints(): CheckpointRow[] {
      return stmtCheckpoints.all();
    },

    searchDocs(q: string, limit = 50, offset = 0): DocSearchResult[] {
      if (!q.trim()) {
        return stmtSearchDocsAll.all(limit, offset);
      }
      const like = `%${q}%`;
      return stmtSearchDocs.all(like, like, like, limit, offset);
    },

    countSearchDocs(q: string): number {
      if (!q.trim()) {
        return stmtCountAll.get()!.total;
      }
      const like = `%${q}%`;
      return stmtCountSearch.get(like, like, like)!.total;
    },

    deleteAllDocs(): void {
      db.exec(`DELETE FROM documents`);
      // Reset FTS index after wipe
      db.exec(`INSERT INTO documents_fts(documents_fts) VALUES('rebuild')`);
      // Reset checkpoints
      db.exec(`DELETE FROM scrape_checkpoints`);
    },

    rebuildFts(): void {
      db.exec(`INSERT INTO documents_fts(documents_fts) VALUES('rebuild')`);
    },
  };
}
