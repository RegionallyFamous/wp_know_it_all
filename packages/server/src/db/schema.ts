import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDatabase(dbPath: string): Database.Database {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("cache_size = -32000"); // 32MB cache

  applySchema(db);
  return db;
}

export function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      url                 TEXT    NOT NULL UNIQUE,
      slug                TEXT    NOT NULL,
      title               TEXT    NOT NULL,
      doc_type            TEXT    NOT NULL,
      source              TEXT    NOT NULL,
      category            TEXT,
      signature           TEXT,
      since_version       TEXT,
      parent_id           INTEGER,
      content_markdown    TEXT    NOT NULL,
      content_plain       TEXT    NOT NULL,
      functions_mentioned TEXT,
      hooks_mentioned     TEXT,
      metadata            TEXT,
      indexed_at          INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_documents_slug     ON documents(slug);
    CREATE INDEX IF NOT EXISTS idx_documents_slug_lower ON documents(LOWER(slug));
    CREATE INDEX IF NOT EXISTS idx_documents_doc_type ON documents(doc_type);
    CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(category);
    CREATE INDEX IF NOT EXISTS idx_documents_source   ON documents(source);
    CREATE INDEX IF NOT EXISTS idx_documents_title_lower ON documents(LOWER(title));

    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      title,
      content_plain,
      signature,
      content       = 'documents',
      content_rowid = 'id',
      tokenize      = 'porter unicode61 remove_diacritics 1'
    );

    CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON documents BEGIN
      INSERT INTO documents_fts(rowid, title, content_plain, signature)
      VALUES (new.id, new.title, new.content_plain, new.signature);
    END;

    CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, title, content_plain, signature)
      VALUES ('delete', old.id, old.title, old.content_plain, old.signature);
    END;

    CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, title, content_plain, signature)
      VALUES ('delete', old.id, old.title, old.content_plain, old.signature);
      INSERT INTO documents_fts(rowid, title, content_plain, signature)
      VALUES (new.id, new.title, new.content_plain, new.signature);
    END;

    -- Scrape job tracking
    CREATE TABLE IF NOT EXISTS scrape_jobs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      completed_at INTEGER,
      status       TEXT    NOT NULL DEFAULT 'running',
      total_docs   INTEGER NOT NULL DEFAULT 0,
      total_errors INTEGER NOT NULL DEFAULT 0,
      summary      TEXT
    );

    CREATE TABLE IF NOT EXISTS scrape_checkpoints (
      source_type  TEXT    PRIMARY KEY,
      last_job_id  INTEGER,
      last_run_at  INTEGER,
      last_page    INTEGER NOT NULL DEFAULT 0,
      status       TEXT    NOT NULL DEFAULT 'pending'
    );

    CREATE TABLE IF NOT EXISTS scrape_errors (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id       INTEGER NOT NULL,
      source_type  TEXT    NOT NULL,
      url          TEXT,
      error_msg    TEXT    NOT NULL,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_scrape_errors_job ON scrape_errors(job_id);
    CREATE INDEX IF NOT EXISTS idx_scrape_errors_created_at ON scrape_errors(created_at DESC);
  `);
}

export function rebuildFts(db: Database.Database): void {
  db.exec(`INSERT INTO documents_fts(documents_fts) VALUES('rebuild')`);
}
