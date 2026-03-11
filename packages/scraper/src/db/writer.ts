import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface InsertableDocument {
  url: string;
  slug: string;
  title: string;
  doc_type: string;
  source: string;
  category: string | null;
  signature: string | null;
  since_version: string | null;
  parent_id: number | null;
  content_markdown: string;
  content_plain: string;
  functions_mentioned: string[] | null;
  hooks_mentioned: string[] | null;
  metadata: Record<string, unknown> | null;
}

export function openWriterDb(dbPath: string): Database.Database {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("cache_size = -64000");

  return db;
}

export function applyScraperSchema(db: Database.Database): void {
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
    CREATE INDEX IF NOT EXISTS idx_documents_doc_type ON documents(doc_type);
    CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(category);

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
  `);
}

export function buildWriter(db: Database.Database) {
  const upsertStmt = db.prepare<
    [
      string, string, string, string, string,
      string | null, string | null, string | null, number | null,
      string, string, string | null, string | null, string | null
    ]
  >(`
    INSERT INTO documents
      (url, slug, title, doc_type, source, category, signature, since_version,
       parent_id, content_markdown, content_plain, functions_mentioned, hooks_mentioned, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET
      title               = excluded.title,
      content_markdown    = excluded.content_markdown,
      content_plain       = excluded.content_plain,
      signature           = excluded.signature,
      since_version       = excluded.since_version,
      functions_mentioned = excluded.functions_mentioned,
      hooks_mentioned     = excluded.hooks_mentioned,
      metadata            = excluded.metadata,
      indexed_at          = unixepoch()
  `);

  const batchInsert = db.transaction((docs: InsertableDocument[]) => {
    for (const doc of docs) {
      upsertStmt.run(
        doc.url,
        doc.slug,
        doc.title,
        doc.doc_type,
        doc.source,
        doc.category,
        doc.signature,
        doc.since_version,
        doc.parent_id,
        doc.content_markdown,
        doc.content_plain,
        doc.functions_mentioned ? JSON.stringify(doc.functions_mentioned) : null,
        doc.hooks_mentioned ? JSON.stringify(doc.hooks_mentioned) : null,
        doc.metadata ? JSON.stringify(doc.metadata) : null
      );
    }
  });

  const countStmt = db.prepare<[], { count: number }>(
    "SELECT COUNT(*) as count FROM documents"
  );

  return {
    insertBatch(docs: InsertableDocument[]): void {
      batchInsert(docs);
    },

    insert(doc: InsertableDocument): void {
      batchInsert([doc]);
    },

    count(): number {
      return countStmt.get()!.count;
    },

    rebuildFts(): void {
      db.exec(`INSERT INTO documents_fts(documents_fts) VALUES('rebuild')`);
    },
  };
}
