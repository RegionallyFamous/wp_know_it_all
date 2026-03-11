import { z } from "zod";

export const AnswerCitationSchema = z.object({
  docId: z.number().int().positive(),
  slug: z.string().min(1),
  url: z.string().url(),
  title: z.string().min(1),
});

export const AnswerClaimSchema = z.object({
  text: z.string().min(1),
  citationDocIds: z.array(z.number().int().positive()).min(1),
});

export const GroundedAnswerSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  claims: z.array(AnswerClaimSchema),
  citations: z.array(AnswerCitationSchema),
  confidence: z.number().min(0).max(1),
  abstained: z.boolean(),
  abstainReason: z.string().optional(),
});

export type GroundedAnswer = z.infer<typeof GroundedAnswerSchema>;
