import Database from "better-sqlite3";

export interface ScrapeJob {
  id: number;
  started_at: number;
  completed_at: number | null;
  status: string;
  total_docs: number | null;
  total_errors: number | null;
  summary: string | null;
}

export interface ScrapeCheckpoint {
  last_run_at: number | null;
  last_page: number;
  status: string;
}

export class JobTracker {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Insert a new scrape_jobs row and return its auto-incremented id. */
  createJob(): number {
    const result = this.db
      .prepare<[], { id: number }>(
        `INSERT INTO scrape_jobs (started_at, status) VALUES (unixepoch(), 'running')
         RETURNING id`
      )
      .get();

    if (!result) throw new Error("createJob: INSERT returned no row");
    return result.id;
  }

  /**
   * Upsert a scrape_checkpoints row marking this source as running.
   * Uses INSERT OR REPLACE so a first-ever run also works.
   */
  startSource(jobId: number, sourceType: string): void {
    this.db
      .prepare(
        `INSERT INTO scrape_checkpoints (source_type, last_job_id, last_run_at, last_page, status)
         VALUES (?, ?, NULL, 0, 'running')
         ON CONFLICT(source_type) DO UPDATE SET
           last_job_id = excluded.last_job_id,
           status      = 'running'`
      )
      .run(sourceType, jobId);
  }

  /** Persist how far through pagination we've gotten so a restart can resume. */
  saveCheckpoint(sourceType: string, page: number): void {
    this.db
      .prepare(
        `UPDATE scrape_checkpoints SET last_page = ? WHERE source_type = ?`
      )
      .run(page, sourceType);
  }

  /** Mark a source as successfully finished and record the run timestamp. */
  completeSource(
    jobId: number,
    sourceType: string,
    docs: number,
    errors: number
  ): void {
    void jobId;
    void docs;
    void errors;
    this.db
      .prepare(
        `UPDATE scrape_checkpoints
         SET status      = 'completed',
             last_run_at = unixepoch(),
             last_page   = 0
         WHERE source_type = ?`
      )
      .run(sourceType);
  }

  /** Mark a source as failed (keeps last_page so it can be resumed). */
  failSource(jobId: number, sourceType: string, error: string): void {
    void jobId;
    void error;
    this.db
      .prepare(
        `UPDATE scrape_checkpoints SET status = 'failed' WHERE source_type = ?`
      )
      .run(sourceType);
  }

  /** Append a row to scrape_errors for post-run inspection. */
  logError(
    jobId: number,
    sourceType: string,
    url: string | null,
    msg: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO scrape_errors (job_id, source_type, url, error_msg, created_at)
         VALUES (?, ?, ?, ?, unixepoch())`
      )
      .run(jobId, sourceType, url, msg);
  }

  /** Finalise the job row with a JSON summary blob. */
  completeJob(jobId: number, summary: Record<string, unknown>): void {
    this.db
      .prepare(
        `UPDATE scrape_jobs
         SET status       = 'completed',
             completed_at = unixepoch(),
             summary      = ?
         WHERE id = ?`
      )
      .run(JSON.stringify(summary), jobId);
  }

  /** Mark the job as failed (no summary needed). */
  failJob(jobId: number): void {
    this.db
      .prepare(
        `UPDATE scrape_jobs
         SET status       = 'failed',
             completed_at = unixepoch()
         WHERE id = ?`
      )
      .run(jobId);
  }

  /**
   * Return the checkpoint row for a source, or undefined if it has never run.
   * Callers can use this to decide whether to skip or resume from last_page.
   */
  getCheckpoint(sourceType: string): ScrapeCheckpoint | undefined {
    return this.db
      .prepare<[string], ScrapeCheckpoint>(
        `SELECT last_run_at, last_page, status
         FROM scrape_checkpoints
         WHERE source_type = ?`
      )
      .get(sourceType);
  }

  /** Return the most recent scrape_jobs rows, newest first. */
  getRecentJobs(limit = 10): ScrapeJob[] {
    return this.db
      .prepare<[number], ScrapeJob>(
        `SELECT id, started_at, completed_at, status, total_docs, total_errors, summary
         FROM scrape_jobs
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(limit);
  }
}
