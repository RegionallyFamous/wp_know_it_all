import { existsSync, lstatSync, readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { simpleGit } from "simple-git";

function normalizeGitRemote(url: string): string {
  return url.trim().replace(/\.git$/i, "").replace(/\/+$/g, "");
}

export function* walkFiles(dir: string, exts: ReadonlySet<string>): Generator<string> {
  const skipDirs = new Set([
    ".git",
    ".github",
    "node_modules",
    "vendor",
    "dist",
    "build",
    ".next",
  ]);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    console.warn(`[walkFiles] Unable to read directory ${dir}: ${String(err)}`);
    return;
  }

  for (const entry of entries) {
    if (skipDirs.has(entry)) continue;
    const full = join(dir, entry);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(full);
    } catch (err) {
      console.warn(`[walkFiles] Unable to stat ${full}: ${String(err)}`);
      continue;
    }
    // Avoid following symlinks into unexpected paths.
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      yield* walkFiles(full, exts);
      continue;
    }
    if (exts.has(extname(full).toLowerCase())) {
      yield full;
    }
  }
}

export async function ensureSparseRepo(opts: {
  repoDir: string;
  repoUrl: string;
  branch: string;
  sparsePaths: string[];
  label: string;
}): Promise<void> {
  const { repoDir, repoUrl, branch, sparsePaths, label } = opts;
  const normalizedSparsePaths = [...new Set(sparsePaths.map((p) => p.trim()).filter((p) => p.length > 0))];
  if (normalizedSparsePaths.length === 0) {
    throw new Error(`[${label}] sparsePaths must contain at least one path`);
  }

  const applySparsePaths = async (): Promise<void> => {
    await simpleGit(repoDir).raw(["sparse-checkout", "set", ...normalizedSparsePaths]);
  };
  if (!existsSync(repoDir)) {
    console.log(`[${label}] Cloning ${repoUrl} (sparse checkout)...`);
    const git = simpleGit();
    await git.clone(repoUrl, repoDir, [
      "--depth=1",
      "--filter=blob:none",
      "--sparse",
      "--single-branch",
      `--branch=${branch}`,
    ]);
    await applySparsePaths();
    return;
  }

  console.log(`[${label}] Updating existing clone...`);
  const repoGit = simpleGit(repoDir);
  const originUrl = (await repoGit.raw(["remote", "get-url", "origin"])).trim();
  if (normalizeGitRemote(originUrl) !== normalizeGitRemote(repoUrl)) {
    throw new Error(
      `[${label}] Existing repo remote mismatch: expected "${repoUrl}", got "${originUrl}"`
    );
  }
  await applySparsePaths();
  await repoGit.pull("origin", branch, ["--depth=1"]);
}

export function stripMarkdownFrontMatter(markdown: string): {
  body: string;
  frontMatter: Record<string, string>;
} {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match?.[0]) {
    return { body: markdown, frontMatter: {} };
  }
  const raw = match[1] ?? "";
  const frontMatter: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line
      .slice(idx + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    if (key) frontMatter[key] = value;
  }
  return { body: markdown.slice(match[0].length), frontMatter };
}

export function titleFromMarkdown(markdown: string, fallbackFilename: string): string {
  const h1 = /^#\s+(.+)$/m.exec(markdown);
  if (h1?.[1]) return h1[1].trim();
  return basename(fallbackFilename, extname(fallbackFilename))
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function decodeCommonEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ");
}
