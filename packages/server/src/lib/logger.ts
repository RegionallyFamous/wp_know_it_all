import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogRecord {
  ts: string;
  level: LogLevel;
  event: string;
  context?: Record<string, unknown>;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const configuredLevel = (process.env["LOG_LEVEL"]?.trim().toLowerCase() as LogLevel | undefined) ?? "info";
const minLevel = LEVEL_ORDER[configuredLevel] != null ? configuredLevel : "info";
const writeFileLogs = process.env["LOG_FILE_ENABLED"] === "1";
const logFilePath =
  process.env["LOG_EVENTS_PATH"]?.trim() ||
  join(process.env["RAILWAY_VOLUME_MOUNT_PATH"] ?? "./data", "server-events.jsonl");

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

function sanitizeContext(input: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!input) return undefined;
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const lower = key.toLowerCase();
    if (
      lower.includes("token") ||
      lower.includes("password") ||
      lower.includes("authorization") ||
      lower.includes("cookie") ||
      lower.includes("secret")
    ) {
      redacted[key] = "[redacted]";
      continue;
    }
    redacted[key] = value;
  }
  return redacted;
}

export function logEvent(level: LogLevel, event: string, context?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  const record: LogRecord = {
    ts: new Date().toISOString(),
    level,
    event,
    context: sanitizeContext(context),
  };
  const serialized = JSON.stringify(record);
  if (level === "error") console.error(serialized);
  else if (level === "warn") console.warn(serialized);
  else console.log(serialized);

  if (writeFileLogs) {
    try {
      mkdirSync(dirname(logFilePath), { recursive: true });
      appendFileSync(logFilePath, `${serialized}\n`, "utf-8");
    } catch {
      // Keep logger fail-safe; never throw from logging path.
    }
  }
}

export function logInfo(event: string, context?: Record<string, unknown>): void {
  logEvent("info", event, context);
}

export function logDebug(event: string, context?: Record<string, unknown>): void {
  logEvent("debug", event, context);
}

export function logWarn(event: string, context?: Record<string, unknown>): void {
  logEvent("warn", event, context);
}

export function logError(event: string, context?: Record<string, unknown>): void {
  logEvent("error", event, context);
}
