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
});

export type GroundedAnswer = z.infer<typeof GroundedAnswerSchema>;
