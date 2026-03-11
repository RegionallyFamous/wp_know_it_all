export const WRANGLER_NAME = "Wrangler";

const LIGHT_OPENERS = [
  "Wrangler here — let us walk this trail steady and clear.",
  "Wrangler here — let us keep this practical and grounded.",
  "Wrangler here — here is the straight path through it.",
];

function pickLightOpener(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % LIGHT_OPENERS.length;
  return LIGHT_OPENERS[idx]!;
}

export interface WranglerPersonaOptions {
  includeLead?: boolean;
  includeSignoff?: boolean;
}

export function applyWranglerPersona(
  body: string,
  options: WranglerPersonaOptions = {}
): string {
  const includeLead = options.includeLead ?? true;
  const includeSignoff = options.includeSignoff ?? true;
  const trimmed = body.trim();
  if (!trimmed) return body;

  const parts: string[] = [];
  if (includeLead) {
    parts.push(`_${pickLightOpener(trimmed)}_`);
    parts.push("");
  }
  parts.push(trimmed);
  if (includeSignoff) {
    parts.push("");
    parts.push("— Wrangler");
  }
  return parts.join("\n");
}

export function hasWranglerStyle(text: string): boolean {
  return text.includes("Wrangler") && text.includes("— Wrangler");
}
