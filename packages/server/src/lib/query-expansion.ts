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

const OLLAMA_HOST = process.env["OLLAMA_HOST"];
const OLLAMA_MODEL = process.env["OLLAMA_MODEL"] ?? "qwen2.5-coder:1.5b";
const EXPAND_TIMEOUT_MS = 3000;

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
    return combined;
  } catch {
    // Silently fall back — Ollama is optional
    return query;
  }
}
