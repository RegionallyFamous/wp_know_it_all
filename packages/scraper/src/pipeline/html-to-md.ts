import TurndownService from "turndown";

// Singleton — Turndown setup is expensive to repeat
let _td: TurndownService | null = null;

function getTurndown(): TurndownService {
  if (_td) return _td;

  _td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    fence: "```",
    bulletListMarker: "-",
    strongDelimiter: "**",
    emDelimiter: "_",
  });

  // Rule: WordPress code blocks — preserve language class
  // Handles <pre class="wp-block-code"><code class="language-php">...</code></pre>
  _td.addRule("wp-code-block", {
    filter(node: HTMLElement) {
      return (
        node.nodeName === "PRE" &&
        (node.classList?.contains("wp-block-code") ||
          node.querySelector?.("code") !== null)
      );
    },
    replacement(_content: string, node: HTMLElement) {
      const code = node.querySelector("code");
      if (!code) return _content;

      const langMatch = (code.className ?? "").match(/(?:language|lang)-(\S+)/);
      const lang = langMatch?.[1] ?? "";
      const text = code.textContent ?? "";

      return `\n\n\`\`\`${lang}\n${text.trimEnd()}\n\`\`\`\n\n`;
    },
  });

  // Rule: WordPress <kbd> keyboard shortcuts → inline code
  _td.addRule("wp-kbd", {
    filter: ["kbd"],
    replacement: (content: string) => `\`${content}\``,
  });

  // Rule: Strip screen reader text
  _td.addRule("wp-sr-only", {
    filter(node: HTMLElement) {
      return (
        (node.nodeName === "SPAN" || node.nodeName === "P") &&
        node.classList?.contains("screen-reader-text")
      );
    },
    replacement: () => "",
  });

  // Rule: DevHub <dl>/<dt>/<dd> parameter tables → bold label + description
  _td.addRule("dl-params", {
    filter: ["dl"],
    replacement(_content: string, node: HTMLElement) {
      const pairs: string[] = [];
      for (const child of Array.from(node.children ?? [])) {
        const el = child as HTMLElement;
        if (el.tagName === "DT") {
          pairs.push(`\n**${el.textContent?.trim() ?? ""}**`);
        } else if (el.tagName === "DD") {
          pairs.push(`:   ${el.textContent?.trim() ?? ""}`);
        }
      }
      return `\n\n${pairs.join("\n")}\n\n`;
    },
  });

  // Rule: Strip DevHub breadcrumb nav and sidebar artifacts
  _td.addRule("wp-nav-strip", {
    filter(node: HTMLElement) {
      const role = node.getAttribute?.("role");
      const cls = node.className ?? "";
      return (
        role === "navigation" ||
        cls.includes("breadcrumb") ||
        cls.includes("entry-meta") ||
        cls.includes("post-navigation")
      );
    },
    replacement: () => "",
  });

  return _td;
}

export function htmlToMarkdown(html: string): string {
  const td = getTurndown();
  return td.turndown(html).trim();
}

/** Strip markdown formatting to produce plain text for FTS indexing */
export function markdownToPlain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ") // remove code blocks
    .replace(/`[^`]+`/g, " ")        // remove inline code
    .replace(/^#{1,6}\s+/gm, "")     // remove headings
    .replace(/\*\*([^*]+)\*\*/g, "$1") // remove bold
    .replace(/_([^_]+)_/g, "$1")     // remove italic
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // remove links, keep text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "")  // remove images
    .replace(/^[-*+]\s+/gm, "")      // remove list markers
    .replace(/^\d+\.\s+/gm, "")      // remove numbered lists
    .replace(/\n{3,}/g, "\n\n")      // collapse whitespace
    .trim();
}
