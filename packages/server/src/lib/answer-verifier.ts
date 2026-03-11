import type { buildQueries } from "../db/queries.js";
import type { GroundedAnswer } from "./answer-schema.js";

export interface VerificationResult {
  ok: boolean;
  citationCoverage: number;
  unsupportedClaimRate: number;
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

  for (const claim of answer.claims) {
    if (claim.citationDocIds.length > 0) {
      claimsWithCitations += 1;
    } else {
      reasons.push(`Claim without citations: "${claim.text}"`);
      continue;
    }

    let supported = false;
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
      const content = `${row.title}\n${row.content_plain}`;
      if (claimSupportedByDoc(claim.text, content)) {
        supported = true;
      }
    }

    if (!supported) {
      unsupportedClaims += 1;
      reasons.push(`Claim appears unsupported by cited docs: "${claim.text}"`);
    }
  }

  const citationCoverage = answer.claims.length === 0 ? 1 : claimsWithCitations / answer.claims.length;
  const unsupportedClaimRate =
    answer.claims.length === 0 ? 0 : unsupportedClaims / answer.claims.length;

  if (answer.abstained && answer.confidence > 0.5) {
    reasons.push("Abstained answer has unexpectedly high confidence.");
  }
  if (!answer.abstained && answer.confidence < 0.2) {
    reasons.push("Non-abstained answer confidence is too low.");
  }

  const ok = reasons.length === 0;
  return {
    ok,
    citationCoverage,
    unsupportedClaimRate,
    reasons,
  };
}
