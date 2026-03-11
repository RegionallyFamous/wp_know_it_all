export interface QualityEvent {
  tool: string;
  question: string;
  retrievalLatencyMs: number;
  rerankLatencyMs: number;
  answerLatencyMs: number;
  evidenceCount: number;
  citationCoverage: number;
  unsupportedClaimRate: number;
  abstained: boolean;
  abstainReason?: string;
  confidence: number;
}

export function logQualityEvent(event: QualityEvent): void {
  const line = {
    ts: new Date().toISOString(),
    type: "quality_event",
    ...event,
  };
  console.log(`[quality] ${JSON.stringify(line)}`);
}
