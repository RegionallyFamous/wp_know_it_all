import { markdownToPlain } from "../pipeline/html-to-md.js";
import { extractMetadata } from "../pipeline/metadata.js";
import type { InsertableDocument } from "../db/writer.js";
import { IETF_RFCS_MANIFEST } from "./adjacent-manifests.js";
import { slugify } from "./adjacent-utils.js";
import { isHighValueDocument } from "./quality.js";

function normalizeRfcText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractRfcTitle(text: string, fallback: string): string {
  const firstLines = text.split("\n").slice(0, 80);
  for (const line of firstLines) {
    const trimmed = line.trim();
    if (trimmed.length < 6) continue;
    if (/^rfc\s*\d+/i.test(trimmed)) continue;
    if (/^(internet\s+engineering|request\s+for\s+comments)/i.test(trimmed)) continue;
    if (/^\d{4}\s*$/i.test(trimmed)) continue;
    return trimmed;
  }
  return fallback;
}

function rfcNumberFromUrl(url: string): string {
  const match = /rfc(\d+)\.txt$/i.exec(url);
  return match?.[1] ?? "unknown";
}

export async function ingestIetfRfcs(): Promise<InsertableDocument[]> {
  const bundleMode = process.env["IETF_RFC_BUNDLE"] === "expanded" ? "expanded" : "core";
  const urls =
    bundleMode === "expanded"
      ? [...IETF_RFCS_MANIFEST.coreUrls, ...IETF_RFCS_MANIFEST.expandedUrls]
      : [...IETF_RFCS_MANIFEST.coreUrls];
  const documents: InsertableDocument[] = [];
  const seenUrls = new Set<string>();
  const seenSlugs = new Set<string>();

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "WP-Know-It-All-Scraper/1.0 (https://github.com/wp-know-it-all)",
          Accept: "text/plain",
        },
      });
      if (!response.ok) {
        console.warn(`[ietf] Skipping ${url} (HTTP ${response.status})`);
        continue;
      }
      const rawText = normalizeRfcText(await response.text());
      if (!rawText) continue;

      const rfcNumber = rfcNumberFromUrl(url);
      const title = extractRfcTitle(rawText, `RFC ${rfcNumber}`);
      const markdown = `# RFC ${rfcNumber}: ${title}\n\n${rawText}`;
      const plain = markdownToPlain(markdown);
      const meta = extractMetadata(markdown, title);
      const slug = `ietf-rfc/${slugify(`rfc-${rfcNumber}-${title}`)}`;

      const doc: InsertableDocument = {
        url,
        slug,
        title: `RFC ${rfcNumber}: ${title}`,
        doc_type: "guide",
        source: "ietf-rfcs",
        category: "software-engineering",
        signature: meta.signature,
        since_version: meta.since_version,
        parent_id: null,
        content_markdown: markdown,
        content_plain: plain,
        functions_mentioned: meta.functions_mentioned.length > 0 ? meta.functions_mentioned : null,
        hooks_mentioned: meta.hooks_mentioned.length > 0 ? meta.hooks_mentioned : null,
        metadata: {
          ecosystem: "standards",
          section: "ietf-rfc",
          bundle: bundleMode,
          rfc_number: rfcNumber,
        },
      };

      if (isHighValueDocument(doc, seenUrls, seenSlugs)) {
        documents.push(doc);
      }
    } catch (error) {
      console.warn(`[ietf] Failed ${url}: ${String(error)}`);
    }
  }

  console.log(`[ietf] ${documents.length} docs processed (bundle=${bundleMode})`);
  return documents;
}
