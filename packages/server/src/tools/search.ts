import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { buildQueries } from "../db/queries.js";
import { expandQuery } from "../lib/query-expansion.js";

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
        "Search the WordPress developer documentation corpus (10,000+ pages). Returns BM25-ranked results with excerpts. Supports natural language or exact function/hook names. Use this first to discover, then call get_wordpress_doc for full content.",
      inputSchema: searchInputSchema,
    },
    async ({ query, category, doc_type, limit }) => {
      const startedAt = Date.now();
      // Fast path: run local DB search first to avoid waiting on optional LLM expansion.
      const baseResults = queries.search({ query, category, doc_type, limit });
      if (baseResults.length > 0) {
        const elapsedMs = Date.now() - startedAt;
        console.log(`[perf] search_wordpress_docs fast-path completed in ${elapsedMs}ms`);
        return formatResults(query, baseResults);
      }

      // Slow path: optionally expand query via Ollama when base search is empty.
      const expandedQuery = await expandQuery(query);
      if (expandedQuery !== query) {
        const expandedResults = queries.search({
          query: expandedQuery,
          category,
          doc_type,
          limit,
        });
        if (expandedResults.length > 0) {
          const elapsedMs = Date.now() - startedAt;
          console.log(`[perf] search_wordpress_docs expanded-path completed in ${elapsedMs}ms`);
          return formatResults(query, expandedResults);
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `No results found for "${query}". Try a broader query or remove filters.`,
          },
        ],
      };
    }
  );
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
        `   Category: ${r.category ?? "unknown"}\n` +
        `   URL: ${r.url}\n` +
        `   ${r.excerpt}\n`
    )
    .join("\n");

  return {
    content: [
      {
        type: "text" as const,
        text:
          `Found ${results.length} result(s) for "${query}":\n\n${formatted}\n\n` +
          `Use \`get_wordpress_doc\` with a slug or ID to fetch full content. ` +
          `Use \`validate_wordpress_code\` to check your implementation for security issues.`,
      },
    ],
  };
}
