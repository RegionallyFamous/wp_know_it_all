import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { markdownToPlain } from "../pipeline/html-to-md.js";
import { extractMetadata } from "../pipeline/metadata.js";
import type { InsertableDocument } from "../db/writer.js";
import { PHP_MANUAL_MANIFEST } from "./adjacent-manifests.js";
import { decodeCommonEntities, ensureSparseRepo, slugify, walkFiles } from "./adjacent-utils.js";
import { isHighValueDocument } from "./quality.js";

function xmlTagText(xml: string, tagName: string): string | null {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, "i");
  const match = regex.exec(xml);
  if (!match?.[1]) return null;
  return decodeCommonEntities(match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function topLevelId(xml: string): string | null {
  const rootId = /<(?:refentry|section|chapter|appendix|article)\b[^>]*\b(?:xml:)?id="([^"]+)"/i.exec(xml);
  return rootId?.[1] ?? null;
}

function inferDocType(id: string): InsertableDocument["doc_type"] {
  if (id.startsWith("function.")) return "function";
  if (id.startsWith("class.")) return "class";
  if (id.startsWith("language.operators.") || id.startsWith("language.construct.")) return "method";
  return "guide";
}

function sectionFromRelPath(path: string): string {
  const segment = path.replace(/\\/g, "/").split("/")[0]?.toLowerCase() ?? "manual";
  return segment;
}

function phpManualUrl(id: string): string {
  return `${PHP_MANUAL_MANIFEST.baseUrl}/${id.toLowerCase()}.php`;
}

export async function ingestPhpManual(cloneDir?: string): Promise<InsertableDocument[]> {
  const repoDir = cloneDir ?? join(tmpdir(), "php-doc-en-repo");
  await ensureSparseRepo({
    repoDir,
    repoUrl: PHP_MANUAL_MANIFEST.repoUrl,
    branch: PHP_MANUAL_MANIFEST.branch,
    sparsePaths: [...PHP_MANUAL_MANIFEST.sparsePaths],
    label: "php",
  });

  const docsRoot = join(repoDir, PHP_MANUAL_MANIFEST.docsRoot);
  if (!existsSync(docsRoot)) {
    console.warn("[php] docs root not found");
    return [];
  }

  const documents: InsertableDocument[] = [];
  const seenUrls = new Set<string>();
  const seenSlugs = new Set<string>();
  const exts = new Set([".xml"]);

  for (const filePath of walkFiles(docsRoot, exts)) {
    const relPath = relative(docsRoot, filePath).replace(/\\/g, "/");
    if (relPath.includes("/entities/") || relPath.includes("/stylesheets/")) continue;

    const xml = readFileSync(filePath, "utf-8");
    if (!xml.trim()) continue;

    const id = topLevelId(xml);
    if (!id) continue;

    const title = xmlTagText(xml, "refname") ?? xmlTagText(xml, "title") ?? id;
    const bodyText = decodeCommonEntities(
      xml
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/<programlisting[\s\S]*?<\/programlisting>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    );
    if (!bodyText) continue;

    const markdown = `# ${title}\n\n${bodyText}`;
    const plain = markdownToPlain(markdown);
    const meta = extractMetadata(markdown, title);
    const slug = `php/${slugify(id)}`;
    const url = phpManualUrl(id);

    const doc: InsertableDocument = {
      url,
      slug,
      title,
      doc_type: inferDocType(id),
      source: "php-manual",
      category: "php-core",
      signature: meta.signature,
      since_version: meta.since_version,
      parent_id: null,
      content_markdown: markdown,
      content_plain: plain,
      functions_mentioned: meta.functions_mentioned.length > 0 ? meta.functions_mentioned : null,
      hooks_mentioned: meta.hooks_mentioned.length > 0 ? meta.hooks_mentioned : null,
      metadata: {
        ecosystem: "php",
        section: sectionFromRelPath(relPath),
        source_id: id,
        repo: PHP_MANUAL_MANIFEST.repoUrl,
      },
    };

    if (isHighValueDocument(doc, seenUrls, seenSlugs)) {
      documents.push(doc);
    }
  }

  console.log(`[php] ${documents.length} docs processed`);
  return documents;
}
