export type AdjacentSourceType = "php-manual" | "nodejs-docs" | "mdn-webdocs";

export const ADJACENT_SOURCE_ORDER: AdjacentSourceType[] = [
  "php-manual",
  "nodejs-docs",
  "mdn-webdocs",
];

export const NODEJS_DOCS_MANIFEST = {
  repoUrl: "https://github.com/nodejs/node.git",
  branch: "main",
  sparsePaths: ["doc/api"],
  docsRoot: "doc/api",
  baseUrl: "https://nodejs.org/api",
} as const;

export const MDN_DOCS_MANIFEST = {
  repoUrl: "https://github.com/mdn/content.git",
  branch: "main",
  sparsePaths: [
    "files/en-us/web/http",
    "files/en-us/web/api/fetch_api",
    "files/en-us/web/security",
    "files/en-us/web/javascript/reference/global_objects/url",
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
