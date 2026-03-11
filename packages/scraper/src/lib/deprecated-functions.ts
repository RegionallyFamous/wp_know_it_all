export interface DeprecatedFunction {
  name: string;
  deprecated_since: string;
  replacement: string | null;
  file: string;
}

const DEPRECATED_FILE_URLS = [
  "https://raw.githubusercontent.com/WordPress/wordpress-develop/trunk/src/wp-includes/deprecated.php",
  "https://raw.githubusercontent.com/WordPress/wordpress-develop/trunk/src/wp-admin/includes/deprecated.php",
  "https://raw.githubusercontent.com/WordPress/wordpress-develop/trunk/src/wp-includes/ms-deprecated.php",
  "https://raw.githubusercontent.com/WordPress/wordpress-develop/trunk/src/wp-admin/includes/ms-deprecated.php",
  "https://raw.githubusercontent.com/WordPress/wordpress-develop/trunk/src/wp-includes/pluggable-deprecated.php",
] as const;

/**
 * Matches a _deprecated_function() call that uses __FUNCTION__ as the first arg.
 * Groups: [1] deprecated_since version, [2] replacement (optional)
 */
const DEPRECATED_CALL_RE =
  /_deprecated_function\s*\(\s*__FUNCTION__\s*,\s*['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]+)['"])?\s*\)/;

/** Matches a PHP function declaration and captures the bare function name. */
const FUNCTION_DEF_RE = /^\s*function\s+(\w+)\s*\(/;

/**
 * Scan a raw PHP file line-by-line and extract every function that calls
 * _deprecated_function( __FUNCTION__, ... ).
 *
 * Strategy: walk forward through lines. When a `function name()` declaration
 * is seen, remember its name. When a `_deprecated_function(…)` call is seen,
 * pair it with the most recently seen function name.
 */
function parseDeprecatedFunctions(
  source: string,
  fileUrl: string
): DeprecatedFunction[] {
  const results: DeprecatedFunction[] = [];
  const lines = source.split("\n");

  let currentFunctionName: string | null = null;

  for (const line of lines) {
    // Track which function we're currently inside.
    const fnMatch = FUNCTION_DEF_RE.exec(line);
    if (fnMatch) {
      currentFunctionName = fnMatch[1] ?? null;
    }

    // Look for a _deprecated_function call on this line.
    const callMatch = DEPRECATED_CALL_RE.exec(line);
    if (callMatch && currentFunctionName) {
      results.push({
        name: currentFunctionName,
        deprecated_since: callMatch[1] ?? "",
        replacement: callMatch[2] ?? null,
        file: fileUrl,
      });
      // Reset so we don't accidentally attribute a second call to the same fn.
      currentFunctionName = null;
    }
  }

  return results;
}

/**
 * Fetch all WordPress deprecated.php files from GitHub and return a deduplicated
 * list of deprecated functions with their since-version and replacement.
 */
export async function fetchDeprecatedFunctions(): Promise<DeprecatedFunction[]> {
  const seen = new Set<string>();
  const all: DeprecatedFunction[] = [];

  for (const url of DEPRECATED_FILE_URLS) {
    console.log(`[deprecated-functions] Fetching ${url}`);

    const res = await fetch(url);
    if (!res.ok) {
      console.warn(
        `[deprecated-functions] HTTP ${res.status} for ${url} — skipping`
      );
      continue;
    }

    const source = await res.text();
    const parsed = parseDeprecatedFunctions(source, url);

    for (const fn of parsed) {
      if (!seen.has(fn.name)) {
        seen.add(fn.name);
        all.push(fn);
      }
    }

    console.log(
      `[deprecated-functions] Found ${parsed.length} entries in ${url.split("/").pop()}`
    );
  }

  console.log(
    `[deprecated-functions] Total unique deprecated functions: ${all.length}`
  );
  return all;
}
