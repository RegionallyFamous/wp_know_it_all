import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { markdownToPlain } from "../pipeline/html-to-md.js";
import { extractMetadata } from "../pipeline/metadata.js";
import type { InsertableDocument } from "../db/writer.js";
import { PYTHON_DOCS_MANIFEST } from "./adjacent-manifests.js";
import { ensureSparseRepo, slugify } from "./adjacent-utils.js";
import { isHighValueDocument } from "./quality.js";

const PYTHON_ALLOWLIST = new Set<string>([
  "library/urllib.parse.rst",
  "library/urllib.request.rst",
  "library/http.client.rst",
  "library/http.server.rst",
  "library/json.rst",
  "library/pathlib.rst",
  "library/dataclasses.rst",
  "library/typing.rst",
  "library/asyncio.rst",
  "library/logging.rst",
  "reference/expressions.rst",
  "reference/simple_stmts.rst",
]);
const PYTHON_EXPANDED_ALLOWLIST = new Set<string>([
  "library/subprocess.rst",
  "library/os.rst",
  "library/re.rst",
  "library/sqlite3.rst",
  "library/concurrent.futures.rst",
]);
const PYTHON_MAX_FILE_BYTES = 500_000;

function rstToMarkdown(rst: string): string {
  return rst
    .replace(/\r\n/g, "\n")
    .replace(/^\.\.\s+[^\n]*$/gm, "")
    .replace(/^\s*:[a-zA-Z0-9_-]+:\s*[^\n]*$/gm, "")
    .replace(/``([^`]+)``/g, "`$1`")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function derivePythonTitle(markdown: string, fallbackName: string): string {
  const lines = markdown.split("\n");
  for (let i = 0; i < Math.min(lines.length - 1, 120); i++) {
    const current = lines[i]?.trim() ?? "";
    const next = lines[i + 1]?.trim() ?? "";
    if (!current) continue;
    if (/^[=\-~^`:#]{3,}$/.test(next)) return current;
    if (current.startsWith("# ")) return current.slice(2).trim();
  }
  return fallbackName
    .replace(/\.rst$/i, "")
    .replace(/[._-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function pythonDocUrl(relPathFromDocRoot: string): string {
  const noExt = relPathFromDocRoot.replace(/\\/g, "/").replace(/\.rst$/i, ".html");
  return `${PYTHON_DOCS_MANIFEST.baseUrl}/${noExt}`;
}

function sectionFromPath(relPathFromDocRoot: string): string {
  const first = relPathFromDocRoot.replace(/\\/g, "/").split("/")[0];
  return first || "doc";
}

export async function ingestPythonDocs(cloneDir?: string): Promise<InsertableDocument[]> {
  const bundleMode = process.env["PYTHON_DOCS_BUNDLE"] === "expanded" ? "expanded" : "core";
  const allowlist =
    bundleMode === "expanded"
      ? new Set<string>([...PYTHON_ALLOWLIST, ...PYTHON_EXPANDED_ALLOWLIST])
      : PYTHON_ALLOWLIST;
  const repoDir = cloneDir ?? join(tmpdir(), "python-docs-repo");
  await ensureSparseRepo({
    repoDir,
    repoUrl: PYTHON_DOCS_MANIFEST.repoUrl,
    branch: PYTHON_DOCS_MANIFEST.branch,
    sparsePaths: [...PYTHON_DOCS_MANIFEST.sparsePaths],
    label: "python",
  });

  const docsRoot = join(repoDir, PYTHON_DOCS_MANIFEST.docsRoot);
  if (!existsSync(docsRoot)) {
    console.warn("[python] docs root not found");
    return [];
  }

  const documents: InsertableDocument[] = [];
  const seenUrls = new Set<string>();
  const seenSlugs = new Set<string>();
  for (const relPath of allowlist) {
    const filePath = join(docsRoot, relPath);
    if (!existsSync(filePath)) continue;
    const rst = readFileSync(filePath, "utf-8");
    if (!rst.trim()) continue;
    if (Buffer.byteLength(rst, "utf8") > PYTHON_MAX_FILE_BYTES) continue;

    const markdown = rstToMarkdown(rst);
    if (!markdown) continue;

    const fallbackName = relPath.split("/").pop() ?? "python-doc";
    const title = derivePythonTitle(markdown, fallbackName);
    const plain = markdownToPlain(markdown);
    const meta = extractMetadata(markdown, title);
    const slug = `python/${slugify(relPath.replace(/\.rst$/i, ""))}`;
    const url = pythonDocUrl(relPath);

    const doc: InsertableDocument = {
      url,
      slug,
      title,
      doc_type: "guide",
      source: "python-docs",
      category: "python-runtime",
      signature: meta.signature,
      since_version: meta.since_version,
      parent_id: null,
      content_markdown: markdown,
      content_plain: plain,
      functions_mentioned: meta.functions_mentioned.length > 0 ? meta.functions_mentioned : null,
      hooks_mentioned: meta.hooks_mentioned.length > 0 ? meta.hooks_mentioned : null,
      metadata: {
        ecosystem: "python",
        section: sectionFromPath(relPath),
        repo: PYTHON_DOCS_MANIFEST.repoUrl,
        branch: PYTHON_DOCS_MANIFEST.branch,
        bundle: bundleMode,
        path: relPath,
      },
    };

    if (isHighValueDocument(doc, seenUrls, seenSlugs)) {
      documents.push(doc);
    }
  }

  console.log(`[python] ${documents.length} docs processed (bundle=${bundleMode})`);
  return documents;
}
