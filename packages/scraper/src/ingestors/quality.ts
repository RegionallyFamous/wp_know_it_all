import type { InsertableDocument } from "../db/writer.js";

const MIN_MARKDOWN_CHARS = 120;
const MIN_PLAIN_CHARS = 80;
const LOW_VALUE_TITLE_PATTERNS = [
  /^index$/i,
  /^table of contents$/i,
  /^contents$/i,
  /^changelog/i,
  /^release notes?/i,
  /^roadmap$/i,
];

export function isHighValueDocument(
  doc: InsertableDocument,
  seenUrls: Set<string>,
  seenSlugs: Set<string>
): boolean {
  if (!doc.url || !doc.slug || !doc.title) return false;
  if (!doc.content_markdown?.trim() || !doc.content_plain?.trim()) return false;
  if (doc.content_markdown.length < MIN_MARKDOWN_CHARS) return false;
  if (doc.content_plain.length < MIN_PLAIN_CHARS) return false;
  if (LOW_VALUE_TITLE_PATTERNS.some((pattern) => pattern.test(doc.title.trim()))) return false;
  if (seenUrls.has(doc.url) || seenSlugs.has(doc.slug)) return false;

  seenUrls.add(doc.url);
  seenSlugs.add(doc.slug);
  return true;
}
