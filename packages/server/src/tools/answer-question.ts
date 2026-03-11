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

function buildAbstainedAnswer(question: string, reason: string): GroundedAnswer {
  return {
    question,
    answer:
      "I do not have enough high-confidence evidence in the indexed corpus to answer this safely. " +
      "Try refining the question or removing restrictive filters.",
    claims: [],
    citations: [],
    confidence: 0.1,
    abstained: true,
    abstainReason: reason,
  };
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
  retrievalLatencyMs: number;
  rerankLatencyMs: number;
  answerLatencyMs: number;
}> {
  const startedAt = Date.now();
  const route = routeQuery(params.question);
  const candidates: RetrievalCandidate[] = [];
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

  if (route.intent === "exact_symbol") {
    const exact = queries.lookupExact(route.normalizedQuery);
    if (exact) {
      pushCandidates([documentToSearchResult(exact)], "exact");
      const related = queries.getRelated(exact.slug, exact.id).slice(0, 5).map(documentToSearchResult);
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
      retrievalLatencyMs,
      rerankLatencyMs,
      answerLatencyMs: Date.now() - answerStart,
    };
  }

  const citations = evidence.map((item) => ({
    docId: item.id,
    slug: item.slug,
    url: item.url,
    title: item.title,
  }));

  const claims = evidence.slice(0, Math.min(4, evidence.length)).map((item) => ({
    text: `${item.title}: ${item.excerpt || "Relevant documentation found for this question."}`,
    citationDocIds: [item.id],
  }));

  const answer = GroundedAnswerSchema.parse({
    question: params.question,
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
    confidence: Math.min(0.95, 0.45 + evidence.length * 0.08),
    abstained: false,
  });

  return {
    answer,
    evidence,
    retrievalLatencyMs,
    rerankLatencyMs,
    answerLatencyMs: Date.now() - answerStart,
  };
}

function formatGroundedAnswerOutput(
  answer: GroundedAnswer,
  verification: ReturnType<typeof verifyGroundedAnswer>
): string {
  const citationLines =
    answer.citations.length > 0
      ? answer.citations
          .map((c) => `- [${c.docId}] ${c.title} (\`${c.slug}\`) — ${c.url}`)
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

  return [
    "## Grounded Answer",
    answer.answer,
    "",
    `Confidence: ${answer.confidence.toFixed(2)} | Abstained: ${answer.abstained ? "yes" : "no"}`,
    "",
    "## Claims",
    claimLines,
    "",
    "## Citations",
    citationLines,
    warnings,
  ].join("\n");
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

      const finalAnswer =
        verification.ok || result.answer.abstained
          ? result.answer
          : buildAbstainedAnswer(
              question,
              `Verification failed: ${verification.reasons.join(" | ")}`
            );

      logQualityEvent({
        tool: "answer_wordpress_question",
        question,
        retrievalLatencyMs: result.retrievalLatencyMs,
        rerankLatencyMs: result.rerankLatencyMs,
        answerLatencyMs: result.answerLatencyMs,
        evidenceCount: result.evidence.length,
        citationCoverage: verification.citationCoverage,
        unsupportedClaimRate: verification.unsupportedClaimRate,
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
