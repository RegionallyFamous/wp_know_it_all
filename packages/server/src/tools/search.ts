import { z } from "zod";
import type { DocumentRow, SearchResult } from "@wp-know-it-all/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { buildQueries } from "../db/queries.js";
import { expandQuery } from "../lib/query-expansion.js";
import { routeQuery } from "../lib/query-router.js";
import { rerankCandidates, type RetrievalCandidate } from "../lib/rerank.js";
import { applyWranglerPersona } from "../lib/persona.js";

export const searchInputSchema = {
  query: z.string().min(1).max(500).describe(
    "Search query. Supports natural language (e.g. 'enqueue scripts block theme') or exact names (e.g. 'wp_enqueue_script')."
  ),
  category: z
    .enum([
      "code-reference",
      "plugin-handbook",
      "theme-handbook",
      "block-editor",
      "rest-api",
      "common-apis",
      "coding-standards",
      "admin",
      "scf",
      "php-core",
      "nodejs-runtime",
      "web-platform",
      "software-engineering",
      "python-runtime",
    ])
    .optional()
    .describe("Filter results to a specific documentation section."),
  doc_type: z
    .enum(["function", "hook", "class", "method", "guide", "example"])
    .optional()
    .describe("Filter results by documentation type."),
  limit: z.number().int().min(1).max(20).default(10).describe(
    "Maximum number of results to return (1–20)."
  ),
};

export function registerSearchTool(
  server: McpServer,
  queries: ReturnType<typeof buildQueries>
): void {
  server.registerTool(
    "search_wordpress_docs",
    {
      description:
        "Search the WordPress-first documentation corpus with adjacent PHP/Node/Web references. Returns BM25-ranked results with excerpts, while prioritizing WordPress-native sources. Supports natural language or exact function/hook names. Use this first to discover, then call get_wordpress_doc for full content.",
      inputSchema: searchInputSchema,
    },
    async ({ query, category, doc_type, limit }) => {
      const startedAt = Date.now();
      const route = routeQuery(query);
      const candidates: RetrievalCandidate[] = [];
      const pushCandidates = (results: SearchResult[], source: RetrievalCandidate["source"]): void => {
        results.forEach((result, rank) => {
          candidates.push({ result, source, rank });
        });
      };

      // 1) Base BM25 retrieval
      const baseResults = queries.search({ query: route.normalizedQuery, category, doc_type, limit: 20 });
      pushCandidates(baseResults, "bm25");

      // 2) Exact symbol path: enrich with exact doc + related docs
      if (route.intent === "exact_symbol") {
        const exact = queries.lookupExact(route.normalizedQuery);
        if (exact) {
          pushCandidates([documentToSearchResult(exact)], "exact");
          const related = queries.getRelated(exact.slug, exact.id)
            .slice(0, 5)
            .map(documentToSearchResult);
          pushCandidates(related, "related");
        }
      }

      // 3) Optional semantic expansion when sparse
      if (baseResults.length < Math.max(3, Math.floor(limit / 2))) {
        const expandedQuery = await expandQuery(route.normalizedQuery);
        if (expandedQuery !== route.normalizedQuery) {
          const expandedResults = queries.search({
            query: expandedQuery,
            category,
            doc_type,
            limit: 20,
          });
          pushCandidates(expandedResults, "bm25");
        }
      }

      const reranked = rerankCandidates(candidates, route.normalizedQuery, route.intent).slice(0, limit);
      const elapsedMs = Date.now() - startedAt;
      console.log(
        `[perf] search_wordpress_docs completed in ${elapsedMs}ms (intent=${route.intent}, candidates=${candidates.length}, returned=${reranked.length})`
      );

      if (reranked.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: applyWranglerPersona(
                `No results found for "${query}". Try a broader query or remove filters.`
              ),
            },
          ],
        };
      }

      return formatResults(query, reranked);
    }
  );
}

function documentToSearchResult(row: DocumentRow): SearchResult {
  const excerptSource = row.content_plain?.trim() || row.content_markdown?.trim() || "";
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    doc_type: row.doc_type,
    source: row.source,
    category: row.category,
    slug: row.slug,
    excerpt:
      excerptSource.length > 220 ? `${excerptSource.slice(0, 220).trimEnd()}…` : excerptSource,
    score: 0,
  };
}

function formatResults(
  query: string,
  results: ReturnType<ReturnType<typeof buildQueries>["search"]>
) {
  const formatted = results
    .map(
      (r, i) =>
        `${i + 1}. **${r.title}** (${r.doc_type})\n` +
        `   ID: ${r.id} | Slug: \`${r.slug}\`\n` +
        `   Source: ${r.source} | Category: ${r.category ?? "unknown"}\n` +
        `   URL: ${r.url}\n` +
        `   ${r.excerpt}\n`
    )
    .join("\n");

  return {
    content: [
      {
        type: "text" as const,
        text: applyWranglerPersona(
          `Found ${results.length} result(s) for "${query}":\n\n${formatted}\n\n` +
            `Use \`get_wordpress_doc\` with a slug or ID to fetch full content. ` +
            `Use \`validate_wordpress_code\` to check your implementation for security issues.`
        ),
      },
    ],
  };
}
