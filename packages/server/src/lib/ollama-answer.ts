import type { SearchResult } from "@wp-know-it-all/shared";
import { resolveOllamaHost } from "./ollama-config.js";
import { logDebug, logWarn } from "./logger.js";

export interface OllamaSynthResult {
  answer: string;
  claims: Array<{ text: string; citationDocIds: number[] }>;
  confidence: number;
  abstained: boolean;
  abstainReason?: string;
}

export interface OllamaCritiqueResult {
  accept: boolean;
  reason?: string;
}

const OLLAMA_HOST = resolveOllamaHost();
const OLLAMA_ANSWER_MODEL =
  process.env["OLLAMA_ANSWER_MODEL"]?.trim() ||
  process.env["OLLAMA_MODEL"]?.trim() ||
  "qwen2.5-coder:7b";
const OLLAMA_CRITIC_MODEL =
  process.env["OLLAMA_CRITIC_MODEL"]?.trim() || OLLAMA_ANSWER_MODEL;
const OLLAMA_ANSWER_TIMEOUT_MS = parseInt(
  process.env["OLLAMA_ANSWER_TIMEOUT_MS"] ?? "1800",
  10
);
const OLLAMA_CRITIC_TIMEOUT_MS = parseInt(
  process.env["OLLAMA_CRITIC_TIMEOUT_MS"] ?? "1200",
  10
);

function clampConfidence(value: unknown, fallback = 0.5): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (char === "{") depth++;
    if (char === "}") depth--;
    if (depth === 0) {
      return text.slice(start, i + 1);
    }
  }
  return null;
}

async function callOllamaJson(
  model: string,
  prompt: string,
  timeoutMs: number
): Promise<Record<string, unknown> | null> {
  if (!OLLAMA_HOST) return null;
  const startedAt = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: { temperature: 0.1, num_predict: 512 },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      logWarn("ollama.call.non_ok_response", { model, status: res.status, timeoutMs });
      return null;
    }

    const payload = (await res.json()) as { response?: string };
    const raw = payload.response?.trim();
    if (!raw) {
      logWarn("ollama.call.empty_response", { model, timeoutMs });
      return null;
    }
    const jsonText = extractFirstJsonObject(raw);
    if (!jsonText) {
      logWarn("ollama.call.no_json_object", { model });
      return null;
    }
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    logDebug("ollama.call.success", { model, durationMs: Date.now() - startedAt });
    return parsed;
  } catch (error) {
    logWarn("ollama.call.failed", {
      model,
      timeoutMs,
      durationMs: Date.now() - startedAt,
      error: String(error),
    });
    return null;
  }
}

export function isOllamaAnsweringEnabled(): boolean {
  return Boolean(OLLAMA_HOST);
}

export async function synthesizeWithOllama(
  question: string,
  evidence: SearchResult[]
): Promise<OllamaSynthResult | null> {
  if (!OLLAMA_HOST) return null;
  logDebug("ollama.synth.start", { model: OLLAMA_ANSWER_MODEL, evidenceCount: evidence.length });

  const evidenceBlock = evidence
    .map(
      (item) =>
        `DOC_ID=${item.id}\nTITLE=${item.title}\nSLUG=${item.slug}\nURL=${item.url}\nEXCERPT=${item.excerpt}`
    )
    .join("\n\n---\n\n");

  const prompt = [
    "You are a strict WordPress evidence-grounded answer synthesizer.",
    "Use ONLY evidence docs below. If insufficient, abstain.",
    "Return JSON only with keys: answer, claims, confidence, abstained, abstainReason.",
    'claims must be array of objects: {"text": string, "citationDocIds": number[]}.',
    "Use only DOC_ID values provided in evidence.",
    "",
    `QUESTION: ${question}`,
    "",
    "EVIDENCE:",
    evidenceBlock,
  ].join("\n");

  const parsed = await callOllamaJson(OLLAMA_ANSWER_MODEL, prompt, OLLAMA_ANSWER_TIMEOUT_MS);
  if (!parsed) return null;

  const answer = typeof parsed["answer"] === "string" ? parsed["answer"].trim() : "";
  const abstained = Boolean(parsed["abstained"]);
  const abstainReason =
    typeof parsed["abstainReason"] === "string" ? parsed["abstainReason"] : undefined;
  const confidence = clampConfidence(parsed["confidence"], abstained ? 0.15 : 0.55);

  const rawClaims = Array.isArray(parsed["claims"]) ? parsed["claims"] : [];
  const validDocIds = new Set(evidence.map((e) => e.id));
  const claims = rawClaims
    .map((claim) => {
      if (!claim || typeof claim !== "object") return null;
      const claimRecord = claim as Record<string, unknown>;
      const claimText = claimRecord["text"];
      const claimCitationIds = claimRecord["citationDocIds"];
      const text = typeof claimText === "string" ? claimText.trim() : "";
      const citationDocIds = Array.isArray(claimCitationIds)
        ? claimCitationIds
            .filter((id): id is number => typeof id === "number" && validDocIds.has(id))
            .slice(0, 5)
        : [];
      if (!text || citationDocIds.length === 0) return null;
      return { text, citationDocIds };
    })
    .filter((v): v is { text: string; citationDocIds: number[] } => Boolean(v));

  if (!abstained && (!answer || claims.length === 0)) {
    logWarn("ollama.synth.invalid_payload", { answerLength: answer.length, claimsCount: claims.length });
    return null;
  }

  return {
    answer: answer || "Insufficient evidence to answer reliably.",
    claims,
    confidence,
    abstained,
    abstainReason,
  };
}

export async function critiqueWithOllama(
  question: string,
  answer: string,
  claims: Array<{ text: string; citationDocIds: number[] }>,
  evidence: SearchResult[]
): Promise<OllamaCritiqueResult | null> {
  if (!OLLAMA_HOST) return null;
  logDebug("ollama.critic.start", { model: OLLAMA_CRITIC_MODEL, claimsCount: claims.length });

  const evidenceBlock = evidence
    .map((item) => `DOC_ID=${item.id} TITLE=${item.title} EXCERPT=${item.excerpt}`)
    .join("\n");

  const prompt = [
    "You are a strict answer critic.",
    "Check whether claims appear supported by cited evidence excerpts.",
    "Return JSON only with keys: accept(boolean), reason(string).",
    "",
    `QUESTION: ${question}`,
    `ANSWER: ${answer}`,
    `CLAIMS_JSON: ${JSON.stringify(claims)}`,
    "",
    "EVIDENCE:",
    evidenceBlock,
  ].join("\n");

  const parsed = await callOllamaJson(OLLAMA_CRITIC_MODEL, prompt, OLLAMA_CRITIC_TIMEOUT_MS);
  if (!parsed) return null;

  return {
    accept: Boolean(parsed["accept"]),
    reason: typeof parsed["reason"] === "string" ? parsed["reason"] : undefined,
  };
}
