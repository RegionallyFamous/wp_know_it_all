export type QueryIntent = "exact_symbol" | "workflow" | "conceptual";

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
  /^(how do i|how can i|how should i)\b/i,
  /\b(best practice|recommended approach|step by step|workflow)\b/i,
];

export function routeQuery(rawQuery: string): QueryRoute {
  const normalizedQuery = rawQuery.trim();
  const looksExact = EXACT_SYMBOL_PATTERNS.some((pattern) => pattern.test(normalizedQuery));
  const looksWorkflow = WORKFLOW_PATTERNS.some((pattern) => pattern.test(normalizedQuery));
  return {
    intent: looksExact ? "exact_symbol" : looksWorkflow ? "workflow" : "conceptual",
    normalizedQuery,
  };
}
