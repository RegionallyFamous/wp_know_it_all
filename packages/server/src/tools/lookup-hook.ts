import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { buildQueries } from "../db/queries.js";
import type { DocumentRow } from "@wp-know-it-all/shared";
import { HOOK_SECURITY_CHECKLISTS } from "../validation/rules/hook-checklists.js";

export const lookupInputSchema = {
  name: z.string().min(1).max(200).describe(
    "Exact name of a WordPress function, hook, class, or method. Examples: 'wp_enqueue_script', 'add_action', 'WP_Query', 'save_post'."
  ),
};

// Known deprecated functions and their replacements
const DEPRECATED_FUNCTIONS: Record<string, string> = {
  clean_url: "esc_url()",
  attribute_escape: "esc_attr()",
  js_escape: "esc_js()",
  get_currentuserinfo: "wp_get_current_user()",
  wp_login: "wp_signon()",
  get_usernumposts: "count_user_posts()",
  dropdown_cats: "wp_dropdown_categories()",
  get_postdata: "get_post()",
  trackback_rdf: "removed in WP 4.2, no replacement",
  wp_setcookie: "wp_set_auth_cookie()",
};

function buildSecurityChecklist(name: string): string | null {
  // Check if this hook/function has a security checklist
  const checklist = HOOK_SECURITY_CHECKLISTS[name];
  if (!checklist) return null;

  const parts: string[] = [];
  parts.push("\n## Security Checklist");
  parts.push(
    "Implement the following requirements when using this hook:\n"
  );

  for (const item of checklist.checklist) {
    parts.push(`- ${item}`);
  }

  parts.push("\n### Complete Secure Example");
  parts.push("```php");
  parts.push(checklist.example);
  parts.push("```");

  if (checklist.antipatterns.length > 0) {
    parts.push("\n### Common Mistakes to Avoid");
    for (const ap of checklist.antipatterns) {
      parts.push(`- ${ap}`);
    }
  }

  return parts.join("\n");
}

function buildDeprecationWarning(name: string): string | null {
  const replacement = DEPRECATED_FUNCTIONS[name.toLowerCase()];
  if (!replacement) return null;

  return [
    "",
    "## Deprecation Warning",
    `\`${name}\` is **deprecated** in WordPress. Do not use it in new code.`,
    `**Use instead:** \`${replacement}\``,
    "",
    "> Deprecated functions remain in WordPress for backward compatibility but may be removed in future versions.",
  ].join("\n");
}

function formatLookup(row: DocumentRow, related: DocumentRow[]): string {
  const parts: string[] = [];

  parts.push(`# \`${row.title}\``);
  parts.push(`**Type:** ${row.doc_type} | **Category:** ${row.category ?? "unknown"}`);
  parts.push(`**URL:** ${row.url}`);

  if (row.since_version) {
    parts.push(`**Since:** WordPress ${row.since_version}`);
  }

  // Deprecation warning (shown prominently at the top)
  const deprecation = buildDeprecationWarning(row.title);
  if (deprecation) {
    parts.push(deprecation);
  }

  if (row.signature) {
    parts.push(`\n## Signature\n\`\`\`php\n${row.signature}\n\`\`\``);
  }

  parts.push(`\n## Documentation\n\n${row.content_markdown}`);

  if (row.metadata) {
    try {
      const meta = JSON.parse(row.metadata) as Record<string, unknown>;
      if (meta["params"]) {
        parts.push(`\n## Parameters\n\`\`\`json\n${JSON.stringify(meta["params"], null, 2)}\n\`\`\``);
      }
      if (meta["return"]) {
        parts.push(`\n## Return Value\n${String(meta["return"])}`);
      }
    } catch {
      // Malformed metadata — skip
    }
  }

  // Security checklist for high-risk hooks
  const checklist = buildSecurityChecklist(row.title);
  if (checklist) {
    parts.push(checklist);
  }

  if (related.length > 0) {
    parts.push("\n## Related References");
    for (const rel of related) {
      parts.push(`- **\`${rel.title}\`** (${rel.doc_type}) — ${rel.url}`);
      if (rel.content_markdown) {
        const preview = rel.content_markdown.slice(0, 200).replace(/\n/g, " ");
        parts.push(`  ${preview}…`);
      }
    }
  }

  return parts.join("\n");
}

export function registerLookupTool(
  server: McpServer,
  queries: ReturnType<typeof buildQueries>
): void {
  server.registerTool(
    "lookup_wordpress_hook",
    {
      description:
        "Look up a specific WordPress function, hook, class, or method by exact name. Returns full documentation, parameters, return values, cross-referenced related items, and a security checklist if applicable. Use this when you know the exact name.",
      inputSchema: lookupInputSchema,
    },
    async ({ name }) => {
      const row = queries.lookupExact(name);

      if (!row) {
        const fallback = queries.search({ query: name, limit: 3 });
        if (fallback.length > 0) {
          const suggestions = fallback
            .map((r) => `- \`${r.slug}\` — ${r.title}`)
            .join("\n");
          return {
            content: [
              {
                type: "text" as const,
                text: `No exact match for \`${name}\`. Did you mean one of these?\n\n${suggestions}\n\nUse \`get_wordpress_doc\` with the slug to fetch the full page.`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `No documentation found for \`${name}\`. Check the spelling or use \`search_wordpress_docs\` with a descriptive query.`,
            },
          ],
        };
      }

      const related = queries.getRelated(row.slug, row.id);
      return {
        content: [{ type: "text" as const, text: formatLookup(row, related) }],
      };
    }
  );
}
