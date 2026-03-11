import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { simpleGit } from "simple-git";
import { markdownToPlain } from "../pipeline/html-to-md.js";
import { extractMetadata } from "../pipeline/metadata.js";
import type { InsertableDocument } from "../db/writer.js";
import {
  WORDPRESS_GITHUB_REPO_MAP,
  type WordPressGithubRepoManifest,
} from "./wordpress-github-manifest.js";
import { ensureSparseRepo, walkFiles } from "./adjacent-utils.js";

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx", ".txt"]);
const DEFAULT_MAX_FILE_BYTES = 220_000;

function filePathToSlug(filePath: string, docsRoot: string, slugPrefix: string): string {
  const rel = relative(docsRoot, filePath).replace(/\\/g, "/");
  const cleaned = rel
    .replace(/\.(md|mdx|txt)$/i, "")
    .replace(/\/index$/i, "")
    .replace(/[^a-z0-9/-]/gi, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `${slugPrefix}/${cleaned || "readme"}`;
}

function filePathToUrl(filePath: string, docsRoot: string, baseUrl: string): string {
  const rel = relative(docsRoot, filePath).replace(/\\/g, "/");
  return `${baseUrl}/${rel}`;
}

function extractTitle(markdown: string, filename: string): string {
  const h1 = /^#\s+(.+)$/m.exec(markdown);
  if (h1?.[1]) return h1[1].trim();
  return basename(filename, extname(filename))
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function includesPrefix(pathRel: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => pathRel === prefix || pathRel.startsWith(prefix));
}

function includesBlockedSubstring(pathRel: string, blocked: string[]): boolean {
  return blocked.some((substr) => pathRel.includes(substr));
}

function* iterCandidateFiles(
  docsRoot: string,
  manifest: WordPressGithubRepoManifest
): Generator<string> {
  const seen = new Set<string>();
  for (const prefix of manifest.includePathPrefixes) {
    const fullPath = join(docsRoot, prefix);
    if (!existsSync(fullPath)) continue;
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      for (const file of walkFiles(fullPath, MARKDOWN_EXTENSIONS)) {
        if (seen.has(file)) continue;
        seen.add(file);
        yield file;
      }
      continue;
    }
    if (!MARKDOWN_EXTENSIONS.has(extname(fullPath).toLowerCase())) continue;
    if (seen.has(fullPath)) continue;
    seen.add(fullPath);
    yield fullPath;
  }
}

export async function ingestWordPressGithubRepo(opts: {
  repoKey: string;
  cloneDir?: string;
  maxDocs?: number;
  maxFileBytes?: number;
}): Promise<InsertableDocument[]> {
  const manifest = WORDPRESS_GITHUB_REPO_MAP[opts.repoKey];
  if (!manifest) {
    throw new Error(`Unknown WordPress GitHub repo key: ${opts.repoKey}`);
  }

  const repoDir =
    opts.cloneDir ??
    join(tmpdir(), `wp-know-it-all-github-${manifest.key.replace(/[^a-z0-9-]/gi, "-")}`);
  await ensureSparseRepo({
    repoDir,
    repoUrl: manifest.repoUrl,
    branch: manifest.branch,
    sparsePaths: manifest.sparsePaths,
    label: `wp-github:${manifest.key}`,
  });

  const docsRoot = join(repoDir, manifest.docsRoot);
  if (!existsSync(docsRoot)) {
    console.warn(`[wp-github:${manifest.key}] docs root missing: ${manifest.docsRoot}`);
    return [];
  }

  const docs: InsertableDocument[] = [];
  const maxDocs = opts.maxDocs ?? manifest.defaultMaxDocs;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const seenUrls = new Set<string>();

  for (const filePath of iterCandidateFiles(docsRoot, manifest)) {
    const relPath = relative(docsRoot, filePath).replace(/\\/g, "/");
    const relPathWithSlash = relPath.startsWith("/") ? relPath : `/${relPath}`;
    const normalizedRel = relPathWithSlash.replace(/^\//, "");

    if (!includesPrefix(normalizedRel, manifest.includePathPrefixes)) continue;
    if (includesBlockedSubstring(relPathWithSlash, manifest.excludePathSubstrings)) continue;
    if (docs.length >= maxDocs) break;

    const size = statSync(filePath).size;
    if (size > maxFileBytes) continue;

    const raw = readFileSync(filePath, "utf8");
    if (!raw.trim()) continue;

    const title = extractTitle(raw, filePath);
    const url = filePathToUrl(filePath, docsRoot, manifest.baseUrl);
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);

    const plain = markdownToPlain(raw);
    if (!plain.trim()) continue;
    const meta = extractMetadata(raw, title);

    docs.push({
      url,
      slug: filePathToSlug(filePath, docsRoot, manifest.slugPrefix),
      title,
      doc_type: "guide",
      source: manifest.source,
      category: manifest.category,
      signature: meta.signature,
      since_version: meta.since_version,
      parent_id: null,
      content_markdown: raw,
      content_plain: plain,
      functions_mentioned: meta.functions_mentioned.length > 0 ? meta.functions_mentioned : null,
      hooks_mentioned: meta.hooks_mentioned.length > 0 ? meta.hooks_mentioned : null,
      metadata: {
        repo: manifest.repoUrl,
        branch: manifest.branch,
        path: normalizedRel,
      },
    });
  }

  const sha = await simpleGit(repoDir).revparse(["--short", "HEAD"]);
  const commit = sha.trim();
  if (commit.length > 0) {
    docs.forEach((doc) => {
      doc.metadata = {
        ...(doc.metadata ?? {}),
        commit_sha: commit,
      };
    });
  }

  console.log(`[wp-github:${manifest.key}] ${docs.length} docs processed`);
  return docs;
}

export function selectWordPressGithubRepos(opts?: {
  tier?: "tier1" | "tier2";
  repoKeys?: string[];
}): WordPressGithubRepoManifest[] {
  const tier = opts?.tier ?? "tier1";
  const selectedByTier = Object.values(WORDPRESS_GITHUB_REPO_MAP).filter((repo) =>
    tier === "tier2" ? true : repo.tier === "tier1"
  );
  if (!opts?.repoKeys || opts.repoKeys.length === 0) return selectedByTier;
  const selectedKeys = new Set(opts.repoKeys);
  return selectedByTier.filter((repo) => selectedKeys.has(repo.key));
}
