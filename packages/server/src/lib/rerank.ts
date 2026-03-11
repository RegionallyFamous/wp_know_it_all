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
