import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { buildQueries } from "./db/queries.js";

export function registerResources(
  server: McpServer,
  queries: ReturnType<typeof buildQueries>
): void {
  server.registerResource(
    "wordpress-docs-index",
    "wordpress://index",
    {
      title: "WordPress Documentation Index",
      description:
        "Overview of all indexed WordPress documentation sections and document counts.",
      mimeType: "text/plain",
    },
    () => {
      const stats = queries.stats();
      const categoryLines = Object.entries(stats.by_category)
        .sort(([, a], [, b]) => b - a)
        .map(([cat, count]) => `  - ${cat}: ${count.toLocaleString()} documents`)
        .join("\n");

      return {
        contents: [
          {
            uri: "wordpress://index",
            text: [
              "# WP Know It All — Documentation Index",
              "",
              `Total documents indexed: ${stats.total.toLocaleString()}`,
              "",
              "## By Category",
              categoryLines,
              "",
              "## Available Tools",
              "- **search_wordpress_docs** — Full-text BM25 search across all sections",
              "- **get_wordpress_doc** — Fetch full page by slug or ID",
              "- **lookup_wordpress_hook** — Exact lookup for functions, hooks, and classes",
            ].join("\n"),
          },
        ],
      };
    }
  );

  server.registerResource(
    "wordpress-coding-standards",
    "wordpress://coding-standards",
    {
      title: "WordPress Coding Standards Summary",
      description: "Quick reference for WordPress PHP, JS, and CSS coding standards.",
      mimeType: "text/plain",
    },
    () => ({
      contents: [
        {
          uri: "wordpress://coding-standards",
          text: [
            "# WordPress Coding Standards — Quick Reference",
            "",
            "## PHP",
            "- Indent with tabs, not spaces",
            "- Opening braces go on the same line for functions; own line for classes",
            "- Yoda conditions: `if ( true === $var )` not `if ( $var === true )`",
            "- Space inside parentheses: `if ( $condition )`, `function foo( $bar )`",
            "- Single quotes for strings unless interpolation is needed",
            "- Prefix all functions, classes, globals with your plugin/theme slug",
            "- Always sanitize input with `sanitize_text_field()`, `absint()`, etc.",
            "- Always escape output with `esc_html()`, `esc_attr()`, `esc_url()`, etc.",
            "- Verify nonces with `wp_verify_nonce()` before processing form data",
            "- Use `wp_die()` not `die()` or `exit()`",
            "",
            "## JavaScript",
            "- Use `const`/`let`, never `var`",
            "- Single quotes for strings",
            "- Indent with tabs",
            "- JSDoc comments for all public functions",
            "- Use `@wordpress/scripts` for builds (webpack-based)",
            "",
            "## CSS",
            "- Class names: lowercase hyphenated (`.my-block-name`)",
            "- BEM-style naming encouraged for blocks",
            "- No IDs for styling",
            "",
            "## Security Checklist",
            "- `sanitize_*()` on all inputs",
            "- `esc_*()` on all outputs",
            "- `wp_verify_nonce()` on all form submissions and AJAX calls",
            "- Capability checks: `current_user_can()` before privileged actions",
            "- Use `$wpdb->prepare()` for all database queries",
            "",
            "Full standards: https://developer.wordpress.org/coding-standards/",
          ].join("\n"),
        },
      ],
    })
  );
}
