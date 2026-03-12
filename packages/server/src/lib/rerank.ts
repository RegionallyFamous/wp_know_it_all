import type { SearchResult } from "@wp-know-it-all/shared";
import type { QueryIntent } from "./query-router.js";

export interface RetrievalCandidate {
  result: SearchResult;
  source: "bm25" | "exact" | "related";
  rank: number;
}

function includesWordBoundary(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${escaped}\\b`, "i");
  return pattern.test(haystack);
}

function sourcePrior(source: SearchResult["source"]): number {
  switch (source) {
    case "devhub-api":
      return 30;
    case "gutenberg-github":
    case "wpcli-github":
      return 20;
    case "wordpress-github-docs":
      return 14;
    case "wordpress-github-code":
      return 12;
    case "php-manual":
    case "nodejs-docs":
    case "mdn-webdocs":
      return 5;
    case "ietf-rfcs":
      return 4;
    case "python-docs":
      return 6;
    default:
      return 0;
  }
}

export function rerankCandidates(
  candidates: RetrievalCandidate[],
  query: string,
  intent: QueryIntent
): SearchResult[] {
  const normalizedQuery = query.trim().toLowerCase();

  const scored = candidates.map((candidate) => {
    const { result } = candidate;
    const slug = result.slug.toLowerCase();
    const title = result.title.toLowerCase();
    let score = 0;

    // Source priors
    if (candidate.source === "exact") score += 100;
    if (candidate.source === "bm25") score += 30;
    if (candidate.source === "related") score += 10;
    score += sourcePrior(result.source);

    // Rank prior from each source
    score += Math.max(0, 20 - candidate.rank * 2);

    // Lexical alignment boosts
    if (slug === normalizedQuery || title === normalizedQuery) score += 80;
    if (slug.startsWith(normalizedQuery) || title.startsWith(normalizedQuery)) score += 30;
    if (includesWordBoundary(result.title, query) || includesWordBoundary(result.slug, query)) {
      score += 20;
    }

    // Intent-specific priors
    if (intent === "exact_symbol" && (result.doc_type === "function" || result.doc_type === "hook")) {
      score += 10;
    }
    if (intent === "workflow") {
      if (result.doc_type === "guide" || result.doc_type === "example") score += 12;
      if (result.category === "coding-standards" || result.category === "common-apis") score += 8;
    }
    if (intent === "debug") {
      if (result.doc_type === "hook" || result.doc_type === "function") score += 8;
      if (result.category === "code-reference" || result.category === "common-apis") score += 8;
    }
    if (intent === "implementation") {
      if (result.doc_type === "example" || result.doc_type === "guide") score += 10;
      if (result.category === "plugin-handbook" || result.category === "theme-handbook") score += 6;
    }
    if (intent === "security_review") {
      if (result.category === "coding-standards" || result.category === "web-platform") score += 10;
      if (result.source === "devhub-api" || result.source === "mdn-webdocs") score += 6;
    }
    if (intent === "migration") {
      if (result.doc_type === "guide") score += 6;
      if (result.source === "wordpress-github-docs" || result.source === "wordpress-github-code") {
        score += 8;
      }
    }
    if (intent === "architecture") {
      if (result.doc_type === "guide" || result.doc_type === "class") score += 8;
      if (result.source === "wordpress-github-docs") score += 8;
    }

    return { result, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const seen = new Set<number>();
  const deduped: SearchResult[] = [];
  for (const item of scored) {
    if (seen.has(item.result.id)) continue;
    seen.add(item.result.id);
    deduped.push(item.result);
  }

  return deduped;
}
