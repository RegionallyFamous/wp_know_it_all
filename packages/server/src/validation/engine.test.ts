import { describe, it, expect } from "vitest";
import { validateWordPressCode } from "./engine.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function hasRule(issues: { rule: string }[], ruleId: string): boolean {
  return issues.some((i) => i.rule === ruleId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Security rules
// ─────────────────────────────────────────────────────────────────────────────
describe("validateWordPressCode", () => {
  describe("security rules", () => {
    it("flags missing nonce in save_post handler", () => {
      const code = `<?php
add_action( 'save_post', function( $post_id ) {
    update_post_meta( $post_id, '_my_key', sanitize_text_field( $_POST['my_key'] ?? '' ) );
} );`;
      const result = validateWordPressCode(code);
      expect(hasRule(result.issues, "missing-nonce-save-post")).toBe(true);
      expect(result.passed).toBe(false);
    });

    it("does NOT flag save_post handler that has wp_verify_nonce", () => {
      const code = `<?php
add_action( 'save_post', function( $post_id ) {
    if ( ! wp_verify_nonce( $_POST['_wpnonce'] ?? '', 'save_post_' . $post_id ) ) return;
    if ( defined( 'DOING_AUTOSAVE' ) && DOING_AUTOSAVE ) return;
    if ( ! current_user_can( 'edit_post', $post_id ) ) return;
    update_post_meta( $post_id, '_my_key', sanitize_text_field( $_POST['my_key'] ?? '' ) );
} );`;
      const result = validateWordPressCode(code);
      expect(hasRule(result.issues, "missing-nonce-save-post")).toBe(false);
    });

    it("flags missing nonce in AJAX handler", () => {
      const code = `<?php
add_action( 'wp_ajax_my_action', function() {
    $id = absint( $_POST['id'] ?? 0 );
    wp_send_json_success( [ 'id' => $id ] );
} );`;
      const result = validateWordPressCode(code);
      expect(hasRule(result.issues, "missing-nonce-ajax")).toBe(true);
      expect(result.passed).toBe(false);
    });

    it("does NOT flag AJAX handler with check_ajax_referer", () => {
      const code = `<?php
add_action( 'wp_ajax_my_action', function() {
    check_ajax_referer( 'my_action', 'nonce' );
    if ( ! current_user_can( 'edit_posts' ) ) {
        wp_send_json_error( [], 403 );
    }
    wp_send_json_success( [] );
} );`;
      const result = validateWordPressCode(code);
      expect(hasRule(result.issues, "missing-nonce-ajax")).toBe(false);
    });

    it("flags unescaped echo of superglobal", () => {
      const code = `<?php
echo $_GET['search'];`;
      const result = validateWordPressCode(code);
      expect(hasRule(result.issues, "echo-superglobal")).toBe(true);
      expect(result.passed).toBe(false);
      const issue = result.issues.find((i) => i.rule === "echo-superglobal")!;
      expect(issue.severity).toBe("error");
    });

    it("flags sql injection via direct $wpdb->query string literal", () => {
      const code = `<?php
global $wpdb;
$wpdb->query( "DELETE FROM {$wpdb->prefix}my_table WHERE id = $id" );`;
      const result = validateWordPressCode(code);
      expect(hasRule(result.issues, "no-direct-db-table-prefix")).toBe(true);
      expect(result.passed).toBe(false);
    });

    it("does NOT flag $wpdb->query wrapped in prepare()", () => {
      const code = `<?php
global $wpdb;
$wpdb->query( $wpdb->prepare( 'DELETE FROM %i WHERE id = %d', $table, $id ) );`;
      const result = validateWordPressCode(code);
      expect(hasRule(result.issues, "sql-injection-wpdb")).toBe(false);
      expect(hasRule(result.issues, "no-direct-db-table-prefix")).toBe(false);
    });

    it("flags unserialize with user input (superglobal)", () => {
      const code = `<?php
$data = unserialize( $_POST['data'] );`;
      const result = validateWordPressCode(code);
      expect(hasRule(result.issues, "unserialize-user-input")).toBe(true);
      expect(result.passed).toBe(false);
    });

    it("flags unserialize with get_option", () => {
      const code = `<?php
$data = unserialize( get_option( 'my_serialized_data' ) );`;
      const result = validateWordPressCode(code);
      expect(hasRule(result.issues, "unserialize-user-input")).toBe(true);
    });

    it("flags wp_redirect without exit", () => {
      const code = `<?php
function my_redirect() {
    wp_redirect( home_url( '/destination/' ) );
    // Forgot exit here — execution continues
    do_something_else();
}`;
      const result = validateWordPressCode(code);
      expect(hasRule(result.issues, "redirect-without-exit")).toBe(true);
      expect(result.passed).toBe(false);
    });

    it("does NOT flag wp_safe_redirect with exit", () => {
      const code = `<?php
wp_safe_redirect( esc_url_raw( $url ) );
exit;`;
      const result = validateWordPressCode(code);
      expect(hasRule(result.issues, "redirect-without-exit")).toBe(false);
    });

    it("detects deprecated functions — clean_url", () => {
      const code = `<?php
$url = clean_url( $raw_url );`;
      const result = validateWordPressCode(code);
      expect(hasRule(result.issues, "deprecated-function-usage")).toBe(true);
      const issue = result.issues.find(
        (i) => i.rule === "deprecated-function-usage",
      )!;
      expect(issue.message).toContain("clean_url");
      expect(issue.severity).toBe("warning");
    });

    it("detects deprecated functions — attribute_escape", () => {
      const code = `<?php
echo attribute_escape( $value );`;
      const result = validateWordPressCode(code);
      expect(hasRule(result.issues, "deprecated-function-usage")).toBe(true);
    });

    it("flags check_ajax_referer with die=false", () => {
      const code = `<?php
check_ajax_referer( 'my_action', 'nonce', false );`;
      const result = validateWordPressCode(code);
      expect(hasRule(result.issues, "nonce-check-disabled")).toBe(true);
    });

    it("flags REST route with __return_true permission_callback", () => {
      const code = `<?php
register_rest_route( 'my-plugin/v1', '/items', [
    'methods'             => 'GET',
    'callback'            => 'my_callback',
    'permission_callback' => '__return_true',
] );`;
      const result = validateWordPressCode(code);
      expect(hasRule(result.issues, "rest-return-true")).toBe(true);
      expect(result.passed).toBe(false);
    });

    it("flags register_rest_route without any permission_callback", () => {
      const code = `<?php
register_rest_route( 'my-plugin/v1', '/items', [
    'methods'  => 'GET',
    'callback' => 'my_callback',
] );`;
      const result = validateWordPressCode(code);
      expect(hasRule(result.issues, "missing-permission-callback")).toBe(true);
    });

    it("flags posts_per_page -1", () => {
      const code = `<?php
$query = new WP_Query( [
    'post_type'      => 'post',
    'posts_per_page' => -1,
] );`;
      const result = validateWordPressCode(code);
      expect(hasRule(result.issues, "posts-per-page-unlimited")).toBe(true);
    });

    it("flags eval() as restricted function", () => {
      const code = `<?php
eval( '$result = ' . $user_input . ';' );`;
      const result = validateWordPressCode(code);
      expect(hasRule(result.issues, "restricted-function")).toBe(true);
      expect(result.passed).toBe(false);
    });

    it("flags missing sanitize on update_post_meta with $_POST", () => {
      const code = `<?php
update_post_meta( $post_id, 'my_key', $_POST['value'] );`;
      const result = validateWordPressCode(code);
      expect(hasRule(result.issues, "missing-sanitize-input")).toBe(true);
    });

    it("does NOT flag update_post_meta when sanitize_ is called", () => {
      const code = `<?php
update_post_meta( $post_id, 'my_key', sanitize_text_field( $_POST['value'] ?? '' ) );`;
      const result = validateWordPressCode(code);
      expect(hasRule(result.issues, "missing-sanitize-input")).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Standards rules
  // ─────────────────────────────────────────────────────────────────────────
  describe("standards rules", () => {
    it("flags PHP short open tags", () => {
      const code = `<? echo 'Hello'; ?>`;
      const result = validateWordPressCode(code);
      expect(hasRule(result.issues, "php-short-tags")).toBe(true);
      expect(result.passed).toBe(false);
    });

    it("does NOT flag <?php or <?= tags", () => {
      const code = `<?php echo 'Hello'; ?> <?= $var ?>`;
      const result = validateWordPressCode(code);
      expect(hasRule(result.issues, "php-short-tags")).toBe(false);
    });

    it("flags hardcoded credentials", () => {
      const code = `<?php
$password = 'super_secret_123';`;
      const result = validateWordPressCode(code);
      expect(hasRule(result.issues, "hardcoded-credentials")).toBe(true);
    });

    it("flags missing ABSPATH guard on plugin file", () => {
      const code = `<?php
add_action( 'init', 'my_plugin_init' );
function my_plugin_init() {
    // do stuff
}`;
      const result = validateWordPressCode(code);
      expect(hasRule(result.issues, "direct-file-access")).toBe(true);
    });

    it("does NOT flag file with ABSPATH check", () => {
      const code = `<?php
if ( ! defined( 'ABSPATH' ) ) exit;
add_action( 'init', 'my_plugin_init' );`;
      const result = validateWordPressCode(code);
      expect(hasRule(result.issues, "direct-file-access")).toBe(false);
    });

    it("flags bare die() instead of wp_die()", () => {
      const code = `<?php
if ( ! $valid ) {
    die( 'Error' );
}`;
      const result = validateWordPressCode(code);
      expect(hasRule(result.issues, "wp-die-not-die")).toBe(true);
    });

    it("does NOT flag exit after wp_safe_redirect", () => {
      const code = `<?php
wp_safe_redirect( $url );
exit;`;
      const result = validateWordPressCode(code);
      expect(hasRule(result.issues, "wp-die-not-die")).toBe(false);
    });

    it("flags $_REQUEST usage", () => {
      const code = `<?php
$value = $_REQUEST['key'];`;
      const result = validateWordPressCode(code);
      expect(hasRule(result.issues, "request-superglobal")).toBe(true);
    });

    it("flags ORDER BY with superglobal", () => {
      const code = `<?php
$sql = "SELECT * FROM {$wpdb->prefix}my_table ORDER BY " . $_GET['orderby'];`;
      const result = validateWordPressCode(code);
      expect(hasRule(result.issues, "no-orderby-superglobal")).toBe(true);
      expect(result.passed).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Score calculation
  // ─────────────────────────────────────────────────────────────────────────
  describe("score calculation", () => {
    it("returns 100 for perfectly clean code", () => {
      const code = `<?php
if ( ! defined( 'ABSPATH' ) ) exit;
add_action( 'init', 'my_safe_init' );
function my_safe_init() {
    // Nothing risky here
}`;
      const result = validateWordPressCode(code);
      expect(result.score).toBe(100);
      expect(result.passed).toBe(true);
      expect(result.summary).toBe("no issues");
    });

    it("reduces score by 15 per error", () => {
      // Two distinct errors: echo superglobal + unserialize
      const code = `<?php
echo $_GET['q'];
$data = unserialize( $_POST['payload'] );`;
      const result = validateWordPressCode(code);
      const errors = result.issues.filter((i) => i.severity === "error").length;
      expect(errors).toBeGreaterThanOrEqual(2);
      // Score = 100 - (errors * 15) - (warnings * 5) - (infos * 1), min 0
      const expectedBase = 100 - errors * 15;
      const warnings = result.issues.filter(
        (i) => i.severity === "warning",
      ).length;
      const infos = result.issues.filter((i) => i.severity === "info").length;
      const expected = Math.max(
        0,
        expectedBase - warnings * 5 - infos * 1,
      );
      expect(result.score).toBe(expected);
    });

    it("score never goes below 0", () => {
      // Code with many errors
      const code = `<?php
echo $_GET['q'];
eval( $code );
$data = unserialize( $_POST['payload'] );
add_action( 'wp_ajax_do_thing', function() {
    update_post_meta( 1, 'k', $_POST['v'] );
} );
add_action( 'save_post', function() {
    update_option( 'x', $_POST['x'] );
} );
register_rest_route( 'x/v1', '/y', [ 'callback' => 'fn' ] );
$wpdb->query( "DELETE FROM wp_options WHERE 1=1" );`;
      const result = validateWordPressCode(code);
      expect(result.score).toBeGreaterThanOrEqual(0);
    });

    it("summary reflects issue counts correctly", () => {
      const code = `<?php
echo $_GET['q'];`;
      const result = validateWordPressCode(code);
      expect(result.summary).toMatch(/error/);
    });

    it("passed is true when there are only warnings/info, no errors", () => {
      const code = `<?php
if ( ! defined( 'ABSPATH' ) ) exit;
// Just trigger a warning: posts_per_page -1
$query = new WP_Query( [ 'posts_per_page' => -1 ] );`;
      const result = validateWordPressCode(code);
      expect(result.passed).toBe(true);
      expect(hasRule(result.issues, "posts-per-page-unlimited")).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Issue shape
  // ─────────────────────────────────────────────────────────────────────────
  describe("issue shape", () => {
    it("every issue has required fields", () => {
      const code = `<?php
echo $_POST['name'];
eval( $code );`;
      const result = validateWordPressCode(code);
      for (const issue of result.issues) {
        expect(issue.severity).toMatch(/^(error|warning|info)$/);
        expect(typeof issue.rule).toBe("string");
        expect(issue.rule.length).toBeGreaterThan(0);
        expect(typeof issue.message).toBe("string");
        expect(typeof issue.fix).toBe("string");
        expect(typeof issue.docs_url).toBe("string");
        expect(issue.docs_url).toMatch(/^https?:\/\//);
      }
    });

    it("line numbers are positive integers when present", () => {
      const code = `<?php
echo $_GET['q'];`;
      const result = validateWordPressCode(code);
      for (const issue of result.issues) {
        if (issue.line !== undefined) {
          expect(issue.line).toBeGreaterThan(0);
          expect(Number.isInteger(issue.line)).toBe(true);
        }
      }
    });
  });
});
