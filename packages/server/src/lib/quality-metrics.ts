import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface QualityEvent {
  tool: string;
  question: string;
  synthesisEngine?: "deterministic" | "ollama";
  criticUsed?: boolean;
  criticAccepted?: boolean;
  retrievalLatencyMs: number;
  rerankLatencyMs: number;
  answerLatencyMs: number;
  evidenceCount: number;
  citationCoverage: number;
  unsupportedClaimRate: number;
  averageSupportScore?: number;
  abstained: boolean;
  abstainReason?: string;
  confidence: number;
}

function qualityLogPath(): string {
  const override = process.env["QUALITY_EVENTS_PATH"]?.trim();
  if (override) return override;
  const base = process.env["RAILWAY_VOLUME_MOUNT_PATH"] ?? "./data";
  return join(base, "quality-events.jsonl");
}

export function logQualityEvent(event: QualityEvent): void {
  const line = {
    ts: new Date().toISOString(),
    type: "quality_event",
    ...event,
  };
  console.log(`[quality] ${JSON.stringify(line)}`);
  try {
    const path = qualityLogPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(line)}\n`, "utf-8");
  } catch (error) {
    console.warn(`[quality] Failed to persist quality event: ${String(error)}`);
  }
}

export interface QualitySummary {
  totalEvents: number;
  avgCitationCoverage: number;
  avgUnsupportedClaimRate: number;
  avgSupportScore: number;
  avgConfidence: number;
  abstainRate: number;
  ollamaUsageRate: number;
}

export interface StoredQualityEvent extends QualityEvent {
  ts: string;
  type: "quality_event";
}

export function readRecentQualityEvents(limit = 200): StoredQualityEvent[] {
  const path = qualityLogPath();
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const recent = lines.slice(-limit);
  const parsed: StoredQualityEvent[] = [];
  for (const line of recent) {
    try {
      const event = JSON.parse(line) as StoredQualityEvent;
      if (event.type === "quality_event") parsed.push(event);
    } catch {
      // Skip malformed lines
    }
  }
  return parsed;
}

export function summarizeQualityEvents(events: StoredQualityEvent[]): QualitySummary {
  if (events.length === 0) {
    return {
      totalEvents: 0,
      avgCitationCoverage: 0,
      avgUnsupportedClaimRate: 0,
      avgSupportScore: 0,
      avgConfidence: 0,
      abstainRate: 0,
      ollamaUsageRate: 0,
    };
  }
  const totalEvents = events.length;
  const sum = <K extends keyof StoredQualityEvent>(key: K): number =>
    events.reduce((acc, event) => acc + (typeof event[key] === "number" ? Number(event[key]) : 0), 0);
  const avg = (value: number): number => value / totalEvents;
  const abstainRate = avg(events.filter((event) => event.abstained).length);
  const ollamaUsageRate = avg(events.filter((event) => event.synthesisEngine === "ollama").length);
  return {
    totalEvents,
    avgCitationCoverage: avg(sum("citationCoverage")),
    avgUnsupportedClaimRate: avg(sum("unsupportedClaimRate")),
    avgSupportScore: avg(sum("averageSupportScore")),
    avgConfidence: avg(sum("confidence")),
    abstainRate,
    ollamaUsageRate,
  };
}
