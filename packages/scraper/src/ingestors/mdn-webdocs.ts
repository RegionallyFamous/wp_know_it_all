import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { markdownToPlain } from "../pipeline/html-to-md.js";
import { extractMetadata } from "../pipeline/metadata.js";
import type { InsertableDocument } from "../db/writer.js";
import { MDN_DOCS_MANIFEST } from "./adjacent-manifests.js";
import {
  ensureSparseRepo,
  slugify,
  stripMarkdownFrontMatter,
  titleFromMarkdown,
  walkFiles,
} from "./adjacent-utils.js";
import { isHighValueDocument } from "./quality.js";

function toMdnUrl(relPathFromEnUs: string, frontMatterSlug?: string): string {
  const slug = frontMatterSlug?.trim().replace(/^\/+|\/+$/g, "");
  if (slug) {
    return `${MDN_DOCS_MANIFEST.baseUrl}/${slug}`;
  }
  const derived = relPathFromEnUs
    .replace(/\\/g, "/")
    .replace(/\/index\.md$/i, "")
    .replace(/\.md$/i, "");
  return `${MDN_DOCS_MANIFEST.baseUrl}/${derived}`;
}

function sectionFromRelPath(relPathFromEnUs: string): string {
  const normalized = relPathFromEnUs.replace(/\\/g, "/").toLowerCase();
  if (normalized.startsWith("web/http/")) return "http";
  if (normalized.startsWith("web/security/")) return "security";
  if (normalized.startsWith("web/api/fetch_api/")) return "fetch-api";
  return "web-api";
}

export async function ingestMdnWebDocs(cloneDir?: string): Promise<InsertableDocument[]> {
  const repoDir = cloneDir ?? join(tmpdir(), "mdn-content-repo");
  await ensureSparseRepo({
    repoDir,
    repoUrl: MDN_DOCS_MANIFEST.repoUrl,
    branch: MDN_DOCS_MANIFEST.branch,
    sparsePaths: [...MDN_DOCS_MANIFEST.sparsePaths],
    label: "mdn",
  });

  const docsRoot = join(repoDir, MDN_DOCS_MANIFEST.docsRoot);
  if (!existsSync(docsRoot)) {
    console.warn("[mdn] docs root not found");
    return [];
  }

  const documents: InsertableDocument[] = [];
  const seenUrls = new Set<string>();
  const seenSlugs = new Set<string>();
  const exts = new Set([".md"]);

  for (const filePath of walkFiles(docsRoot, exts)) {
    const relPath = relative(docsRoot, filePath).replace(/\\/g, "/");
    if (!relPath.startsWith("web/")) continue;
    if (relPath.includes("/_examples/") || relPath.includes("/_redirects")) continue;

    const raw = readFileSync(filePath, "utf-8");
    if (!raw.trim()) continue;

    const { body, frontMatter } = stripMarkdownFrontMatter(raw);
    const markdown = body.trim();
    if (!markdown) continue;
    if ((frontMatter["status"] ?? "").toLowerCase().includes("deprecated")) continue;

    const title = frontMatter["title"]?.trim() || titleFromMarkdown(markdown, filePath);
    const plain = markdownToPlain(markdown);
    const meta = extractMetadata(markdown, title);
    const url = toMdnUrl(relPath, frontMatter["slug"]);
    const slug = `mdn/${slugify(frontMatter["slug"] ?? relPath.replace(/\/index\.md$/i, "").replace(/\.md$/i, ""))}`;

    const doc: InsertableDocument = {
      url,
      slug,
      title,
      doc_type: "guide",
      source: "mdn-webdocs",
      category: "web-platform",
      signature: meta.signature,
      since_version: meta.since_version,
      parent_id: null,
      content_markdown: markdown,
      content_plain: plain,
      functions_mentioned: meta.functions_mentioned.length > 0 ? meta.functions_mentioned : null,
      hooks_mentioned: meta.hooks_mentioned.length > 0 ? meta.hooks_mentioned : null,
      metadata: {
        ecosystem: "web",
        section: sectionFromRelPath(relPath),
        repo: MDN_DOCS_MANIFEST.repoUrl,
      },
    };

    if (isHighValueDocument(doc, seenUrls, seenSlugs)) {
      documents.push(doc);
    }
  }

  console.log(`[mdn] ${documents.length} docs processed`);
  return documents;
}
