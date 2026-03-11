export type WordPressGithubTier = "tier1" | "tier2";

export interface WordPressGithubRepoManifest {
  key: string;
  repoUrl: string;
  branch: string;
  sparsePaths: string[];
  docsRoot: string;
  includePathPrefixes: string[];
  excludePathSubstrings: string[];
  baseUrl: string;
  slugPrefix: string;
  category: "code-reference" | "plugin-handbook" | "theme-handbook" | "block-editor" | "common-apis";
  source: "wordpress-github-docs" | "wordpress-github-code";
  tier: WordPressGithubTier;
  defaultMaxDocs: number;
}

export const WORDPRESS_GITHUB_REPOS: WordPressGithubRepoManifest[] = [
  {
    key: "wordpress-develop",
    repoUrl: "https://github.com/WordPress/wordpress-develop.git",
    branch: "trunk",
    sparsePaths: ["README.md", "docs"],
    docsRoot: ".",
    includePathPrefixes: ["README.md", "docs/"],
    excludePathSubstrings: ["/vendor/", "/node_modules/", "/build/", "/tests/"],
    baseUrl: "https://github.com/WordPress/wordpress-develop/blob/trunk",
    slugPrefix: "wp-github/wordpress-develop",
    category: "code-reference",
    source: "wordpress-github-code",
    tier: "tier1",
    defaultMaxDocs: 180,
  },
  {
    key: "playground",
    repoUrl: "https://github.com/WordPress/playground.git",
    branch: "trunk",
    sparsePaths: ["README.md", "docs", "packages/docs"],
    docsRoot: ".",
    includePathPrefixes: ["README.md", "docs/", "packages/docs/"],
    excludePathSubstrings: ["/vendor/", "/node_modules/", "/dist/", "/.next/"],
    baseUrl: "https://github.com/WordPress/playground/blob/trunk",
    slugPrefix: "wp-github/playground",
    category: "common-apis",
    source: "wordpress-github-docs",
    tier: "tier1",
    defaultMaxDocs: 250,
  },
  {
    key: "performance",
    repoUrl: "https://github.com/WordPress/performance.git",
    branch: "trunk",
    sparsePaths: ["README.md", "docs"],
    docsRoot: ".",
    includePathPrefixes: ["README.md", "docs/"],
    excludePathSubstrings: ["/vendor/", "/node_modules/", "/build/", "/tests/"],
    baseUrl: "https://github.com/WordPress/performance/blob/trunk",
    slugPrefix: "wp-github/performance",
    category: "plugin-handbook",
    source: "wordpress-github-docs",
    tier: "tier2",
    defaultMaxDocs: 120,
  },
  {
    key: "openverse",
    repoUrl: "https://github.com/WordPress/openverse.git",
    branch: "main",
    sparsePaths: ["README.md", "docs"],
    docsRoot: ".",
    includePathPrefixes: ["README.md", "docs/"],
    excludePathSubstrings: ["/vendor/", "/node_modules/", "/dist/", "/test/"],
    baseUrl: "https://github.com/WordPress/openverse/blob/main",
    slugPrefix: "wp-github/openverse",
    category: "common-apis",
    source: "wordpress-github-docs",
    tier: "tier2",
    defaultMaxDocs: 160,
  },
];

export const WORDPRESS_GITHUB_REPO_MAP: Record<string, WordPressGithubRepoManifest> = Object.fromEntries(
  WORDPRESS_GITHUB_REPOS.map((repo) => [repo.key, repo])
);
