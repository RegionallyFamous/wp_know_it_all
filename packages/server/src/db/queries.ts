import type Database from "better-sqlite3";
import type { DocumentRow, SearchResult } from "@wp-know-it-all/shared";

export interface SearchOptions {
  query: string;
  category?: string;
  doc_type?: string;
  limit?: number;
}

export interface RawSearchResult {
  id: number;
  url: string;
  title: string;
  doc_type: string;
  category: string | null;
  slug: string;
  excerpt: string;
  score: number;
}

export function buildQueries(db: Database.Database) {
  const searchStmt = db.prepare<[string, number], RawSearchResult>(`
    SELECT
      p.id,
      p.url,
      p.title,
      p.doc_type,
      p.category,
      p.slug,
      snippet(documents_fts, 1, '**', '**', '…', 40) AS excerpt,
      bm25(documents_fts, 5.0, 1.0, 3.0)             AS score
    FROM documents_fts
    JOIN documents p ON p.id = documents_fts.rowid
    WHERE documents_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `);

  const searchWithCategoryStmt = db.prepare<[string, string, number], RawSearchResult>(`
    SELECT
      p.id,
      p.url,
      p.title,
      p.doc_type,
      p.category,
      p.slug,
      snippet(documents_fts, 1, '**', '**', '…', 40) AS excerpt,
      bm25(documents_fts, 5.0, 1.0, 3.0)             AS score
    FROM documents_fts
    JOIN documents p ON p.id = documents_fts.rowid
    WHERE documents_fts MATCH ?
      AND p.category = ?
    ORDER BY rank
    LIMIT ?
  `);

  const searchWithDocTypeStmt = db.prepare<[string, string, number], RawSearchResult>(`
    SELECT
      p.id,
      p.url,
      p.title,
      p.doc_type,
      p.category,
      p.slug,
      snippet(documents_fts, 1, '**', '**', '…', 40) AS excerpt,
      bm25(documents_fts, 5.0, 1.0, 3.0)             AS score
    FROM documents_fts
    JOIN documents p ON p.id = documents_fts.rowid
    WHERE documents_fts MATCH ?
      AND p.doc_type = ?
    ORDER BY rank
    LIMIT ?
  `);

  const searchWithBothStmt = db.prepare<[string, string, string, number], RawSearchResult>(`
    SELECT
      p.id,
      p.url,
      p.title,
      p.doc_type,
      p.category,
      p.slug,
      snippet(documents_fts, 1, '**', '**', '…', 40) AS excerpt,
      bm25(documents_fts, 5.0, 1.0, 3.0)             AS score
    FROM documents_fts
    JOIN documents p ON p.id = documents_fts.rowid
    WHERE documents_fts MATCH ?
      AND p.category = ?
      AND p.doc_type = ?
    ORDER BY rank
    LIMIT ?
  `);

  const getBySlugStmt = db.prepare<[string], DocumentRow>(
    `SELECT * FROM documents WHERE slug = ? LIMIT 1`
  );

  const getByIdStmt = db.prepare<[number], DocumentRow>(
    `SELECT * FROM documents WHERE id = ? LIMIT 1`
  );

  const lookupExactStmt = db.prepare<[string], DocumentRow>(`
    SELECT * FROM documents
    WHERE LOWER(slug) = LOWER(?)
       OR LOWER(title) = LOWER(?)
    LIMIT 1
  `);

  const lookupExact2Stmt = db.prepare<[string, string], DocumentRow>(`
    SELECT * FROM documents
    WHERE LOWER(slug) = LOWER(?)
       OR LOWER(title) = LOWER(?)
    LIMIT 1
  `);

  // Find related docs by searching for the slug name in the FTS index,
  // excluding the current document itself.
  const relatedDocsStmt = db.prepare<[string, number], DocumentRow>(`
    SELECT d.*
    FROM documents_fts
    JOIN documents d ON d.id = documents_fts.rowid
    WHERE documents_fts MATCH ?
      AND d.id != ?
    ORDER BY rank
    LIMIT 5
  `);

  const statsStmt = db.prepare<[], { total: number; by_category: string }>(`
    SELECT
      COUNT(*) as total,
      json_group_object(category, cnt) as by_category
    FROM (
      SELECT category, COUNT(*) as cnt FROM documents GROUP BY category
    )
  `);

  return {
    search(opts: SearchOptions): SearchResult[] {
      const limit = opts.limit ?? 10;
      // Escape special FTS5 characters and wrap in quotes for phrase tolerance
      const q = sanitizeFtsQuery(opts.query);

      let rows: RawSearchResult[];
      if (opts.category && opts.doc_type) {
        rows = searchWithBothStmt.all(q, opts.category, opts.doc_type, limit);
      } else if (opts.category) {
        rows = searchWithCategoryStmt.all(q, opts.category, limit);
      } else if (opts.doc_type) {
        rows = searchWithDocTypeStmt.all(q, opts.doc_type, limit);
      } else {
        rows = searchStmt.all(q, limit);
      }

      return rows.map((r) => ({
        ...r,
        category: (r.category ?? null) as SearchResult["category"],
        doc_type: r.doc_type as SearchResult["doc_type"],
      }));
    },

    getBySlug(slug: string): DocumentRow | undefined {
      return getBySlugStmt.get(slug);
    },

    getById(id: number): DocumentRow | undefined {
      return getByIdStmt.get(id);
    },

    lookupExact(name: string): DocumentRow | undefined {
      return lookupExact2Stmt.get(name, name);
    },

    getRelated(slug: string, currentId: number): DocumentRow[] {
      // If the DB is empty (no FTS data), return empty array gracefully
      const q = sanitizeFtsQuery(slug);
      try {
        return relatedDocsStmt.all(q, currentId);
      } catch {
        return [];
      }
    },

    stats(): { total: number; by_category: Record<string, number> } {
      const row = statsStmt.get()!;
      return {
        total: row.total,
        by_category: JSON.parse(row.by_category) as Record<string, number>,
      };
    },
  };
}

function sanitizeFtsQuery(raw: string): string {
  // Remove FTS5 special characters that would cause parse errors
  const cleaned = raw.replace(/["*^]/g, " ").trim();
  // If multi-word, try a phrase search first; fallback to AND
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '""';
  if (words.length === 1) return cleaned;
  // Phrase match OR individual AND match for better recall
  return `"${words.join(" ")}" OR ${words.join(" AND ")}`;
}
