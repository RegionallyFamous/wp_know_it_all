import { simpleGit } from "simple-git";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, extname, relative, basename } from "node:path";
import { tmpdir } from "node:os";
import { markdownToPlain } from "../pipeline/html-to-md.js";
import { extractMetadata } from "../pipeline/metadata.js";
import type { InsertableDocument } from "../db/writer.js";

const GUTENBERG_REPO = "https://github.com/WordPress/gutenberg.git";
const DOCS_SUBPATH = "docs";
const SPARSE_PATHS = ["docs"];
const BASE_URL = "https://developer.wordpress.org/block-editor";

function* walkMarkdownFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      yield* walkMarkdownFiles(full);
    } else if (extname(full) === ".md" || extname(full) === ".mdx") {
      yield full;
    }
  }
}

function filePathToSlug(filePath: string, docsRoot: string): string {
  const rel = relative(docsRoot, filePath);
  return rel
    .replace(/\.(md|mdx)$/, "")
    .replace(/\/index$/, "")
    .replace(/\\/g, "/")
    .replace(/[^a-z0-9/-]/gi, "-")
    .toLowerCase();
}

function filePathToUrl(filePath: string, docsRoot: string): string {
  const slug = filePathToSlug(filePath, docsRoot);
  return `${BASE_URL}/${slug}/`;
}

function extractTitleFromMarkdown(content: string, filename: string): string {
  const h1 = /^#\s+(.+)$/m.exec(content);
  if (h1?.[1]) return h1[1].trim();
  return basename(filename, extname(filename))
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function ingestGutenbergDocs(
  cloneDir?: string
): Promise<InsertableDocument[]> {
  const repoDir = cloneDir ?? join(tmpdir(), "gutenberg-repo");

  if (!existsSync(repoDir)) {
    console.log("[gutenberg] Cloning WordPress/gutenberg (sparse, docs only)...");
    const git = simpleGit();
    await git.clone(GUTENBERG_REPO, repoDir, [
      "--depth=1",
      "--filter=blob:none",
      "--sparse",
      "--single-branch",
      "--branch=trunk",
    ]);
    const repoGit = simpleGit(repoDir);
    await repoGit.raw(["sparse-checkout", "set", ...SPARSE_PATHS]);
  } else {
    console.log("[gutenberg] Updating existing clone...");
    const git = simpleGit(repoDir);
    await git.pull("origin", "trunk", ["--depth=1"]);
  }

  const docsRoot = join(repoDir, DOCS_SUBPATH);
  if (!existsSync(docsRoot)) {
    console.warn("[gutenberg] docs/ directory not found in repo");
    return [];
  }

  console.log("[gutenberg] Processing markdown files...");
  const documents: InsertableDocument[] = [];

  for (const filePath of walkMarkdownFiles(docsRoot)) {
    const content = readFileSync(filePath, "utf-8");
    if (!content.trim()) continue;

    const title = extractTitleFromMarkdown(content, filePath);
    const slug = filePathToSlug(filePath, docsRoot);
    const url = filePathToUrl(filePath, docsRoot);
    const plain = markdownToPlain(content);
    const meta = extractMetadata(content, title);

    documents.push({
      url,
      slug: `block-editor/${slug}`,
      title,
      doc_type: "guide",
      source: "gutenberg-github",
      category: "block-editor",
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

  console.log(`[gutenberg] ${documents.length} docs processed`);
  return documents;
}
