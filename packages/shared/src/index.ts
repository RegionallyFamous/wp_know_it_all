export type DocType = "function" | "hook" | "class" | "method" | "guide" | "example";

export type DocSource =
  | "devhub-api"
  | "gutenberg-github"
  | "wpcli-github"
  | "wordpress-github-docs"
  | "wordpress-github-code"
  | "php-manual"
  | "nodejs-docs"
  | "mdn-webdocs"
  | "ietf-rfcs"
  | "python-docs";

export type DocCategory =
  | "code-reference"
  | "plugin-handbook"
  | "theme-handbook"
  | "block-editor"
  | "rest-api"
  | "common-apis"
  | "coding-standards"
  | "admin"
  | "scf"
  | "php-core"
  | "nodejs-runtime"
  | "web-platform"
  | "software-engineering"
  | "python-runtime";

export interface Document {
  id: number;
  url: string;
  slug: string;
  title: string;
  doc_type: DocType;
  source: DocSource;
  category: DocCategory | null;
  signature: string | null;
  since_version: string | null;
  parent_id: number | null;
  content_markdown: string;
  content_plain: string;
  functions_mentioned: string[] | null;
  hooks_mentioned: string[] | null;
  metadata: Record<string, unknown> | null;
  indexed_at: number;
}

export interface DocumentRow
  extends Omit<Document, "functions_mentioned" | "hooks_mentioned" | "metadata"> {
  functions_mentioned: string | null;
  hooks_mentioned: string | null;
  metadata: string | null;
}

export interface SearchResult {
  id: number;
  url: string;
  title: string;
  doc_type: DocType;
  source: DocSource;
  category: DocCategory | null;
  slug: string;
  excerpt: string;
  score: number;
}

export interface DevHubPage {
  id: number;
  slug: string;
  link: string;
  title?: { rendered?: string };
  excerpt?: { rendered?: string };
  content?: { rendered?: string };
  parent?: number;
  modified: string;
}

export const DEVHUB_CONTENT_TYPES: Array<{
  type: string;
  category: DocCategory;
  docType: DocType;
}> = [
  { type: "wp-parser-function", category: "code-reference", docType: "function" },
  { type: "wp-parser-hook",     category: "code-reference", docType: "hook" },
  { type: "wp-parser-class",    category: "code-reference", docType: "class" },
  { type: "wp-parser-method",   category: "code-reference", docType: "method" },
  { type: "plugin-handbook",    category: "plugin-handbook", docType: "guide" },
  { type: "theme-handbook",     category: "theme-handbook",  docType: "guide" },
  { type: "blocks-handbook",    category: "block-editor",    docType: "guide" },
  { type: "rest-api-handbook",  category: "rest-api",        docType: "guide" },
  { type: "apis-handbook",      category: "common-apis",     docType: "guide" },
  { type: "wpcs-handbook",      category: "coding-standards", docType: "guide" },
  { type: "adv-admin-handbook", category: "admin",           docType: "guide" },
  { type: "scf-handbook",       category: "scf",             docType: "guide" },
];
