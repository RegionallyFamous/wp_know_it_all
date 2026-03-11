// Known WordPress hook prefixes and common function prefixes used for detection
const HOOK_PATTERN = /\b([a-z][a-z0-9_]*(?:_action|_filter)?)\b/g;
const WP_FUNCTION_PATTERN = /\b(wp_[a-z_]+|get_[a-z_]+|add_[a-z_]+|remove_[a-z_]+|do_[a-z_]+|register_[a-z_]+|unregister_[a-z_]+|the_[a-z_]+|is_[a-z_]+|has_[a-z_]+|update_[a-z_]+|delete_[a-z_]+|sanitize_[a-z_]+|esc_[a-z_]+|WP_[A-Za-z_]+)\b/g;
const SINCE_PATTERN = /(?:since|added in|@since)\s+([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i;
const SIGNATURE_PATTERN = /^function\s+(\w+)\s*\(/m;

export interface ExtractedMetadata {
  since_version: string | null;
  signature: string | null;
  hooks_mentioned: string[];
  functions_mentioned: string[];
}

export function extractMetadata(
  markdown: string,
  title: string
): ExtractedMetadata {
  const sinceMatch = SINCE_PATTERN.exec(markdown);
  const since_version = sinceMatch?.[1] ?? null;

  // Extract code signature from first PHP code block
  let signature: string | null = null;
  const codeBlockMatch = /```php\n([\s\S]*?)```/.exec(markdown);
  if (codeBlockMatch) {
    const code = codeBlockMatch[1] ?? "";
    const sigMatch = SIGNATURE_PATTERN.exec(code);
    if (sigMatch) {
      // Grab the function declaration line
      const sigLine = code
        .split("\n")
        .find((l) => l.includes("function ") && l.includes("(")) ?? null;
      signature = sigLine?.trim() ?? null;
    }
  }

  // Extract hook names from the text (action/filter names in add_action/add_filter calls)
  const hooks_mentioned: string[] = [];
  const hookCallPattern = /(?:add_action|add_filter|do_action|apply_filters)\s*\(\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = hookCallPattern.exec(markdown)) !== null) {
    const hookName = m[1];
    if (hookName && !hooks_mentioned.includes(hookName)) {
      hooks_mentioned.push(hookName);
    }
  }

  // Extract WP function names mentioned in the document (excluding the title itself)
  const titleSlug = title.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  const functions_mentioned: string[] = [];
  let fm: RegExpExecArray | null;
  while ((fm = WP_FUNCTION_PATTERN.exec(markdown)) !== null) {
    const fn = fm[1];
    if (
      fn &&
      fn.toLowerCase() !== titleSlug &&
      !functions_mentioned.includes(fn) &&
      fn.length > 3
    ) {
      functions_mentioned.push(fn);
    }
  }

  return {
    since_version,
    signature,
    hooks_mentioned: hooks_mentioned.slice(0, 20),
    functions_mentioned: functions_mentioned.slice(0, 20),
  };
}
