export interface BeyondRagFeatureFlags {
  plannerRouter: boolean;
  verifierCritic: boolean;
  toolExecutionChain: boolean;
  memoryPolicy: boolean;
}

function envFlag(name: string, fallback = true): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw !== "0" && raw.toLowerCase() !== "false";
}

export function getBeyondRagFlags(): BeyondRagFeatureFlags {
  return {
    plannerRouter: envFlag("FEATURE_PLANNER_ROUTER", true),
    verifierCritic: envFlag("FEATURE_VERIFIER_CRITIC", true),
    toolExecutionChain: envFlag("FEATURE_TOOL_EXECUTION_CHAIN", true),
    memoryPolicy: envFlag("FEATURE_MEMORY_POLICY", true),
  };
}
