import { simpleGit } from "simple-git";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { markdownToPlain } from "../pipeline/html-to-md.js";
import { extractMetadata } from "../pipeline/metadata.js";
import type { InsertableDocument } from "../db/writer.js";

const WPCLI_REPO = "https://github.com/wp-cli/handbook.git";
const BASE_URL = "https://make.wordpress.org/cli/handbook";

interface CommandManifestEntry {
  title: string;
  slug: string;
  markdown_source: string;
  parent?: string | null;
}

interface HandbookManifestEntry {
  title: string;
  slug: string;
  markdown_source: string;
  children?: HandbookManifestEntry[];
}

export async function ingestWpCliHandbook(
  cloneDir?: string
): Promise<InsertableDocument[]> {
  const repoDir = cloneDir ?? join(tmpdir(), "wpcli-handbook-repo");

  if (!existsSync(repoDir)) {
    console.log("[wpcli] Cloning wp-cli/handbook...");
    const git = simpleGit();
    await git.clone(WPCLI_REPO, repoDir, ["--depth=1", "--single-branch"]);
  } else {
    console.log("[wpcli] Updating existing clone...");
    await simpleGit(repoDir).pull("origin", "main", ["--depth=1"]);
  }

  const documents: InsertableDocument[] = [];

  // Process commands manifest
  const commandsManifestPath = join(repoDir, "commands-manifest.json");
  if (existsSync(commandsManifestPath)) {
    const manifest = JSON.parse(
      readFileSync(commandsManifestPath, "utf-8")
    ) as CommandManifestEntry[];

    for (const entry of manifest) {
      const filePath = join(repoDir, entry.markdown_source);
      if (!existsSync(filePath)) continue;

      const content = readFileSync(filePath, "utf-8");
      if (!content.trim()) continue;

      const title = entry.title || `wp ${entry.slug}`;
      const plain = markdownToPlain(content);
      const meta = extractMetadata(content, title);

      documents.push({
        url: `${BASE_URL}/commands/${entry.slug}/`,
        slug: `wpcli-commands/${entry.slug.replace(/\//g, "-")}`,
        title,
        doc_type: "guide",
        source: "wpcli-github",
        category: "code-reference",
        signature: meta.signature,
        since_version: meta.since_version,
        parent_id: null,
        content_markdown: content,
        content_plain: plain,
        functions_mentioned: meta.functions_mentioned.length > 0 ? meta.functions_mentioned : null,
        hooks_mentioned: meta.hooks_mentioned.length > 0 ? meta.hooks_mentioned : null,
        metadata: { wpcli_parent: entry.parent ?? null },
      });
    }

    console.log(`[wpcli] commands-manifest: ${documents.length} entries`);
  }

  // Process handbook manifest
  const handbookManifestPath = join(repoDir, "handbook-manifest.json");
  if (existsSync(handbookManifestPath)) {
    const manifest = JSON.parse(
      readFileSync(handbookManifestPath, "utf-8")
    ) as HandbookManifestEntry[];

    function processEntry(entry: HandbookManifestEntry): void {
      const filePath = join(repoDir, entry.markdown_source);
      if (existsSync(filePath)) {
        const content = readFileSync(filePath, "utf-8");
        if (content.trim()) {
          const title = entry.title;
          const plain = markdownToPlain(content);
          const meta = extractMetadata(content, title);

          documents.push({
            url: `${BASE_URL}/${entry.slug}/`,
            slug: `wpcli-handbook/${entry.slug.replace(/\//g, "-")}`,
            title,
            doc_type: "guide",
            source: "wpcli-github",
            category: "code-reference",
            signature: meta.signature,
            since_version: meta.since_version,
            parent_id: null,
            content_markdown: content,
            content_plain: plain,
            functions_mentioned: meta.functions_mentioned.length > 0 ? meta.functions_mentioned : null,
            hooks_mentioned: meta.hooks_mentioned.length > 0 ? meta.hooks_mentioned : null,
            metadata: null,
          });
        }
      }

      if (entry.children) {
        for (const child of entry.children) {
          processEntry(child);
        }
      }
    }

    for (const entry of manifest) {
      processEntry(entry);
    }

    console.log(`[wpcli] handbook-manifest + commands-manifest: ${documents.length} total entries`);
  }

  return documents;
}
