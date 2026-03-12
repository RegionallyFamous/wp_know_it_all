/**
 * Optional Ollama-based query expansion.
 *
 * If OLLAMA_HOST is set (e.g. "http://localhost:11434"), this module uses
 * a local LLM to expand the user's search query with WordPress-specific
 * synonyms and related terms, improving recall for FTS5 search.
 *
 * Falls back to the original query silently if Ollama is unavailable or
 * takes longer than 3 seconds — so this is always safe to use.
 */

import { resolveOllamaHost } from "./ollama-config.js";

const OLLAMA_HOST = resolveOllamaHost();
const OLLAMA_MODEL = process.env["OLLAMA_MODEL"] ?? "qwen2.5-coder:1.5b";
const EXPAND_TIMEOUT_MS = parseInt(process.env["OLLAMA_EXPAND_TIMEOUT_MS"] ?? "250", 10);
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
const expansionCache = new Map<string, { value: string; expiresAt: number }>();

const EXPAND_PROMPT = `You are a WordPress developer search assistant. 
Given a search query, output 3-5 alternative search terms or synonyms a developer might use to find the same information. 
Output ONLY the terms as a comma-separated list, no explanation.

Query: `;

/**
 * Expand a search query using Ollama if configured.
 * Returns the original query if Ollama is not configured or fails.
 */
export async function expandQuery(query: string): Promise<string> {
  if (!OLLAMA_HOST) return query;
  const now = Date.now();
  const cached = expansionCache.get(query);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  if (cached && cached.expiresAt <= now) {
    expansionCache.delete(query);
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EXPAND_TIMEOUT_MS);

    const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: EXPAND_PROMPT + query,
        stream: false,
        options: { temperature: 0.3, num_predict: 64 },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) return query;

    const data = (await res.json()) as { response?: string };
    const expansion = data.response?.trim();

    if (!expansion) return query;

    // Combine original query with expansions for a richer FTS search
    const terms = expansion.split(",").map((t) => t.trim()).filter(Boolean);
    const combined = [query, ...terms.slice(0, 3)].join(" ");
    if (expansionCache.size >= CACHE_MAX_ENTRIES) {
      const firstKey = expansionCache.keys().next().value;
      if (firstKey) expansionCache.delete(firstKey);
    }
    expansionCache.set(query, { value: combined, expiresAt: now + CACHE_TTL_MS });
    return combined;
  } catch {
    // Silently fall back — Ollama is optional
    return query;
  }
}
