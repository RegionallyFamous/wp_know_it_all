import type { ValidationIssue, ValidationRule } from "../types.js";

function issue(
  rule: string,
  severity: ValidationIssue["severity"],
  message: string,
  fix: string,
  docs_url: string,
  line?: number,
): ValidationIssue {
  return { severity, rule, message, fix, docs_url, ...(line !== undefined ? { line } : {}) };
}

function lineOf(code: string, pattern: RegExp): number | undefined {
  const m = pattern.exec(code);
  if (!m) return undefined;
  return code.slice(0, m.index).split("\n").length;
}

// ── Rule 1: loose comparison ──────────────────────────────────────────────────
const looseComparison: ValidationRule = {
  id: "loose-comparison",
  severity: "info",
  check(code) {
    const pattern = /[^=!<>]={2}[^=]\s*(null|false|true)\b|[^=!<>]!={1}[^=]\s*(null|false|true)\b/;
    if (!pattern.test(code)) return [];
    return [
      issue(
        "loose-comparison",
        "info",
        "Loose comparison with null/false/true — use strict === or !== to avoid type coercion bugs.",
        "Replace == null with === null, == false with === false, etc.",
        "https://developer.wordpress.org/coding-standards/wordpress-coding-standards/php/",
        lineOf(code, pattern),
      ),
    ];
  },
};

// ── Rule 2: PHP short open tags ───────────────────────────────────────────────
const phpShortTags: ValidationRule = {
  id: "php-short-tags",
  severity: "error",
  check(code) {
    // Match <? not followed by php or =
    const pattern = /<\?(?!php\b|=)/;
    if (!pattern.test(code)) return [];
    return [
      issue(
        "php-short-tags",
        "error",
        "PHP short open tags (<?) are disabled on many hosts and forbidden by WordPress coding standards.",
        "Replace <? with <?php.",
        "https://developer.wordpress.org/coding-standards/wordpress-coding-standards/php/",
        lineOf(code, pattern),
      ),
    ];
  },
};

// ── Rule 3: hardcoded credentials ─────────────────────────────────────────────
const hardcodedCredentials: ValidationRule = {
  id: "hardcoded-credentials",
  severity: "warning",
  check(code) {
    const pattern = /\b(password|secret|api_key|apikey|auth_token)\s*=\s*['"][^'"]{4,}['"]/i;
    if (!pattern.test(code)) return [];
    return [
      issue(
        "hardcoded-credentials",
        "warning",
        "Hardcoded credential detected — passwords, secrets, and API keys must not be in source code.",
        "Use wp_options, environment variables, or a secrets manager instead.",
        "https://developer.wordpress.org/coding-standards/wordpress-coding-standards/php/",
        lineOf(code, pattern),
      ),
    ];
  },
};

// ── Rule 4: ORDER BY with superglobal (SQL injection vector) ──────────────────
const noOrderBySuperglobal: ValidationRule = {
  id: "no-orderby-superglobal",
  severity: "error",
  check(code) {
    const pattern = /ORDER BY.*\$_(GET|POST|REQUEST)/;
    if (!pattern.test(code)) return [];
    return [
      issue(
        "no-orderby-superglobal",
        "error",
        "ORDER BY clause contains user-supplied input — SQL injection risk.",
        "Whitelist allowed column names: $allowed = ['date', 'title']; if ( ! in_array( $col, $allowed, true ) ) return;",
        "https://developer.wordpress.org/reference/classes/wpdb/prepare/",
        lineOf(code, pattern),
      ),
    ];
  },
};

// ── Rule 5: missing text domain in i18n calls ─────────────────────────────────
const missingTextDomain: ValidationRule = {
  id: "missing-text-domain",
  severity: "warning",
  check(code) {
    // __( 'string' ) or _e( 'string' ) without a second arg
    const pattern = /\b(__\s*\(|_e\s*\(|esc_html__\s*\(|esc_html_e\s*\()\s*['"][^'"]*['"]\s*\)/;
    if (!pattern.test(code)) return [];
    return [
      issue(
        "missing-text-domain",
        "warning",
        "Translation function called without text domain — strings won't be translatable.",
        "Add your text domain: __( 'Hello', 'my-plugin' )",
        "https://developer.wordpress.org/plugins/internationalization/how-to-internationalize-your-plugin/",
        lineOf(code, pattern),
      ),
    ];
  },
};

// ── Rule 6: relative include/require without __DIR__ ─────────────────────────
const noRelativeInclude: ValidationRule = {
  id: "no-relative-include",
  severity: "warning",
  check(code) {
    // include 'path' or require 'path' where path doesn't use __DIR__ or ABSPATH
    const pattern = /\b(include|require)(_once)?\s+['"]/;
    if (!pattern.test(code)) return [];
    // Forgive if __DIR__ or ABSPATH is present on the same line
    const lines = code.split("\n");
    const flaggedLine = lines.find(
      (l) => pattern.test(l) && !/__DIR__|ABSPATH/.test(l),
    );
    if (!flaggedLine) return [];
    const ln = lines.indexOf(flaggedLine) + 1;
    return [
      issue(
        "no-relative-include",
        "warning",
        "Relative include/require without __DIR__ — breaks when file is loaded from a different working directory.",
        "Use: require_once __DIR__ . '/path/to/file.php';",
        "https://developer.wordpress.org/coding-standards/wordpress-coding-standards/php/",
        ln,
      ),
    ];
  },
};

// ── Rule 7: non-Yoda condition style ──────────────────────────────────────────
const yodaCondition: ValidationRule = {
  id: "yoda-condition",
  severity: "info",
  check(code) {
    // Flag if ( $var == ... ) — non-Yoda
    const pattern = /if\s*\(\s*\$[a-zA-Z_]\w*\s*==\s*/;
    if (!pattern.test(code)) return [];
    return [
      issue(
        "yoda-condition",
        "info",
        "Non-Yoda condition detected — WordPress coding standards prefer: if ( 'value' === $var ).",
        "Flip the comparison: if ( 'expected' === $variable ) { ... }",
        "https://developer.wordpress.org/coding-standards/wordpress-coding-standards/php/",
        lineOf(code, pattern),
      ),
    ];
  },
};

// ── Rule 8: Elvis operator (?:) ───────────────────────────────────────────────
const noShortTernary: ValidationRule = {
  id: "no-short-ternary",
  severity: "info",
  check(code) {
    // Match ?: but not ?? (null coalescing)
    const pattern = /\?:[^:]/;
    if (!pattern.test(code)) return [];
    return [
      issue(
        "no-short-ternary",
        "info",
        "Consider using the null coalescing operator ?? instead of ?: for clarity.",
        "Replace $val ?: 'default' with $val ?? 'default' when checking for null/undefined.",
        "https://developer.wordpress.org/coding-standards/wordpress-coding-standards/php/",
        lineOf(code, pattern),
      ),
    ];
  },
};

// ── Rule 9: direct file access (missing ABSPATH guard) ───────────────────────
const directFileAccess: ValidationRule = {
  id: "direct-file-access",
  severity: "warning",
  check(code) {
    // Must include either <?php at the top or be an include-only file
    if (!code.includes("<?php")) return [];
    if (/ABSPATH/.test(code)) return [];
    // Only flag files that look like plugin/theme entry points (have hooks or functions)
    if (!/add_action|add_filter|function\s+\w/.test(code)) return [];
    return [
      issue(
        "direct-file-access",
        "warning",
        "PHP file missing ABSPATH check — can be executed directly from the browser.",
        "Add at the top: if ( ! defined( 'ABSPATH' ) ) exit;",
        "https://developer.wordpress.org/coding-standards/wordpress-coding-standards/php/",
        1,
      ),
    ];
  },
};

// ── Rule 10: bare die() / exit() instead of wp_die() ─────────────────────────
const wpDieNotDie: ValidationRule = {
  id: "wp-die-not-die",
  severity: "warning",
  check(code) {
    // Match die( or exit( not preceded by wp_safe_redirect, wp_redirect (those are allowed)
    const pattern = /(?<!wp_safe_redirect[^;]{0,100})\b(die|exit)\s*[;(]/g;
    const issues: ValidationIssue[] = [];
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(code)) !== null) {
      const before = code.slice(Math.max(0, m.index - 120), m.index);
      // Allow exit/die after wp_redirect
      if (/wp_(safe_)?redirect/.test(before)) continue;
      // Allow exit/die in ABSPATH guards: if ( ! defined( 'ABSPATH' ) ) exit;
      if (/defined\s*\(\s*['"]ABSPATH['"]/.test(before)) continue;
      issues.push(
        issue(
          "wp-die-not-die",
          "warning",
          "Use wp_die() instead of die() or exit() for WordPress-aware error handling.",
          "Replace die( $message ) with wp_die( esc_html( $message ) );",
          "https://developer.wordpress.org/reference/functions/wp_die/",
          code.slice(0, m.index).split("\n").length,
        ),
      );
    }
    return issues;
  },
};

export const StandardsRules: ValidationRule[] = [
  looseComparison,
  phpShortTags,
  hardcodedCredentials,
  noOrderBySuperglobal,
  missingTextDomain,
  noRelativeInclude,
  yodaCondition,
  noShortTernary,
  directFileAccess,
  wpDieNotDie,
];
