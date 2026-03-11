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
      // Optionally expand query via Ollama (no-op if OLLAMA_HOST not set)
      const expandedQuery = await expandQuery(query);

      const results = queries.search({ query: expandedQuery, category, doc_type, limit });

      if (results.length === 0) {
        // Try the original query if expansion returned nothing
        const fallbackResults =
          expandedQuery !== query ? queries.search({ query, category, doc_type, limit }) : [];

        if (fallbackResults.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No results found for "${query}". Try a broader query or remove filters.`,
              },
            ],
          };
        }

        const elapsedMs = Date.now() - startedAt;
        console.log(`[perf] search_wordpress_docs fallback completed in ${elapsedMs}ms`);
        return formatResults(query, fallbackResults);
      }

      const elapsedMs = Date.now() - startedAt;
      console.log(`[perf] search_wordpress_docs completed in ${elapsedMs}ms`);
      return formatResults(query, results);
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
