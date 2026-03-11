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

/** Return 1-based line number of first regex match, or undefined. */
function lineOf(code: string, pattern: RegExp): number | undefined {
  const m = pattern.exec(code);
  if (!m) return undefined;
  return code.slice(0, m.index).split("\n").length;
}

// ── Rule 1: missing nonce in save_post ────────────────────────────────────────
const missingNonceSavePost: ValidationRule = {
  id: "missing-nonce-save-post",
  severity: "error",
  check(code) {
    const hasSavePost = /add_action\s*\(\s*['"]save_post['"]/.test(code);
    if (!hasSavePost) return [];
    const hasNonce = /wp_verify_nonce|check_admin_referer/.test(code);
    if (hasNonce) return [];
    return [
      issue(
        "missing-nonce-save-post",
        "error",
        "Hooked into save_post without nonce verification — this allows CSRF attacks.",
        "Add: if ( ! wp_verify_nonce( $_POST['_wpnonce'] ?? '', 'save_post_' . $post_id ) ) return;",
        "https://developer.wordpress.org/apis/security/nonces/",
        lineOf(code, /add_action\s*\(\s*['"]save_post['"]/),
      ),
    ];
  },
};

// ── Rule 2: missing nonce in AJAX handler ─────────────────────────────────────
const missingNonceAjax: ValidationRule = {
  id: "missing-nonce-ajax",
  severity: "error",
  check(code) {
    const hasAjax = /add_action\s*\(\s*['"]wp_ajax_/.test(code);
    if (!hasAjax) return [];
    const hasNonce = /check_ajax_referer|wp_verify_nonce/.test(code);
    if (hasNonce) return [];
    return [
      issue(
        "missing-nonce-ajax",
        "error",
        "AJAX handler missing nonce verification — any logged-in user can trigger this.",
        "Add: check_ajax_referer( 'my_action', 'nonce' );",
        "https://developer.wordpress.org/apis/security/nonces/",
        lineOf(code, /add_action\s*\(\s*['"]wp_ajax_/),
      ),
    ];
  },
};

// ── Rule 3: nonce check disabled (die=false) ──────────────────────────────────
const nonceCheckDisabled: ValidationRule = {
  id: "nonce-check-disabled",
  severity: "error",
  check(code) {
    // Matches check_ajax_referer( ... , false ) — third arg is false
    const pattern = /check_ajax_referer\s*\([^)]*,\s*false\s*\)/;
    if (!pattern.test(code)) return [];
    return [
      issue(
        "nonce-check-disabled",
        "error",
        "check_ajax_referer() called with die=false — nonce failure won't stop execution.",
        "Remove the third argument (defaults to true, which terminates on failure).",
        "https://developer.wordpress.org/reference/functions/check_ajax_referer/",
        lineOf(code, pattern),
      ),
    ];
  },
};

// ── Rule 4: REST route with __return_true permission_callback ─────────────────
const restReturnTrue: ValidationRule = {
  id: "rest-return-true",
  severity: "error",
  check(code) {
    const pattern = /['"']permission_callback['"']\s*=>\s*['"']__return_true['"']/;
    if (!pattern.test(code)) return [];
    return [
      issue(
        "rest-return-true",
        "error",
        "REST route uses __return_true permission_callback — endpoint is publicly writable.",
        "Replace with: 'permission_callback' => function() { return current_user_can( 'edit_posts' ); }",
        "https://developer.wordpress.org/rest-api/extending-the-rest-api/adding-custom-endpoints/",
        lineOf(code, pattern),
      ),
    ];
  },
};

// ── Rule 5: register_rest_route without permission_callback ───────────────────
const missingPermissionCallback: ValidationRule = {
  id: "missing-permission-callback",
  severity: "error",
  check(code) {
    if (!code.includes("register_rest_route(")) return [];
    if (/permission_callback/.test(code)) return [];
    return [
      issue(
        "missing-permission-callback",
        "error",
        "register_rest_route() missing permission_callback — defaults to open access since WP 5.5.",
        "Add 'permission_callback' => function() { return current_user_can( 'manage_options' ); }",
        "https://developer.wordpress.org/rest-api/extending-the-rest-api/adding-custom-endpoints/",
        lineOf(code, /register_rest_route\s*\(/),
      ),
    ];
  },
};

// ── Rule 6: privileged operation without capability check ─────────────────────
const noCapabilityCheck: ValidationRule = {
  id: "no-capability-check",
  severity: "error",
  check(code) {
    const hasPrivOp = /\$wpdb->delete\s*\(|wp_delete_post\s*\(|wp_update_post\s*\(|update_option\s*\(/.test(code);
    if (!hasPrivOp) return [];
    if (/current_user_can/.test(code)) return [];
    return [
      issue(
        "no-capability-check",
        "error",
        "Privileged operation without capability check — any user could trigger this.",
        "Add: if ( ! current_user_can( 'edit_posts' ) ) return;",
        "https://developer.wordpress.org/apis/security/user-capabilities-and-roles/",
        lineOf(code, /wp_delete_post\s*\(|wp_update_post\s*\(|update_option\s*\(/),
      ),
    ];
  },
};

// ── Rule 7: SQL injection via direct $wpdb query ───────────────────────────────
const sqlInjectionWpdb: ValidationRule = {
  id: "sql-injection-wpdb",
  severity: "error",
  check(code) {
    // Detect $wpdb->query/get_results/get_row/get_var/get_col( where argument
    // is not wrapped in $wpdb->prepare(
    const callPattern = /\$wpdb->(query|get_results|get_row|get_var|get_col)\s*\(\s*(?!\s*\$wpdb->prepare)/g;
    const issues: ValidationIssue[] = [];
    let m: RegExpExecArray | null;
    while ((m = callPattern.exec(code)) !== null) {
      // Allow calls where the immediate argument IS $wpdb->prepare(
      const afterCall = code.slice(m.index + m[0].length);
      if (/^\s*\$wpdb->prepare\s*\(/.test(afterCall)) continue;
      const ln = code.slice(0, m.index).split("\n").length;
      issues.push(
        issue(
          "sql-injection-wpdb",
          "error",
          "Direct $wpdb query without prepare() — vulnerable to SQL injection.",
          "Use $wpdb->prepare(): $wpdb->get_results( $wpdb->prepare( 'SELECT * FROM %i WHERE id = %d', $table, $id ) )",
          "https://developer.wordpress.org/reference/classes/wpdb/prepare/",
          ln,
        ),
      );
    }
    return issues;
  },
};

// ── Rule 8: LIKE query without esc_like ───────────────────────────────────────
const sqlInjectionLike: ValidationRule = {
  id: "sql-injection-like",
  severity: "warning",
  check(code) {
    // Only flag LIKE inside a prepare() call that lacks esc_like
    const hasPrepareWithLike = /\$wpdb->prepare\s*\([^)]*LIKE[^)]*\)/.test(code);
    if (!hasPrepareWithLike) return [];
    if (/esc_like/.test(code)) return [];
    return [
      issue(
        "sql-injection-like",
        "warning",
        "LIKE query without esc_like() — user % and _ characters cause wildcard injection.",
        "Wrap the search term: $wpdb->prepare( 'WHERE name LIKE %s', '%' . $wpdb->esc_like( $term ) . '%' )",
        "https://developer.wordpress.org/reference/classes/wpdb/esc_like/",
        lineOf(code, /\$wpdb->prepare\s*\([^)]*LIKE/),
      ),
    ];
  },
};

// ── Rule 9: echo of superglobal ───────────────────────────────────────────────
const echoSuperglobal: ValidationRule = {
  id: "echo-superglobal",
  severity: "error",
  check(code) {
    const pattern = /echo\s+\$_(GET|POST|REQUEST)\s*\[/g;
    const issues: ValidationIssue[] = [];
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(code)) !== null) {
      issues.push(
        issue(
          "echo-superglobal",
          "error",
          "Unescaped user input in output — XSS vulnerability.",
          "Escape output: echo esc_html( $_GET['param'] ?? '' );",
          "https://developer.wordpress.org/apis/security/escaping/",
          code.slice(0, m.index).split("\n").length,
        ),
      );
    }
    return issues;
  },
};

// ── Rule 10: unescaped echo of variable ───────────────────────────────────────
const unescapedEcho: ValidationRule = {
  id: "unescaped-echo",
  severity: "warning",
  check(code) {
    // Match `echo $variable` where the variable is not inside an escape function
    const escapeFns = /esc_html\s*\(|esc_attr\s*\(|esc_url\s*\(|esc_js\s*\(|wp_kses\s*\(|wp_kses_post\s*\(|absint\s*\(|intval\s*\(|number_format\s*\(/;
    const echoPattern = /\becho\s+(\$[a-zA-Z_]\w*)\s*;/g;
    const issues: ValidationIssue[] = [];
    let m: RegExpExecArray | null;
    while ((m = echoPattern.exec(code)) !== null) {
      // Check surrounding context (same line)
      const lineStart = code.lastIndexOf("\n", m.index) + 1;
      const lineEnd = code.indexOf("\n", m.index);
      const line = code.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      if (escapeFns.test(line)) continue;
      issues.push(
        issue(
          "unescaped-echo",
          "warning",
          "Echoing variable without escaping — verify output is safe or use esc_html().",
          "Use the appropriate escape function: esc_html(), esc_attr(), esc_url(), wp_kses_post()",
          "https://developer.wordpress.org/apis/security/escaping/",
          code.slice(0, m.index).split("\n").length,
        ),
      );
    }
    return issues;
  },
};

// ── Rule 11: save_post without DOING_AUTOSAVE check ───────────────────────────
const missingDoingAutosave: ValidationRule = {
  id: "missing-doing-autosave",
  severity: "warning",
  check(code) {
    if (!/add_action\s*\(\s*['"]save_post['"]/.test(code)) return [];
    if (/DOING_AUTOSAVE/.test(code)) return [];
    return [
      issue(
        "missing-doing-autosave",
        "warning",
        "save_post handler missing DOING_AUTOSAVE check — fires every 60 seconds on autosave.",
        "Add at the top: if ( defined( 'DOING_AUTOSAVE' ) && DOING_AUTOSAVE ) return;",
        "https://developer.wordpress.org/reference/hooks/save_post/",
        lineOf(code, /add_action\s*\(\s*['"]save_post['"]/),
      ),
    ];
  },
};

// ── Rule 12: unserialize on user input ────────────────────────────────────────
const unserializeUserInput: ValidationRule = {
  id: "unserialize-user-input",
  severity: "error",
  check(code) {
    // Detect unserialize( where argument contains a superglobal or get_option
    const pattern = /unserialize\s*\(\s*(\$_(GET|POST|REQUEST)|get_option\s*\()/;
    if (!pattern.test(code)) return [];
    return [
      issue(
        "unserialize-user-input",
        "error",
        "unserialize() on untrusted data — PHP object injection vulnerability, possible RCE.",
        "Use json_decode() instead of unserialize() for stored/user data.",
        "https://owasp.org/www-community/vulnerabilities/PHP_Object_Injection",
        lineOf(code, pattern),
      ),
    ];
  },
};

// ── Rule 13: unlimited post query ─────────────────────────────────────────────
const postsPerPageUnlimited: ValidationRule = {
  id: "posts-per-page-unlimited",
  severity: "warning",
  check(code) {
    const pattern = /['"]posts_per_page['"]\s*=>\s*-1|['"]nopaging['"]\s*=>\s*true/;
    if (!pattern.test(code)) return [];
    return [
      issue(
        "posts-per-page-unlimited",
        "warning",
        "Unlimited post query (posts_per_page: -1) — returns all posts, causes OOM on large sites.",
        "Set a reasonable limit: 'posts_per_page' => 100, and use pagination.",
        "https://developer.wordpress.org/reference/classes/wp_query/",
        lineOf(code, pattern),
      ),
    ];
  },
};

// ── Rule 14: direct header() redirect ────────────────────────────────────────
const directHeaderRedirect: ValidationRule = {
  id: "direct-header-redirect",
  severity: "warning",
  check(code) {
    const pattern = /header\s*\(\s*['"]Location:/;
    if (!pattern.test(code)) return [];
    return [
      issue(
        "direct-header-redirect",
        "warning",
        "Direct header() redirect — use wp_safe_redirect() instead.",
        "Replace with: wp_safe_redirect( esc_url_raw( $url ) ); exit;",
        "https://developer.wordpress.org/reference/functions/wp_safe_redirect/",
        lineOf(code, pattern),
      ),
    ];
  },
};

// ── Rule 15: wp_redirect / wp_safe_redirect without exit ─────────────────────
const redirectWithoutExit: ValidationRule = {
  id: "redirect-without-exit",
  severity: "error",
  check(code) {
    if (!/wp_(safe_)?redirect\s*\(/.test(code)) return [];
    if (/wp_(safe_)?redirect[\s\S]{0,200}(exit|die)\s*[;(]/.test(code)) return [];
    return [
      issue(
        "redirect-without-exit",
        "error",
        "wp_redirect() without exit — execution continues after redirect, logic errors likely.",
        "Always follow wp_redirect() with exit; or die();",
        "https://developer.wordpress.org/reference/functions/wp_redirect/",
        lineOf(code, /wp_(safe_)?redirect\s*\(/),
      ),
    ];
  },
};

// ── Rule 16: $_REQUEST usage ──────────────────────────────────────────────────
const requestSuperglobal: ValidationRule = {
  id: "request-superglobal",
  severity: "warning",
  check(code) {
    const pattern = /\$_REQUEST\s*\[/;
    if (!pattern.test(code)) return [];
    return [
      issue(
        "request-superglobal",
        "warning",
        "$_REQUEST merges GET, POST, and COOKIE — use explicit $_GET or $_POST instead.",
        "Use $_POST['key'] for form submissions or $_GET['key'] for URL parameters.",
        "https://developer.wordpress.org/apis/security/sanitizing/",
        lineOf(code, pattern),
      ),
    ];
  },
};

// ── Rule 17: unsanitized input stored in meta/options ─────────────────────────
const missingSanitizeInput: ValidationRule = {
  id: "missing-sanitize-input",
  severity: "error",
  check(code) {
    // Detect update_*meta/update_option calls containing raw superglobals
    const storeFn = /(update_post_meta|update_option|update_user_meta)\s*\(/;
    if (!storeFn.test(code)) return [];

    const lines = code.split("\n");
    const issues: ValidationIssue[] = [];

    lines.forEach((line, idx) => {
      if (!storeFn.test(line)) return;
      if (!/\$_(POST|GET)\[/.test(line)) return;
      if (/sanitize_/.test(line)) return;
      issues.push(
        issue(
          "missing-sanitize-input",
          "error",
          "Storing unsanitized user input — use sanitize_text_field(), absint(), or sanitize_email().",
          "Sanitize before saving: update_post_meta( $id, 'key', sanitize_text_field( $_POST['val'] ?? '' ) )",
          "https://developer.wordpress.org/apis/security/sanitizing/",
          idx + 1,
        ),
      );
    });

    return issues;
  },
};

// ── Rule 18: restricted PHP functions ────────────────────────────────────────
const restrictedFunction: ValidationRule = {
  id: "restricted-function",
  severity: "error",
  check(code) {
    const pattern = /\beval\s*\(|\bextract\s*\(|\bcreate_function\s*\(/;
    if (!pattern.test(code)) return [];
    return [
      issue(
        "restricted-function",
        "error",
        "Restricted PHP function — eval/extract/create_function are security risks and forbidden on WordPress VIP.",
        "eval(): refactor to use dynamic class instantiation. extract(): use explicit variable assignment. create_function(): use a closure.",
        "https://developer.wordpress.org/coding-standards/wordpress-coding-standards/php/",
        lineOf(code, pattern),
      ),
    ];
  },
};

// ── Rule 19: deprecated WordPress functions ───────────────────────────────────
const DEPRECATED_FUNCTIONS: Array<{ name: string; replacement: string }> = [
  { name: "clean_url", replacement: "esc_url()" },
  { name: "attribute_escape", replacement: "esc_attr()" },
  { name: "js_escape", replacement: "esc_js()" },
  { name: "get_currentuserinfo", replacement: "wp_get_current_user()" },
  { name: "wp_login", replacement: "wp_signon()" },
  { name: "graceful_fail", replacement: "wp_die()" },
  { name: "get_usernumposts", replacement: "count_user_posts()" },
  { name: "wp_setcookie", replacement: "wp_set_auth_cookie()" },
  { name: "dropdown_cats", replacement: "wp_dropdown_categories()" },
  { name: "get_postdata", replacement: "get_post()" },
  { name: "trackback_rdf", replacement: "(removed — no replacement)" },
];

const deprecatedFunctionUsage: ValidationRule = {
  id: "deprecated-function-usage",
  severity: "warning",
  check(code) {
    const issues: ValidationIssue[] = [];
    for (const { name, replacement } of DEPRECATED_FUNCTIONS) {
      const pattern = new RegExp(`\\b${name}\\s*\\(`, "g");
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(code)) !== null) {
        issues.push(
          issue(
            "deprecated-function-usage",
            "warning",
            `Deprecated WordPress function: ${name}() — use ${replacement} instead.`,
            `Replace ${name}() with ${replacement}.`,
            `https://developer.wordpress.org/reference/functions/${name}/`,
            code.slice(0, m.index).split("\n").length,
          ),
        );
      }
    }
    return issues;
  },
};

// ── Rule 20: raw string literal to $wpdb->query() ─────────────────────────────
const noDirectDbTablePrefix: ValidationRule = {
  id: "no-direct-db-table-prefix",
  severity: "error",
  check(code) {
    // Detect $wpdb->query( "..." or $wpdb->query( '...' directly
    const pattern = /\$wpdb->query\s*\(\s*["']/g;
    const issues: ValidationIssue[] = [];
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(code)) !== null) {
      issues.push(
        issue(
          "no-direct-db-table-prefix",
          "error",
          "Raw string passed to $wpdb->query() — always use $wpdb->prepare() to prevent SQL injection.",
          "Use: $wpdb->query( $wpdb->prepare( 'DELETE FROM %i WHERE id = %d', $table, $id ) )",
          "https://developer.wordpress.org/reference/classes/wpdb/prepare/",
          code.slice(0, m.index).split("\n").length,
        ),
      );
    }
    return issues;
  },
};

export const SecurityRules: ValidationRule[] = [
  missingNonceSavePost,
  missingNonceAjax,
  nonceCheckDisabled,
  restReturnTrue,
  missingPermissionCallback,
  noCapabilityCheck,
  sqlInjectionWpdb,
  sqlInjectionLike,
  echoSuperglobal,
  unescapedEcho,
  missingDoingAutosave,
  unserializeUserInput,
  postsPerPageUnlimited,
  directHeaderRedirect,
  redirectWithoutExit,
  requestSuperglobal,
  missingSanitizeInput,
  restrictedFunction,
  deprecatedFunctionUsage,
  noDirectDbTablePrefix,
];
