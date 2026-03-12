const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized === "0.0.0.0"
  );
}

export function resolveOllamaHost(): string | undefined {
  if (process.env["OLLAMA_ENABLED"] === "0") return undefined;
  const raw = process.env["OLLAMA_HOST"]?.trim() || DEFAULT_OLLAMA_HOST;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid OLLAMA_HOST URL: "${raw}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`OLLAMA_HOST must use http/https, got "${parsed.protocol}"`);
  }
  const localOnly = process.env["OLLAMA_LOCAL_ONLY"] !== "0";
  if (localOnly && !isLoopbackHost(parsed.hostname)) {
    throw new Error(
      `OLLAMA_LOCAL_ONLY is enabled and OLLAMA_HOST is non-local ("${parsed.hostname}").`
    );
  }
  return parsed.origin;
}

export function isOllamaConfigured(): boolean {
  return Boolean(resolveOllamaHost());
}
