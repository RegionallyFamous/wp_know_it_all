import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { buildQueries } from "../db/queries.js";
import type { DocumentRow } from "@wp-know-it-all/shared";

export const getDocInputSchema = {
  slug: z.string().optional().describe(
    "The document slug (e.g. 'wp_enqueue_script', 'registering-custom-post-types')."
  ),
  id: z.number().int().positive().optional().describe(
    "The numeric document ID returned by search_wordpress_docs."
  ),
};

function formatDocument(row: DocumentRow): string {
  const parts: string[] = [];
  const renderMetaField = (value: unknown): string => {
    if (typeof value === "string") return value;
    return JSON.stringify(value, null, 2);
  };

  parts.push(`# ${row.title}`);
  parts.push(`**Type:** ${row.doc_type} | **Category:** ${row.category ?? "unknown"}`);
  parts.push(`**URL:** ${row.url}`);

  if (row.since_version) {
    parts.push(`**Since:** WordPress ${row.since_version}`);
  }

  if (row.signature) {
    parts.push(`\n## Signature\n\`\`\`php\n${row.signature}\n\`\`\``);
  }

  parts.push(`\n## Documentation\n\n${row.content_markdown}`);

  if (row.hooks_mentioned) {
    const hooks = JSON.parse(row.hooks_mentioned) as string[];
    if (hooks.length > 0) {
      parts.push(`\n## Related Hooks\n${hooks.map((h) => `- \`${h}\``).join("\n")}`);
    }
  }

  if (row.functions_mentioned) {
    const fns = JSON.parse(row.functions_mentioned) as string[];
    if (fns.length > 0) {
      parts.push(
        `\n## Related Functions\n${fns.map((f) => `- \`${f}\``).join("\n")}`
      );
    }
  }

  if (row.metadata) {
    const meta = JSON.parse(row.metadata) as Record<string, unknown>;
    if (meta["params"]) {
      parts.push(`\n## Parameters\n\`\`\`json\n${JSON.stringify(meta["params"], null, 2)}\n\`\`\``);
    }
    if (meta["return"]) {
      parts.push(`\n## Return Value\n${renderMetaField(meta["return"])}`);
    }
  }

  return parts.join("\n");
}

export function registerGetDocTool(
  server: McpServer,
  queries: ReturnType<typeof buildQueries>
): void {
  server.registerTool(
    "get_wordpress_doc",
    {
      description:
        "Fetch the full documentation for a WordPress function, hook, class, or handbook page. Provide either a slug or an ID from search_wordpress_docs results.",
      inputSchema: getDocInputSchema,
    },
    ({ slug, id }) => {
      if (!slug && !id) {
        return {
          content: [{ type: "text", text: "Provide either a slug or an id." }],
          isError: true,
        };
      }

      const row = id ? queries.getById(id) : slug ? queries.getBySlug(slug) : undefined;

      if (!row) {
        const identifier = id ? `ID ${id}` : `slug "${slug}"`;
        return {
          content: [
            {
              type: "text",
              text: `Document not found for ${identifier}. Try search_wordpress_docs to find the correct slug.`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: formatDocument(row) }],
      };
    }
  );
}
