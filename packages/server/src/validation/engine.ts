import type { ValidationResult, ValidationIssue } from "./types.js";
import { SecurityRules } from "./rules/security.js";
import { StandardsRules } from "./rules/standards.js";

const ALL_RULES = [...SecurityRules, ...StandardsRules];

export function validateWordPressCode(code: string): ValidationResult {
  const issues: ValidationIssue[] = [];

  for (const rule of ALL_RULES) {
    try {
      const found = rule.check(code);
      issues.push(...found);
    } catch {
      // Never let a buggy rule crash the engine
    }
  }

  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  const infos = issues.filter((i) => i.severity === "info").length;

  // Score: 100 - 15 per error - 5 per warning - 1 per info, minimum 0
  const score = Math.max(0, 100 - errors * 15 - warnings * 5 - infos * 1);

  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} error${errors !== 1 ? "s" : ""}`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings !== 1 ? "s" : ""}`);
  if (infos > 0) parts.push(`${infos} info`);
  const summary = parts.length > 0 ? parts.join(", ") : "no issues";

  return {
    issues,
    score,
    summary,
    passed: errors === 0,
  };
}
