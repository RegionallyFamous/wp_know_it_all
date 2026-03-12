export type QueryIntent =
  | "exact_symbol"
  | "workflow"
  | "debug"
  | "implementation"
  | "security_review"
  | "migration"
  | "architecture"
  | "conceptual";

export interface QueryRoute {
  intent: QueryIntent;
  normalizedQuery: string;
}

const EXACT_SYMBOL_PATTERNS: RegExp[] = [
  /^[A-Za-z_][A-Za-z0-9_]*$/, // wp_enqueue_script
  /^[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*$/, // Class::method
  /^[A-Za-z_][A-Za-z0-9_]*\(\)$/, // function()
];
const WORKFLOW_PATTERNS: RegExp[] = [
  /^(how do i|how can i|how should i|how do|how can|how should|how does)\b/i,
  /\b(best practice|recommended approach|best way|step by step|workflow)\b/i,
];
const DEBUG_PATTERNS: RegExp[] = [
  /\b(error|failing|broken|not working|exception|stack trace|debug)\b/i,
];
const IMPLEMENTATION_PATTERNS: RegExp[] = [
  /\b(write code|implement|build|create plugin|create theme|sample code)\b/i,
];
const SECURITY_PATTERNS: RegExp[] = [
  /\b(security|xss|csrf|nonce|sanitize|escape|auth|permission|vulnerability)\b/i,
];
const MIGRATION_PATTERNS: RegExp[] = [
  /\b(migration|migrate|upgrade|port|compatibility|backward compatible)\b/i,
];
const ARCHITECTURE_PATTERNS: RegExp[] = [
  /\b(architecture|system design|trade[\s-]?off|design pattern)\b/i,
];

export function routeQuery(rawQuery: string): QueryRoute {
  const normalizedQuery = rawQuery.trim();
  const looksExact = EXACT_SYMBOL_PATTERNS.some((pattern) => pattern.test(normalizedQuery));
  const looksWorkflow = WORKFLOW_PATTERNS.some((pattern) => pattern.test(normalizedQuery));
  const looksDebug = DEBUG_PATTERNS.some((pattern) => pattern.test(normalizedQuery));
  const looksImplementation = IMPLEMENTATION_PATTERNS.some((pattern) =>
    pattern.test(normalizedQuery)
  );
  const looksSecurity = SECURITY_PATTERNS.some((pattern) => pattern.test(normalizedQuery));
  const looksMigration = MIGRATION_PATTERNS.some((pattern) => pattern.test(normalizedQuery));
  const looksArchitecture = ARCHITECTURE_PATTERNS.some((pattern) => pattern.test(normalizedQuery));

  let intent: QueryIntent = "conceptual";
  if (looksExact) intent = "exact_symbol";
  else if (looksSecurity) intent = "security_review";
  else if (looksDebug) intent = "debug";
  else if (looksMigration) intent = "migration";
  else if (looksWorkflow) intent = "workflow";
  else if (looksArchitecture) intent = "architecture";
  else if (looksImplementation) intent = "implementation";

  return {
    intent,
    normalizedQuery,
  };
}
