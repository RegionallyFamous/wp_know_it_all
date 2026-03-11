export type AdjacentSourceType =
  | "php-manual"
  | "nodejs-docs"
  | "mdn-webdocs"
  | "ietf-rfcs"
  | "python-docs";

export const ADJACENT_SOURCE_ORDER: AdjacentSourceType[] = [
  "php-manual",
  "nodejs-docs",
  "mdn-webdocs",
  "ietf-rfcs",
  "python-docs",
];

export const NODEJS_DOCS_MANIFEST = {
  repoUrl: "https://github.com/nodejs/node.git",
  branch: "main",
  sparsePaths: ["doc/api"],
  docsRoot: "doc/api",
  baseUrl: "https://nodejs.org/api",
  coreAllowlist: [
    "fs.md",
    "path.md",
    "http.md",
    "https.md",
    "url.md",
    "stream.md",
    "crypto.md",
    "timers.md",
    "process.md",
    "child_process.md",
  ],
  expandedAllowlist: [
    "events.md",
    "buffer.md",
    "worker_threads.md",
    "test.md",
    "assert.md",
    "util.md",
  ],
} as const;

export const MDN_DOCS_MANIFEST = {
  repoUrl: "https://github.com/mdn/content.git",
  branch: "main",
  coreSparsePaths: [
    "files/en-us/web/http",
    "files/en-us/web/api/fetch_api",
    "files/en-us/web/security",
    "files/en-us/web/javascript/reference/global_objects/url",
  ],
  expandedSparsePaths: [
    "files/en-us/web/http/cors",
    "files/en-us/web/http/headers",
    "files/en-us/web/javascript/reference/global_objects/promise",
    "files/en-us/web/performance",
  ],
  docsRoot: "files/en-us",
  baseUrl: "https://developer.mozilla.org/en-US/docs",
} as const;

export const PHP_MANUAL_MANIFEST = {
  repoUrl: "https://github.com/php/doc-en.git",
  branch: "master",
  sparsePaths: [
    "reference",
    "language",
    "security",
    "features",
    "install",
    "appendices",
  ],
  docsRoot: ".",
  baseUrl: "https://www.php.net/manual/en",
} as const;

export const IETF_RFCS_MANIFEST = {
  // Curated, canonical RFC URLs to avoid open-ended crawling.
  coreUrls: [
    "https://www.rfc-editor.org/rfc/rfc9110.txt", // HTTP Semantics
    "https://www.rfc-editor.org/rfc/rfc9111.txt", // HTTP Caching
    "https://www.rfc-editor.org/rfc/rfc9112.txt", // HTTP/1.1
    "https://www.rfc-editor.org/rfc/rfc9113.txt", // HTTP/2
    "https://www.rfc-editor.org/rfc/rfc9114.txt", // HTTP/3
    "https://www.rfc-editor.org/rfc/rfc3986.txt", // URI Syntax
    "https://www.rfc-editor.org/rfc/rfc7239.txt", // Forwarded Header
  ],
  expandedUrls: [
    "https://www.rfc-editor.org/rfc/rfc6265.txt", // HTTP Cookies
    "https://www.rfc-editor.org/rfc/rfc6454.txt", // Origin
    "https://www.rfc-editor.org/rfc/rfc6797.txt", // HSTS
    "https://www.rfc-editor.org/rfc/rfc9205.txt", // HTTP Prioritization
  ],
} as const;

export const PYTHON_DOCS_MANIFEST = {
  repoUrl: "https://github.com/python/cpython.git",
  branch: "main",
  sparsePaths: [
    "Doc/library",
    "Doc/reference",
  ],
  docsRoot: "Doc",
  baseUrl: "https://docs.python.org/3",
} as const;
