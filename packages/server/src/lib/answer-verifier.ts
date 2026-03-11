import type { buildQueries } from "../db/queries.js";
import type { GroundedAnswer } from "./answer-schema.js";

export interface VerificationResult {
  ok: boolean;
  citationCoverage: number;
  unsupportedClaimRate: number;
  averageSupportScore: number;
  reasons: string[];
}

function normalizeForMatch(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function claimSupportedByDoc(claimText: string, content: string): boolean {
  const claimNorm = normalizeForMatch(claimText);
  const docNorm = normalizeForMatch(content);
  if (!claimNorm || !docNorm) return false;

  const claimTokens = claimNorm.split(" ").filter((t) => t.length > 3);
  if (claimTokens.length === 0) return docNorm.includes(claimNorm);

  const matches = claimTokens.filter((token) => docNorm.includes(token)).length;
  const ratio = matches / claimTokens.length;
  return ratio >= 0.6;
}

function claimSupportScore(claimText: string, content: string): number {
  const claimNorm = normalizeForMatch(claimText);
  const docNorm = normalizeForMatch(content);
  if (!claimNorm || !docNorm) return 0;

  if (docNorm.includes(claimNorm)) return 1;

  const claimTokens = claimNorm.split(" ").filter((t) => t.length > 3);
  if (claimTokens.length === 0) return 0;
  const matches = claimTokens.filter((token) => docNorm.includes(token)).length;
  return matches / claimTokens.length;
}

export function verifyGroundedAnswer(
  answer: GroundedAnswer,
  queries: ReturnType<typeof buildQueries>
): VerificationResult {
  const reasons: string[] = [];
  const citationIds = new Set(answer.citations.map((c) => c.docId));

  if (!answer.abstained && answer.claims.length === 0) {
    reasons.push("Answer is not abstained but includes no claims.");
  }

  let claimsWithCitations = 0;
  let unsupportedClaims = 0;
  let supportScoreSum = 0;
  let supportScoreCount = 0;

  for (const claim of answer.claims) {
    if (claim.citationDocIds.length > 0) {
      claimsWithCitations += 1;
    } else {
      reasons.push(`Claim without citations: "${claim.text}"`);
      continue;
    }

    let supported = false;
    let bestScore = 0;
    for (const docId of claim.citationDocIds) {
      if (!citationIds.has(docId)) {
        reasons.push(`Claim references doc ${docId} that is not in citation list.`);
        continue;
      }
      const row = queries.getById(docId);
      if (!row) {
        reasons.push(`Citation doc ${docId} not found in database.`);
        continue;
      }
      const citation = answer.citations.find((c) => c.docId === docId);
      const snippet = citation?.evidenceSnippet?.trim() ?? "";
      if (snippet) {
        const snippetInDoc = normalizeForMatch(row.content_plain).includes(normalizeForMatch(snippet));
        if (!snippetInDoc) {
          reasons.push(`Citation snippet for doc ${docId} does not match indexed document content.`);
        }
      }

      const content = `${row.title}\n${row.content_plain}`;
      const scoreFromDoc = claimSupportScore(claim.text, content);
      const scoreFromSnippet = snippet ? claimSupportScore(claim.text, snippet) : 0;
      bestScore = Math.max(bestScore, scoreFromDoc, scoreFromSnippet);

      if (claimSupportedByDoc(claim.text, content) || (snippet && claimSupportedByDoc(claim.text, snippet))) {
        supported = true;
      }
    }

    supportScoreSum += bestScore;
    supportScoreCount += 1;

    if (!supported) {
      unsupportedClaims += 1;
      reasons.push(`Claim appears unsupported by cited docs: "${claim.text}"`);
    }
  }

  const citationCoverage = answer.claims.length === 0 ? 1 : claimsWithCitations / answer.claims.length;
  const unsupportedClaimRate =
    answer.claims.length === 0 ? 0 : unsupportedClaims / answer.claims.length;
  const averageSupportScore = supportScoreCount === 0 ? 1 : supportScoreSum / supportScoreCount;

  if (answer.abstained && answer.confidence > 0.5) {
    reasons.push("Abstained answer has unexpectedly high confidence.");
  }
  if (!answer.abstained && answer.confidence < 0.2) {
    reasons.push("Non-abstained answer confidence is too low.");
  }
  if (!answer.abstained && averageSupportScore < 0.45) {
    reasons.push("Average claim support score is too low for a non-abstained answer.");
  }

  const ok = reasons.length === 0;
  return {
    ok,
    citationCoverage,
    unsupportedClaimRate,
    averageSupportScore,
    reasons,
  };
}
