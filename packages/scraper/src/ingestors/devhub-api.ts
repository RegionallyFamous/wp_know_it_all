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
}

async function fetchAllOfType(
  contentType: string,
  opts: FetchOptions = {}
): Promise<DevHubPage[]> {
  const { modifiedAfter, startPage = 1, onPageComplete } = opts;
  const all: DevHubPage[] = [];
  let page = startPage;
  let totalPages = 1;

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
      console.warn(`[devhub] Giving up on ${contentType} page ${page}: ${String(err)}`);
      break;
    }

    const data = (await res.json()) as DevHubPage[];

    if (!Array.isArray(data) || data.length === 0) break;

    totalPages = parseInt(res.headers.get("X-WP-TotalPages") ?? "1", 10);
    all.push(...data);

    console.log(`[devhub] ${contentType} — page ${page}/${totalPages} (${all.length} fetched)`);
    onPageComplete?.(page, totalPages, all.length);

    page++;
    if (page <= totalPages) await sleep(REQUEST_DELAY_MS);
  }

  return all;
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
  const rawTitle = page.title.rendered.replace(/<[^>]+>/g, "").trim() || `Untitled (${page.id})`;

  if (!page.content.rendered?.trim()) return null;

  const markdown = htmlToMarkdown(page.content.rendered);
  if (!markdown.trim()) return null;

  const plain = markdownToPlain(markdown);
  const meta = extractMetadata(markdown, rawTitle);

  let slug = page.slug;
  if (!slug || slug === "auto-draft") {
    slug = slugifyTitle(rawTitle);
  }

  return {
    url: page.link,
    slug,
    title: rawTitle,
    doc_type: docType,
    source: "devhub-api",
    category,
    signature: meta.signature,
    since_version: meta.since_version,
    parent_id: page.parent > 0 ? page.parent : null,
    content_markdown: markdown,
    content_plain: plain,
    functions_mentioned: meta.functions_mentioned.length > 0 ? meta.functions_mentioned : null,
    hooks_mentioned: meta.hooks_mentioned.length > 0 ? meta.hooks_mentioned : null,
    metadata: null,
  };
}

export async function ingestDevhubContentType(
  typeConfig: (typeof DEVHUB_CONTENT_TYPES)[number],
  opts: FetchOptions = {}
): Promise<InsertableDocument[]> {
  const { type, category, docType } = typeConfig;
  const mode = opts.modifiedAfter ? `incremental (after ${opts.modifiedAfter})` : "full";
  console.log(`\n[devhub] Starting ${mode} ingest: ${type}`);

  const pages = await fetchAllOfType(type, opts);
  console.log(`[devhub] ${type}: fetched ${pages.length} pages, converting...`);

  const documents: InsertableDocument[] = [];

  for (const page of pages) {
    const doc = pageToDocument(page, category, docType);
    if (doc) documents.push(doc);
  }

  console.log(`[devhub] ${type}: ${documents.length} documents processed`);
  return documents;
}
