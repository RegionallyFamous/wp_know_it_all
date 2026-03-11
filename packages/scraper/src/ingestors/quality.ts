import type { InsertableDocument } from "../db/writer.js";

const MIN_MARKDOWN_CHARS = 120;
const MIN_PLAIN_CHARS = 80;
const MAX_TITLE_CHARS = 180;
const LOW_VALUE_TITLE_PATTERNS = [
  /^index$/i,
  /^table of contents$/i,
  /^contents$/i,
  /^changelog/i,
  /^release notes?/i,
  /^roadmap$/i,
  /^license$/i,
  /^contributing$/i,
  /^about$/i,
];
const LOW_VALUE_CONTENT_PATTERNS = [
  /\ball rights reserved\b/i,
  /\btable of contents\b/i,
  /\bnavigation\b/i,
  /\bedit this page\b/i,
];

const REQUIRE_METADATA_FOR_SOURCES = new Set<string>([
  "php-manual",
  "nodejs-docs",
  "mdn-webdocs",
  "ietf-rfcs",
  "python-docs",
  "wordpress-github-docs",
  "wordpress-github-code",
]);

function hasRequiredMetadata(doc: InsertableDocument): boolean {
  if (!REQUIRE_METADATA_FOR_SOURCES.has(doc.source)) return true;
  const metadata = doc.metadata;
  if (!metadata || typeof metadata !== "object") return false;
  const ecosystem = metadata["ecosystem"];
  const section = metadata["section"];
  return typeof ecosystem === "string" && ecosystem.length > 0 && typeof section === "string" && section.length > 0;
}

export function isHighValueDocument(
  doc: InsertableDocument,
  seenUrls: Set<string>,
  seenSlugs: Set<string>
): boolean {
  if (!doc.url || !doc.slug || !doc.title) return false;
  if (doc.title.length > MAX_TITLE_CHARS) return false;
  if (!doc.content_markdown?.trim() || !doc.content_plain?.trim()) return false;
  if (doc.content_markdown.length < MIN_MARKDOWN_CHARS) return false;
  if (doc.content_plain.length < MIN_PLAIN_CHARS) return false;
  if (LOW_VALUE_CONTENT_PATTERNS.some((pattern) => pattern.test(doc.content_plain))) return false;
  if (LOW_VALUE_TITLE_PATTERNS.some((pattern) => pattern.test(doc.title.trim()))) return false;
  if (!hasRequiredMetadata(doc)) return false;
  if (seenUrls.has(doc.url) || seenSlugs.has(doc.slug)) return false;

  seenUrls.add(doc.url);
  seenSlugs.add(doc.slug);
  return true;
}
