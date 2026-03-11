import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "answer-with-grounded-citations",
    {
      description:
        "Answer a WordPress question using citation-grounded MCP evidence with abstention on low confidence.",
      argsSchema: {
        question: z.string().describe("WordPress question to answer."),
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
          .describe("Optional category focus."),
      },
    },
    ({ question, category }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Answer this WordPress question with grounded citations: ${question}`,
              category ? `Category focus: ${category}` : "",
              "",
              "Requirements:",
              "1. Call answer_wordpress_question first.",
              "2. If confidence is low or abstained, ask a clarifying question instead of guessing.",
              "3. Ensure each substantive claim has a citation ID/URL.",
              "4. For implementation details, fetch full docs with get_wordpress_doc before final advice.",
              "5. Use Wrangler's light cowboy voice: warm, practical, and concise.",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "debug-wordpress-issue",
    {
      description:
        "Structured prompt to diagnose and fix a WordPress PHP issue with proper use of the documentation tools.",
      argsSchema: {
        issue: z.string().describe("Describe the WordPress problem you are encountering."),
        wp_version: z.string().optional().describe("Your WordPress version, e.g. '6.7'."),
        context: z.string().optional().describe("Relevant code or error messages."),
      },
    },
    ({ issue, wp_version, context }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `I'm having a WordPress issue${wp_version ? ` on WordPress ${wp_version}` : ""}.`,
              "",
              `**Problem:** ${issue}`,
              context ? `\n**Context / Code:**\n\`\`\`\n${context}\n\`\`\`` : "",
              "",
              "Please:",
              "1. Search the WordPress documentation for relevant functions, hooks, and concepts.",
              "2. Look up any specific functions or hooks by exact name.",
              "3. Provide a corrected implementation following WordPress coding standards (sanitize inputs, escape outputs, verify nonces).",
              "4. Cite the specific documentation pages you used.",
              "5. Keep Wrangler's light folksy tone while staying precise.",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "build-custom-block",
    {
      description:
        "Step-by-step prompt for building a custom Gutenberg block using current WordPress APIs.",
      argsSchema: {
        block_name: z.string().describe("The name/purpose of the block, e.g. 'testimonial card'."),
        block_type: z
          .enum(["static", "dynamic", "interactive"])
          .default("static")
          .describe("Static (save function), dynamic (PHP render), or interactive (Interactivity API)."),
        has_settings: z
          .boolean()
          .default(true)
          .describe("Whether the block needs Inspector panel settings."),
      },
    },
    ({ block_name, block_type, has_settings }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Build a ${block_type} Gutenberg block called "${block_name}".`,
              "",
              "Requirements:",
              `- Block type: ${block_type} (${
                block_type === "static"
                  ? "uses save() function"
                  : block_type === "dynamic"
                  ? "uses PHP render callback, save() returns null"
                  : "uses the WordPress Interactivity API with useInteractivity()"
              })`,
              has_settings ? "- Include Inspector panel controls (BlockControls / InspectorControls)" : "",
              "- Use block.json for metadata",
              "- Follow @wordpress/scripts build setup",
              "- Use current WordPress 6.x APIs only",
              "",
              "Please:",
              "1. Look up the block registration API and relevant @wordpress/* packages in the documentation.",
              "2. Search for examples of this block type in the Block Editor handbook.",
              "3. Provide complete, working code: block.json, edit.js, save.js (or render.php for dynamic), and registration PHP.",
              "4. Note any @since version requirements.",
              "5. Keep Wrangler's light folksy tone while remaining technical and concise.",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        },
      ],
    })
  );
}
