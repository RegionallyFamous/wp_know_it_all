export type IssueSeverity = "error" | "warning" | "info";

export interface ValidationIssue {
  severity: IssueSeverity;
  rule: string;
  message: string;
  fix: string;
  docs_url: string;
  line?: number;
}

export interface ValidationResult {
  issues: ValidationIssue[];
  score: number;    // 0–100 (100 = perfect)
  summary: string;  // "2 errors, 1 warning, 3 info"
  passed: boolean;  // true if no errors
}

export interface ValidationRule {
  id: string;
  severity: IssueSeverity;
  check: (code: string) => ValidationIssue[];
}
