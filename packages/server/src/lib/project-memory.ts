import type Database from "better-sqlite3";

export interface ProjectMemory {
  projectKey: string;
  wpVersion: string | null;
  stackSummary: string | null;
  codingConventions: string | null;
  riskProfile: string | null;
  updatedAt: number;
}

export function buildProjectMemoryStore(db: Database.Database) {
  const getStmt = db.prepare(
    `SELECT project_key, wp_version, stack_summary, coding_conventions, risk_profile, updated_at
     FROM project_context_memory
     WHERE project_key = ? LIMIT 1`
  );

  const upsertStmt = db.prepare(
    `INSERT INTO project_context_memory
      (project_key, wp_version, stack_summary, coding_conventions, risk_profile, updated_at)
     VALUES (?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(project_key) DO UPDATE SET
      wp_version = COALESCE(excluded.wp_version, project_context_memory.wp_version),
      stack_summary = COALESCE(excluded.stack_summary, project_context_memory.stack_summary),
      coding_conventions = COALESCE(excluded.coding_conventions, project_context_memory.coding_conventions),
      risk_profile = COALESCE(excluded.risk_profile, project_context_memory.risk_profile),
      updated_at = unixepoch()`
  );

  return {
    get(projectKey: string): ProjectMemory | null {
      const row = getStmt.get(projectKey) as
        | {
            project_key: string;
            wp_version: string | null;
            stack_summary: string | null;
            coding_conventions: string | null;
            risk_profile: string | null;
            updated_at: number;
          }
        | undefined;
      if (!row) return null;
      return {
        projectKey: row.project_key,
        wpVersion: row.wp_version,
        stackSummary: row.stack_summary,
        codingConventions: row.coding_conventions,
        riskProfile: row.risk_profile,
        updatedAt: row.updated_at,
      };
    },
    upsert(input: {
      projectKey: string;
      wpVersion?: string | null;
      stackSummary?: string | null;
      codingConventions?: string | null;
      riskProfile?: string | null;
    }): void {
      upsertStmt.run(
        input.projectKey,
        input.wpVersion ?? null,
        input.stackSummary ?? null,
        input.codingConventions ?? null,
        input.riskProfile ?? null
      );
    },
  };
}
