# Wrangler 10x Runbook

## Purpose

Operational runbook for keeping Wrangler reliable while refining retrieval quality and source coverage.

## Daily/Per-Deploy Checks

1. Run baseline report:
   - `pnpm eval:baseline`
2. Run quality and canary eval gates:
   - `pnpm eval:quality`
   - `pnpm eval:canary`
3. Run operations SLO report:
   - `pnpm eval:ops`
4. Review admin dashboard:
   - `Dashboard` source breakdown and recent errors.
   - `Quality` page for citation/support/abstain trends.

## Source Expansion Policy

- Canonical sources only.
- Strict allowlists (no broad crawling).
- Source metadata required: `ecosystem`, `section`, plus source-specific keys.
- Every expansion requires rollback controls via env toggles.

## Adjacent Bundle Toggles

- `IETF_RFC_BUNDLE=core|expanded`
- `PYTHON_DOCS_BUNDLE=core|expanded`
- `NODE_DOCS_BUNDLE=core|expanded`
- `MDN_DOCS_BUNDLE=core|expanded`

Default is `core` for all toggles.

## Incident Triage

1. If scrape fails:
   - inspect `/admin/scraper` log and checkpoint statuses.
   - clear stale scraper errors only after triage.
2. If answer quality drops:
   - inspect recent quality telemetry.
   - compare baseline report to previous run.
   - run eval suite before rolling forward.
3. If relevance drifts:
   - validate rerank priors and source share changes.
   - reduce adjacent bundle scope using core mode toggles.

## Promotion Criteria

- `eval:quality` and `eval:canary` pass.
- `eval:ops` passes.
- No unresolved high-severity scraper source failures.
- WordPress-first relevance remains stable in manual spot checks.
