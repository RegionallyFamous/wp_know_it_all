import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { markdownToPlain } from "../pipeline/html-to-md.js";
import { extractMetadata } from "../pipeline/metadata.js";
import type { InsertableDocument } from "../db/writer.js";
import { NODEJS_DOCS_MANIFEST } from "./adjacent-manifests.js";
import {
  ensureSparseRepo,
  stripMarkdownFrontMatter,
  titleFromMarkdown,
  walkFiles,
} from "./adjacent-utils.js";
import { isHighValueDocument } from "./quality.js";

function isExcludedApiFile(path: string): boolean {
  const file = path.toLowerCase();
  return (
    file.endsWith(".json") ||
    file.endsWith("index.md") ||
    file.includes("assets/") ||
    file.includes("images/")
  );
}

function selectNodeAllowlist(): Set<string> {
  const bundleMode = process.env["NODE_DOCS_BUNDLE"] === "expanded" ? "expanded" : "core";
  const list =
    bundleMode === "expanded"
      ? [...NODEJS_DOCS_MANIFEST.coreAllowlist, ...NODEJS_DOCS_MANIFEST.expandedAllowlist]
      : [...NODEJS_DOCS_MANIFEST.coreAllowlist];
  return new Set(list.map((file) => file.toLowerCase()));
}

function nodeApiUrlFromRelPath(relPath: string): string {
  const slug = relPath.replace(/\\/g, "/").replace(/\.md$/i, "");
  return `${NODEJS_DOCS_MANIFEST.baseUrl}/${slug}.html`;
}

export async function ingestNodejsDocs(cloneDir?: string): Promise<InsertableDocument[]> {
  const bundleMode = process.env["NODE_DOCS_BUNDLE"] === "expanded" ? "expanded" : "core";
  const repoDir = cloneDir ?? join(tmpdir(), "nodejs-docs-repo");
  await ensureSparseRepo({
    repoDir,
    repoUrl: NODEJS_DOCS_MANIFEST.repoUrl,
    branch: NODEJS_DOCS_MANIFEST.branch,
    sparsePaths: [...NODEJS_DOCS_MANIFEST.sparsePaths],
    label: "nodejs",
  });

  const docsRoot = join(repoDir, NODEJS_DOCS_MANIFEST.docsRoot);
  if (!existsSync(docsRoot)) {
    console.warn("[nodejs] docs root not found");
    return [];
  }

  const documents: InsertableDocument[] = [];
  const seenUrls = new Set<string>();
  const seenSlugs = new Set<string>();
  const exts = new Set([".md"]);
  const allowlist = selectNodeAllowlist();

  for (const filePath of walkFiles(docsRoot, exts)) {
    const relPath = relative(docsRoot, filePath).replace(/\\/g, "/");
    if (isExcludedApiFile(relPath)) continue;
    if (!allowlist.has(relPath.toLowerCase())) continue;

    const raw = readFileSync(filePath, "utf-8");
    if (!raw.trim()) continue;

    const { body, frontMatter } = stripMarkdownFrontMatter(raw);
    const markdown = body.trim();
    if (!markdown) continue;

    const title = frontMatter["title"]?.trim() || titleFromMarkdown(markdown, filePath);
    const plain = markdownToPlain(markdown);
    const meta = extractMetadata(markdown, title);
    const slug = `nodejs/${relPath.replace(/\.md$/i, "").replace(/\//g, "-")}`;
    const url = nodeApiUrlFromRelPath(relPath);

    const doc: InsertableDocument = {
      url,
      slug,
      title,
      doc_type: "guide",
      source: "nodejs-docs",
      category: "nodejs-runtime",
      signature: meta.signature,
      since_version: meta.since_version,
      parent_id: null,
      content_markdown: markdown,
      content_plain: plain,
      functions_mentioned: meta.functions_mentioned.length > 0 ? meta.functions_mentioned : null,
      hooks_mentioned: meta.hooks_mentioned.length > 0 ? meta.hooks_mentioned : null,
      metadata: {
        ecosystem: "nodejs",
        section: "api",
        bundle: bundleMode,
        repo: NODEJS_DOCS_MANIFEST.repoUrl,
      },
    };

    if (isHighValueDocument(doc, seenUrls, seenSlugs)) {
      documents.push(doc);
    }
  }

  console.log(`[nodejs] ${documents.length} docs processed (bundle=${bundleMode})`);
  return documents;
}
