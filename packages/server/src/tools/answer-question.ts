import { z } from "zod";
import type { DocumentRow, SearchResult } from "@wp-know-it-all/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { buildQueries } from "../db/queries.js";
import { routeQuery } from "../lib/query-router.js";
import { rerankCandidates, type RetrievalCandidate } from "../lib/rerank.js";
import { expandQuery } from "../lib/query-expansion.js";
import { GroundedAnswerSchema, type GroundedAnswer } from "../lib/answer-schema.js";
import { verifyGroundedAnswer } from "../lib/answer-verifier.js";
import { logQualityEvent } from "../lib/quality-metrics.js";
import { applyWranglerPersona } from "../lib/persona.js";
import {
  critiqueWithOllama,
  isOllamaAnsweringEnabled,
  synthesizeWithOllama,
} from "../lib/ollama-answer.js";

export const answerQuestionInputSchema = {
  question: z
    .string()
    .min(3)
    .max(1500)
    .describe("Natural language question about WordPress behavior, APIs, hooks, or implementation."),
  category: z
    .enum([
      "code-reference",
      "plugin-handbook",
      "theme-handbook",
      "block-editor",
      "rest-api",
      "common-apis",
      "coding-standards",
      "admin",
      "scf",
      "php-core",
      "nodejs-runtime",
      "web-platform",
      "software-engineering",
      "python-runtime",
    ])
    .optional()
    .describe("Optional category filter to focus retrieval."),
  doc_type: z
    .enum(["function", "hook", "class", "method", "guide", "example"])
    .optional()
    .describe("Optional document type filter."),
  top_k: z
    .number()
    .int()
    .min(3)
    .max(12)
    .default(6)
    .describe("Number of evidence documents to include."),
};

function documentToSearchResult(row: DocumentRow): SearchResult {
  const excerptSource = row.content_plain?.trim() || row.content_markdown?.trim() || "";
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    doc_type: row.doc_type,
    source: row.source,
    category: row.category,
    slug: row.slug,
    excerpt:
      excerptSource.length > 220 ? `${excerptSource.slice(0, 220).trimEnd()}…` : excerptSource,
    score: 0,
  };
}

function buildEvidenceMap(evidence: SearchResult[]): Map<number, SearchResult> {
  return new Map(evidence.map((item) => [item.id, item]));
}

function decomposeConceptualQuery(question: string): string[] {
  const normalized = question
    .toLowerCase()
    .replace(/[^a-z0-9_\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return [];

  const stop = new Set([
    "how",
    "what",
    "when",
    "where",
    "why",
    "which",
    "can",
    "could",
    "would",
    "should",
    "the",
    "a",
    "an",
    "in",
    "on",
    "for",
    "to",
    "with",
    "and",
    "or",
    "of",
    "is",
    "are",
  ]);
  const tokens = normalized
    .split(" ")
    .filter((token) => token.length > 2 && !stop.has(token));

  const topTerms = tokens.slice(0, 6);
  const chunks: string[] = [];
  for (let i = 0; i < topTerms.length; i += 2) {
    const segment = topTerms.slice(i, i + 2).join(" ");
    if (segment) chunks.push(segment);
  }
  return Array.from(new Set(chunks)).slice(0, 3);
}

function tokenizeQuestion(question: string): string[] {
  const stop = new Set([
    "how",
    "what",
    "when",
    "where",
    "why",
    "which",
    "can",
    "could",
    "would",
    "should",
    "the",
    "a",
    "an",
    "in",
    "on",
    "for",
    "to",
    "with",
    "and",
    "or",
    "of",
    "is",
    "are",
    "best",
    "way",
  ]);
  return question
    .toLowerCase()
    .replace(/[^a-z0-9_\s]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !stop.has(token));
}

function evidenceKeywordCoverage(question: string, evidence: SearchResult[]): number {
  const tokens = tokenizeQuestion(question).filter((token) => token.length > 4);
  if (tokens.length === 0) return 1;
  const haystack = evidence
    .map((item) => `${item.title} ${item.slug} ${item.excerpt}`.toLowerCase())
    .join(" ");
  const matched = tokens.filter((token) => haystack.includes(token)).length;
  return matched / tokens.length;
}

function selectClaimEvidence(question: string, evidence: SearchResult[], limit: number): SearchResult[] {
  const tokens = tokenizeQuestion(question);
  if (tokens.length === 0) return evidence.slice(0, limit);
  const scored = evidence.map((item) => {
    const hay = `${item.title} ${item.slug} ${item.excerpt}`.toLowerCase();
    const hits = tokens.filter((token) => hay.includes(token)).length;
    return { item, score: hits / tokens.length };
  });
  scored.sort((a, b) => b.score - a.score);
  const filtered = scored.filter((row) => row.score > 0).map((row) => row.item);
  return (filtered.length > 0 ? filtered : evidence).slice(0, limit);
}

function inferAssumptions(question: string, evidence: SearchResult[]): string[] {
  const assumptions: string[] = [];
  const lowerQ = question.toLowerCase();
  if (!lowerQ.includes("wordpress")) {
    assumptions.push("Assuming WordPress context unless otherwise specified.");
  }
  const uniqueSources = new Set(evidence.map((e) => e.source));
  if (uniqueSources.size > 2) {
    assumptions.push("Answer blends evidence from multiple ecosystems; verify environment-specific behavior.");
  }
  const uniqueCategories = new Set(evidence.map((e) => e.category).filter(Boolean));
  if (uniqueCategories.size > 2) {
    assumptions.push("Relevant behavior spans multiple documentation categories and may vary by use case.");
  }
  return assumptions;
}

function formatReasoningSteps(
  routeIntent: ReturnType<typeof routeQuery>["intent"],
  evidenceCount: number,
  subqueries: string[]
): string[] {
  const steps = [
    `Classified question intent as ${routeIntent}.`,
    "Retrieved primary evidence candidates via BM25 and exact matching paths.",
  ];
  if (subqueries.length > 0) {
    steps.push(`Expanded retrieval using ${subqueries.length} decomposition subqueries.`);
  }
  steps.push(`Reranked and deduplicated evidence down to ${evidenceCount} high-priority documents.`);
  return steps;
}

function buildCitationsFromEvidence(evidence: SearchResult[]): GroundedAnswer["citations"] {
  return evidence.map((item) => ({
    docId: item.id,
    slug: item.slug,
    url: item.url,
    title: item.title,
    evidenceSnippet: item.excerpt,
    startOffset: 0,
    endOffset: Math.max(0, item.excerpt.length),
    supportScore: 0.7,
  }));
}

function pickCitationsForClaims(
  claims: Array<{ citationDocIds: number[] }>,
  evidenceById: Map<number, SearchResult>
): GroundedAnswer["citations"] {
  const docIds = Array.from(
    new Set(
      claims
        .flatMap((claim) => claim.citationDocIds)
        .filter((docId) => evidenceById.has(docId))
    )
  );
  return docIds
    .map((docId) => evidenceById.get(docId))
    .filter((item): item is SearchResult => Boolean(item))
    .map((item) => ({
      docId: item.id,
      slug: item.slug,
      url: item.url,
      title: item.title,
      evidenceSnippet: item.excerpt,
      startOffset: 0,
      endOffset: Math.max(0, item.excerpt.length),
      supportScore: 0.7,
    }));
}

function calibratePreVerificationConfidence(
  evidence: SearchResult[],
  routeIntent: ReturnType<typeof routeQuery>["intent"],
  assumptions: string[]
): number {
  const uniqueSources = new Set(evidence.map((e) => e.source)).size;
  const diversityPenalty = uniqueSources > 3 ? 0.1 : 0;
  const intentBoost = routeIntent === "exact_symbol" ? 0.1 : 0;
  const assumptionPenalty = assumptions.length > 1 ? 0.08 : 0;
  const evidenceBoost = Math.min(0.2, evidence.length * 0.03);
  const raw = 0.5 + intentBoost + evidenceBoost - diversityPenalty - assumptionPenalty;
  return Math.max(0.1, Math.min(0.95, raw));
}

function buildAbstainedAnswer(question: string, reason: string): GroundedAnswer {
  return {
    question,
    answer:
      "I do not have enough high-confidence evidence in the indexed corpus to answer this safely. " +
      "Try refining the question or removing restrictive filters.",
    claims: [],
    citations: [],
    reasoningSteps: ["Unable to produce grounded claims from available evidence."],
    confidence: 0.1,
    abstained: true,
    abstainReason: reason,
  };
}

function buildDeterministicAnswer(
  question: string,
  evidence: SearchResult[],
  routeIntent: ReturnType<typeof routeQuery>["intent"],
  decompositionQueries: string[]
): GroundedAnswer {
  const evidenceById = buildEvidenceMap(evidence);
  const assumptions = inferAssumptions(question, evidence);
  const reasoningSteps = formatReasoningSteps(routeIntent, evidence.length, decompositionQueries);

  const claimEvidence = selectClaimEvidence(question, evidence, Math.min(3, evidence.length));
  const claims = claimEvidence.map((item) => ({
    text: `${item.title}: ${item.excerpt || "Relevant documentation found for this question."}`,
    citationDocIds: [item.id],
    supportScore: 0.7,
  }));
  const citations = pickCitationsForClaims(claims, evidenceById);

  const confidence = calibratePreVerificationConfidence(evidence, routeIntent, assumptions);

  return GroundedAnswerSchema.parse({
    question,
    answer: [
      `Based on the indexed WordPress documentation, these sources most directly answer your question:`,
      ...evidence.map(
        (item, idx) =>
          `${idx + 1}. ${item.title} (${item.doc_type}) — ${item.url}\n   ${item.excerpt}`
      ),
      "",
      "Use `get_wordpress_doc` with cited IDs/slugs for full context before production changes.",
    ].join("\n"),
    claims,
    citations,
    reasoningSteps,
    assumptions,
    confidence,
    abstained: false,
  });
}

export async function buildGroundedAnswer(
  queries: ReturnType<typeof buildQueries>,
  params: {
    question: string;
    category?: string;
    doc_type?: string;
    top_k: number;
  }
): Promise<{
  answer: GroundedAnswer;
  evidence: SearchResult[];
  synthesisEngine: "deterministic" | "ollama";
  criticUsed: boolean;
  criticAccepted: boolean;
  routeIntent: "exact_symbol" | "conceptual";
  retrievalLatencyMs: number;
  rerankLatencyMs: number;
  answerLatencyMs: number;
}> {
  const startedAt = Date.now();
  const route = routeQuery(params.question);
  const candidates: RetrievalCandidate[] = [];
  let hasExactMatch = false;
  const pushCandidates = (results: SearchResult[], source: RetrievalCandidate["source"]): void => {
    results.forEach((result, rank) => {
      candidates.push({ result, source, rank });
    });
  };

  const baseResults = queries.search({
    query: route.normalizedQuery,
    category: params.category,
    doc_type: params.doc_type,
    limit: 20,
  });
  pushCandidates(baseResults, "bm25");

  const decompositionQueries =
    route.intent === "conceptual" ? decomposeConceptualQuery(route.normalizedQuery) : [];
  for (const expanded of decompositionQueries) {
    const decomposedResults = queries.search({
      query: expanded,
      category: params.category,
      doc_type: params.doc_type,
      limit: 10,
    });
    pushCandidates(decomposedResults, "bm25");
  }

  if (route.intent === "exact_symbol") {
    const exact = queries.lookupExact(route.normalizedQuery);
    if (exact) {
      hasExactMatch = true;
      pushCandidates([documentToSearchResult(exact)], "exact");
      const related = queries.getRelated(exact.slug, exact.id).slice(0, 5).map(documentToSearchResult);
      pushCandidates(related, "related");
    }
  } else {
    for (const seed of baseResults.slice(0, 3)) {
      const related = queries.getRelated(seed.slug, seed.id).slice(0, 3).map(documentToSearchResult);
      pushCandidates(related, "related");
    }
  }

  if (baseResults.length < Math.max(3, Math.floor(params.top_k / 2))) {
    const expandedQuery = await expandQuery(route.normalizedQuery);
    if (expandedQuery !== route.normalizedQuery) {
      const expandedResults = queries.search({
        query: expandedQuery,
        category: params.category,
        doc_type: params.doc_type,
        limit: 20,
      });
      pushCandidates(expandedResults, "bm25");
    }
  }

  const retrievalLatencyMs = Date.now() - startedAt;
  const rerankStart = Date.now();
  const evidence = rerankCandidates(candidates, route.normalizedQuery, route.intent).slice(
    0,
    params.top_k
  );
  const rerankLatencyMs = Date.now() - rerankStart;
  const answerStart = Date.now();

  if (evidence.length === 0) {
    return {
      answer: buildAbstainedAnswer(params.question, "No relevant evidence documents were retrieved."),
      evidence,
      synthesisEngine: "deterministic",
      criticUsed: false,
      criticAccepted: false,
      routeIntent: route.intent,
      retrievalLatencyMs,
      rerankLatencyMs,
      answerLatencyMs: Date.now() - answerStart,
    };
  }
  if (route.intent === "conceptual") {
    const keywordCoverage = evidenceKeywordCoverage(params.question, evidence);
    if (keywordCoverage < 0.25) {
      return {
        answer: buildAbstainedAnswer(
          params.question,
          "Evidence coverage for key terms is too weak; likely out-of-corpus question."
        ),
        evidence,
        synthesisEngine: "deterministic",
        criticUsed: false,
        criticAccepted: false,
        routeIntent: route.intent,
        retrievalLatencyMs,
        rerankLatencyMs,
        answerLatencyMs: Date.now() - answerStart,
      };
    }
  }
  if (route.intent === "exact_symbol" && !hasExactMatch) {
    const exactSlugMatch = evidence.some(
      (item) => item.slug.toLowerCase() === route.normalizedQuery.toLowerCase()
    );
    const exactTitleMatch = evidence.some(
      (item) => item.title.toLowerCase() === route.normalizedQuery.toLowerCase()
    );
    if (!exactSlugMatch && !exactTitleMatch) {
      return {
        answer: buildAbstainedAnswer(
          params.question,
          `Exact symbol "${route.normalizedQuery}" was not found in indexed docs.`
        ),
        evidence,
        synthesisEngine: "deterministic",
        criticUsed: false,
        criticAccepted: false,
        routeIntent: route.intent,
        retrievalLatencyMs,
        rerankLatencyMs,
        answerLatencyMs: Date.now() - answerStart,
      };
    }
  }

  let answer = buildDeterministicAnswer(
    params.question,
    evidence,
    route.intent,
    decompositionQueries
  );
  let synthesisEngine: "deterministic" | "ollama" = "deterministic";
  let criticUsed = false;
  let criticAccepted = false;
  const evidenceById = buildEvidenceMap(evidence);

  if (isOllamaAnsweringEnabled()) {
    const ollamaSynth = await synthesizeWithOllama(params.question, evidence);
    if (ollamaSynth) {
      const citations = buildCitationsFromEvidence(evidence);
      const parsedClaims = ollamaSynth.claims.map((claim) => ({
        ...claim,
        supportScore:
          claim.citationDocIds
            .map((id) => evidenceById.get(id)?.excerpt.length ?? 0)
            .filter((v) => v > 0).length > 0
            ? 0.72
            : 0.5,
      }));
      const filteredCitations = pickCitationsForClaims(parsedClaims, evidenceById);
      answer = GroundedAnswerSchema.parse({
        question: params.question,
        answer: ollamaSynth.answer,
        claims: parsedClaims,
        citations: filteredCitations.length > 0 ? filteredCitations : citations,
        reasoningSteps: formatReasoningSteps(route.intent, evidence.length, decompositionQueries),
        assumptions: inferAssumptions(params.question, evidence),
        confidence: ollamaSynth.confidence,
        abstained: ollamaSynth.abstained,
        abstainReason: ollamaSynth.abstainReason,
      });
      synthesisEngine = "ollama";

      const critique = await critiqueWithOllama(
        params.question,
        answer.answer,
        answer.claims,
        evidence
      );
      if (critique) {
        criticUsed = true;
        criticAccepted = critique.accept;
        if (!critique.accept && !answer.abstained) {
          answer = buildAbstainedAnswer(
            params.question,
            `Critic rejected synthesized answer: ${critique.reason ?? "insufficient evidence support"}`
          );
        }
      }
    }
  }

  return {
    answer,
    evidence,
    synthesisEngine,
    criticUsed,
    criticAccepted,
    routeIntent: route.intent,
    retrievalLatencyMs,
    rerankLatencyMs,
    answerLatencyMs: Date.now() - answerStart,
  };
}

export function formatGroundedAnswerOutput(
  answer: GroundedAnswer,
  verification: ReturnType<typeof verifyGroundedAnswer>
): string {
  const reasoningLines =
    answer.reasoningSteps && answer.reasoningSteps.length > 0
      ? answer.reasoningSteps.map((step, idx) => `${idx + 1}. ${step}`).join("\n")
      : "- Not provided";
  const assumptionLines =
    answer.assumptions && answer.assumptions.length > 0
      ? answer.assumptions.map((item) => `- ${item}`).join("\n")
      : "- None";
  const citationLines =
    answer.citations.length > 0
      ? answer.citations
          .map(
            (c) =>
              `- [${c.docId}] ${c.title} (\`${c.slug}\`) — ${c.url}${
                c.evidenceSnippet ? `\n  Evidence: "${c.evidenceSnippet}"` : ""
              }`
          )
          .join("\n")
      : "- None";

  const claimLines =
    answer.claims.length > 0
      ? answer.claims
          .map((claim, idx) => `${idx + 1}. ${claim.text} [${claim.citationDocIds.join(", ")}]`)
          .join("\n")
      : "- None";

  const warnings =
    verification.reasons.length > 0
      ? `\n## Verification Warnings\n${verification.reasons.map((r) => `- ${r}`).join("\n")}\n`
      : "";

  const body = [
    "## Grounded Answer",
    answer.answer,
    "",
    `Confidence: ${answer.confidence.toFixed(2)} | Abstained: ${answer.abstained ? "yes" : "no"} | Avg Support: ${verification.averageSupportScore.toFixed(2)}`,
    "",
    "## Reasoning Steps",
    reasoningLines,
    "",
    "## Assumptions",
    assumptionLines,
    "",
    "## Claims",
    claimLines,
    "",
    "## Citations",
    citationLines,
    warnings,
  ].join("\n");
  return applyWranglerPersona(body);
}

export function registerAnswerQuestionTool(
  server: McpServer,
  queries: ReturnType<typeof buildQueries>
): void {
  server.registerTool(
    "answer_wordpress_question",
    {
      description:
        "Answer a WordPress question with grounded evidence from the WordPress-first corpus (plus adjacent PHP/Node/Web references). Returns structured claims and citations, and abstains when confidence is low.",
      inputSchema: answerQuestionInputSchema,
    },
    async ({ question, category, doc_type, top_k }) => {
      const result = await buildGroundedAnswer(queries, { question, category, doc_type, top_k });
      const verification = verifyGroundedAnswer(result.answer, queries);

      const finalAnswerBase =
        verification.ok || result.answer.abstained
          ? result.answer
          : buildAbstainedAnswer(
              question,
              `Verification failed: ${verification.reasons.join(" | ")}`
            );
      const calibratedConfidence = finalAnswerBase.abstained
        ? Math.min(0.35, finalAnswerBase.confidence)
        : Math.max(
            0.15,
            Math.min(
              0.98,
              0.35 +
                verification.averageSupportScore * 0.35 +
                verification.citationCoverage * 0.2 +
                (1 - verification.unsupportedClaimRate) * 0.1 +
                (result.routeIntent === "exact_symbol" ? 0.05 : 0)
            )
          );
      const finalAnswer: GroundedAnswer = {
        ...finalAnswerBase,
        confidence: calibratedConfidence,
      };

      logQualityEvent({
        tool: "answer_wordpress_question",
        question,
        synthesisEngine: result.synthesisEngine,
        criticUsed: result.criticUsed,
        criticAccepted: result.criticAccepted,
        retrievalLatencyMs: result.retrievalLatencyMs,
        rerankLatencyMs: result.rerankLatencyMs,
        answerLatencyMs: result.answerLatencyMs,
        evidenceCount: result.evidence.length,
        citationCoverage: verification.citationCoverage,
        unsupportedClaimRate: verification.unsupportedClaimRate,
        averageSupportScore: verification.averageSupportScore,
        abstained: finalAnswer.abstained,
        abstainReason: finalAnswer.abstainReason,
        confidence: finalAnswer.confidence,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: formatGroundedAnswerOutput(finalAnswer, verification),
          },
          {
            type: "text" as const,
            text: `\n\n## Structured JSON\n\`\`\`json\n${JSON.stringify(finalAnswer, null, 2)}\n\`\`\``,
          },
        ],
      };
    }
  );
}
