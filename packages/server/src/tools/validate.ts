import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validateWordPressCode } from "../validation/engine.js";
import type { ValidationIssue } from "../validation/types.js";

export function registerValidateTool(server: McpServer): void {
  server.registerTool(
    "validate_wordpress_code",
    {
      description:
        "Validate a WordPress PHP code snippet against 30 security rules, coding standards, and best practices. Returns a score (0–100), issues grouped by severity, fix suggestions, and documentation links. Run this before finalizing any WordPress PHP code.",
      inputSchema: {
        code: z
          .string()
          .min(1)
          .max(50_000)
          .describe(
            "The PHP code snippet to validate. Include the <?php opening tag for accurate analysis."
          ),
        context: z
          .enum(["plugin", "theme", "block", "general"])
          .default("general")
          .describe("The context this code runs in — affects which rules apply."),
      },
    },
    async ({ code }) => {
      const result = validateWordPressCode(code);

      if (result.issues.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `## Validation Score: 100/100 — All checks passed`,
                "",
                "This code follows WordPress security standards and coding practices.",
                "No issues detected across 30 security, standards, and best-practice rules.",
              ].join("\n"),
            },
          ],
        };
      }

      const errors = result.issues.filter((i) => i.severity === "error");
      const warnings = result.issues.filter((i) => i.severity === "warning");
      const infos = result.issues.filter((i) => i.severity === "info");

      const formatIssue = (i: ValidationIssue, icon: string) =>
        [
          `${icon} **${i.rule}**${i.line != null ? ` _(line ${i.line})_` : ""}`,
          `   ${i.message}`,
          `   **Fix:** ${i.fix}`,
          `   **Docs:** ${i.docs_url}`,
        ].join("\n");

      const parts: string[] = [
        `## Validation Score: ${result.score}/100 — ${result.summary}`,
        "",
        result.passed
          ? "No blocking errors. Warnings and suggestions should be addressed before production."
          : "**Errors must be fixed before this code is production-safe.**",
      ];

      if (errors.length > 0) {
        parts.push("", `### Errors (${errors.length} — must fix)`);
        parts.push(...errors.map((i) => formatIssue(i, "⛔")));
      }
      if (warnings.length > 0) {
        parts.push("", `### Warnings (${warnings.length} — should fix)`);
        parts.push(...warnings.map((i) => formatIssue(i, "⚠️")));
      }
      if (infos.length > 0) {
        parts.push("", `### Suggestions (${infos.length})`);
        parts.push(...infos.map((i) => formatIssue(i, "ℹ️")));
      }

      return { content: [{ type: "text" as const, text: parts.join("\n") }] };
    }
  );
}
