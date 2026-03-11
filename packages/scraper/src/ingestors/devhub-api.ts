import type { DEVHUB_CONTENT_TYPES, DevHubPage } from "@wp-know-it-all/shared";
import { htmlToMarkdown, markdownToPlain } from "../pipeline/html-to-md.js";
import { extractMetadata } from "../pipeline/metadata.js";
import type { InsertableDocument } from "../db/writer.js";
import { withRetry } from "../lib/retry.js";

const BASE = "https://developer.wordpress.org/wp-json/wp/v2";
const PER_PAGE = 100;
const REQUEST_DELAY_MS = 600;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPage(url: string): Promise<Response> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "WP-Know-It-All-Scraper/1.0 (https://github.com/wp-know-it-all)",
      Accept: "application/json",
    },
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "10", 10);
    console.warn(`[devhub] Rate limited — waiting ${retryAfter}s`);
    await sleep(retryAfter * 1000);
    throw new Error(`Rate limited (429) fetching ${url}`);
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }

  return res;
}

export interface FetchOptions {
  /** ISO date string — only return posts modified after this date */
  modifiedAfter?: string;
  /** Resume from this page number (1-indexed) */
  startPage?: number;
  /** Called after each page is saved so the caller can checkpoint */
  onPageComplete?: (page: number, totalPages: number, fetchedCount: number) => void;
  /** Optional streaming callback to process one fetched page immediately */
  onPageData?: (pages: DevHubPage[]) => Promise<void> | void;
}

interface FetchAllResult {
  pages: DevHubPage[];
  failedPages: number[];
}

async function fetchAllOfType(
  contentType: string,
  opts: FetchOptions = {}
): Promise<FetchAllResult> {
  const { modifiedAfter, startPage = 1, onPageComplete, onPageData } = opts;
  const all: DevHubPage[] = [];
  const failedPages: number[] = [];
  let page = startPage;
  let totalPages = 1;
  let fetchedCount = 0;

  while (page <= totalPages) {
    const params = new URLSearchParams({
      per_page: String(PER_PAGE),
      page: String(page),
      _fields: "id,slug,link,title,content,parent,modified",
      orderby: "modified",
      order: "asc",
    });

    if (modifiedAfter) {
      params.set("after", modifiedAfter);
    }

    const url = `${BASE}/${contentType}?${params.toString()}`;

    let res: Response;
    try {
      res = await withRetry(() => fetchPage(url), 4, 2000, `devhub:${contentType}:p${page}`);
    } catch (err) {
      console.warn(`[devhub] Failed ${contentType} page ${page}, continuing: ${String(err)}`);
      failedPages.push(page);
      page++;
      continue;
    }

    const data = (await res.json()) as DevHubPage[];

    if (!Array.isArray(data) || data.length === 0) break;

    totalPages = parseInt(res.headers.get("X-WP-TotalPages") ?? "1", 10);
    fetchedCount += data.length;

    if (onPageData) {
      await onPageData(data);
    } else {
      all.push(...data);
    }

    console.log(`[devhub] ${contentType} — page ${page}/${totalPages} (${fetchedCount} fetched)`);
    onPageComplete?.(page, totalPages, fetchedCount);

    page++;
    if (page <= totalPages) await sleep(REQUEST_DELAY_MS);
  }

  return { pages: all, failedPages };
}

function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function pageToDocument(
  page: DevHubPage,
  category: (typeof DEVHUB_CONTENT_TYPES)[number]["category"],
  docType: (typeof DEVHUB_CONTENT_TYPES)[number]["docType"]
): InsertableDocument | null {
  const rawTitle =
    page.title?.rendered?.replace(/<[^>]+>/g, "").trim() || `Untitled (${page.id})`;
  const renderedContent = page.content?.rendered ?? "";
  if (!renderedContent.trim()) return null;

  const markdown = htmlToMarkdown(renderedContent);
  if (!markdown.trim()) return null;

  const plain = markdownToPlain(markdown);
  const meta = extractMetadata(markdown, rawTitle);

  let slug = page.slug;
  if (!slug || slug === "auto-draft") {
    slug = slugifyTitle(rawTitle);
  }

  return {
    url: page.link || `https://developer.wordpress.org/?p=${page.id}`,
    slug,
    title: rawTitle,
    doc_type: docType,
    source: "devhub-api",
    category,
    signature: meta.signature,
    since_version: meta.since_version,
    parent_id: page.parent && page.parent > 0 ? page.parent : null,
    content_markdown: markdown,
    content_plain: plain,
    functions_mentioned: meta.functions_mentioned.length > 0 ? meta.functions_mentioned : null,
    hooks_mentioned: meta.hooks_mentioned.length > 0 ? meta.hooks_mentioned : null,
    metadata: null,
  };
}

export interface IngestDevhubResult {
  documents: InsertableDocument[];
  failedPages: number[];
  processedDocuments: number;
}

export interface IngestDevhubOptions extends FetchOptions {
  onDocumentsBatch?: (docs: InsertableDocument[]) => Promise<void> | void;
}

export async function ingestDevhubContentType(
  typeConfig: (typeof DEVHUB_CONTENT_TYPES)[number],
  opts: IngestDevhubOptions = {}
): Promise<IngestDevhubResult> {
  const { type, category, docType } = typeConfig;
  const mode = opts.modifiedAfter ? `incremental (after ${opts.modifiedAfter})` : "full";
  console.log(`\n[devhub] Starting ${mode} ingest: ${type}`);

  const documents: InsertableDocument[] = [];
  let processedDocuments = 0;
  const onPageData = async (pages: DevHubPage[]): Promise<void> => {
    const batch: InsertableDocument[] = [];
    for (const page of pages) {
      const doc = pageToDocument(page, category, docType);
      if (doc) batch.push(doc);
    }
    processedDocuments += batch.length;
    if (opts.onDocumentsBatch) {
      await opts.onDocumentsBatch(batch);
      return;
    }
    if (batch.length > 0) {
      documents.push(...batch);
    }
  };

  const { pages, failedPages } = await fetchAllOfType(type, {
    ...opts,
    onPageData: opts.onDocumentsBatch ? onPageData : undefined,
  });

  if (!opts.onPageData) {
    console.log(
      `[devhub] ${type}: fetched ${pages.length} pages${failedPages.length > 0 ? ` (${failedPages.length} failed)` : ""}, converting...`
    );
    for (const page of pages) {
      const doc = pageToDocument(page, category, docType);
      if (doc) documents.push(doc);
    }
  }

  if (opts.onDocumentsBatch) {
    console.log(`[devhub] ${type}: ${processedDocuments} documents processed`);
    return { documents: [], failedPages, processedDocuments };
  }

  console.log(`[devhub] ${type}: ${documents.length} documents processed`);
  return { documents, failedPages, processedDocuments: documents.length };
}
