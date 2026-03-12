import { z } from "zod";

export const AnswerCitationSchema = z.object({
  docId: z.number().int().positive(),
  slug: z.string().min(1),
  url: z.string().url(),
  title: z.string().min(1),
  evidenceSnippet: z.string().min(1).optional(),
  startOffset: z.number().int().min(0).optional(),
  endOffset: z.number().int().min(0).optional(),
  supportScore: z.number().min(0).max(1).optional(),
});

export const AnswerClaimSchema = z.object({
  text: z.string().min(1),
  citationDocIds: z.array(z.number().int().positive()).min(1),
  supportScore: z.number().min(0).max(1).optional(),
});

export const GroundedAnswerSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  claims: z.array(AnswerClaimSchema),
  citations: z.array(AnswerCitationSchema),
  reasoningSteps: z.array(z.string().min(1)).optional(),
  assumptions: z.array(z.string().min(1)).optional(),
  confidence: z.number().min(0).max(1),
  abstained: z.boolean(),
  abstainReason: z.string().optional(),
  plannerTrace: z
    .object({
      intent: z.string().min(1),
      retrievalGoals: z.array(z.string().min(1)),
      subquestions: z.array(z.string().min(1)),
      toolHints: z.array(z.string().min(1)),
    })
    .optional(),
  validation: z
    .object({
      executed: z.boolean(),
      passed: z.boolean(),
      score: z.number().int().min(0).max(100).optional(),
      summary: z.string().optional(),
      blockingIssueCount: z.number().int().min(0).default(0),
    })
    .optional(),
  implementationReady: z.boolean().optional(),
  policy: z
    .object({
      violated: z.boolean(),
      reasons: z.array(z.string().min(1)),
    })
    .optional(),
});

export type GroundedAnswer = z.infer<typeof GroundedAnswerSchema>;
