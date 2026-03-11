export interface HookChecklist {
  hook: string;
  requiredPatterns: string[];   // regex patterns that MUST be present
  checklist: string[];          // human-readable requirements
  example: string;              // complete correct PHP implementation
  antipatterns: string[];       // things NOT to do
}

export const HOOK_SECURITY_CHECKLISTS: Record<string, HookChecklist> = {

  save_post: {
    hook: "save_post",
    requiredPatterns: [
      "DOING_AUTOSAVE",
      "wp_is_post_revision",
      "wp_verify_nonce|check_admin_referer",
      "current_user_can",
      "get_post_type",
    ],
    checklist: [
      "Bail early if DOING_AUTOSAVE is defined and true",
      "Bail early if wp_is_post_revision() returns true",
      "Verify nonce with wp_verify_nonce() for your specific action",
      "Check current_user_can() for the appropriate capability",
      "Verify get_post_type() matches the expected post type before processing",
    ],
    example: `<?php
/**
 * Save post meta securely.
 *
 * @param int     $post_id The post ID.
 * @param WP_Post $post    The post object.
 */
function my_plugin_save_post_meta( int $post_id, WP_Post $post ): void {
    // 1. Skip autosaves — WordPress fires save_post every ~60 seconds automatically.
    if ( defined( 'DOING_AUTOSAVE' ) && DOING_AUTOSAVE ) {
        return;
    }

    // 2. Skip revisions — save_post fires for revision post types too.
    if ( wp_is_post_revision( $post_id ) ) {
        return;
    }

    // 3. Verify the nonce — prevents CSRF from other tabs or sites.
    $nonce = sanitize_text_field( wp_unslash( $_POST['my_plugin_nonce'] ?? '' ) );
    if ( ! wp_verify_nonce( $nonce, 'my_plugin_save_' . $post_id ) ) {
        return;
    }

    // 4. Check capability — ensure the current user can edit this post.
    if ( ! current_user_can( 'edit_post', $post_id ) ) {
        return;
    }

    // 5. Confirm this is our expected post type.
    if ( 'my_custom_post_type' !== get_post_type( $post_id ) ) {
        return;
    }

    // 6. Sanitize before saving — never trust $_POST values.
    $value = sanitize_text_field( wp_unslash( $_POST['my_meta_key'] ?? '' ) );
    update_post_meta( $post_id, 'my_meta_key', $value );
}
add_action( 'save_post', 'my_plugin_save_post_meta', 10, 2 );`,
    antipatterns: [
      "Saving $_POST data without sanitize_text_field() or absint()",
      "Omitting the nonce field in the meta box output",
      "Using nonce action strings that don't include the post ID (allows replay attacks)",
      "Calling update_post_meta() without checking current_user_can()",
      "Not bailing on DOING_AUTOSAVE (causes repeated writes every minute)",
    ],
  },

  wp_ajax_: {
    hook: "wp_ajax_",
    requiredPatterns: [
      "check_ajax_referer",
      "current_user_can",
      "wp_send_json_(success|error)",
    ],
    checklist: [
      "Verify nonce with check_ajax_referer() (die=true by default)",
      "Check current_user_can() for the required capability",
      "Respond with wp_send_json_success() or wp_send_json_error()",
    ],
    example: `<?php
/**
 * Handle a privileged AJAX request.
 * Registered via: add_action( 'wp_ajax_my_plugin_action', 'my_plugin_ajax_handler' );
 */
function my_plugin_ajax_handler(): void {
    // 1. Verify nonce — 'nonce' is the form field name, 'my_plugin_action' is the action.
    check_ajax_referer( 'my_plugin_action', 'nonce' );

    // 2. Capability check — confirm the user has permission.
    if ( ! current_user_can( 'edit_posts' ) ) {
        wp_send_json_error( [ 'message' => 'Insufficient permissions.' ], 403 );
    }

    // 3. Sanitize all inputs.
    $item_id = absint( $_POST['item_id'] ?? 0 );
    if ( $item_id <= 0 ) {
        wp_send_json_error( [ 'message' => 'Invalid item ID.' ], 400 );
    }

    // 4. Perform the action.
    $result = my_plugin_process_item( $item_id );

    // 5. Return structured JSON — always use wp_send_json_* (sets headers, calls exit).
    wp_send_json_success( [ 'processed' => $result ] );
}
add_action( 'wp_ajax_my_plugin_action', 'my_plugin_ajax_handler' );`,
    antipatterns: [
      "Using check_ajax_referer() with false as third argument (execution continues on failure)",
      "Echoing raw output instead of using wp_send_json_success/error",
      "Omitting exit after wp_send_json (not needed — it calls die() internally, but don't echo before it)",
      "Registering only wp_ajax_ (logged-in) when the handler should also work for guests",
    ],
  },

  "wp_ajax_nopriv_": {
    hook: "wp_ajax_nopriv_",
    requiredPatterns: [
      "check_ajax_referer",
      "wp_send_json_(success|error)",
    ],
    checklist: [
      "Nonce verification is still required for nopriv handlers (prevents CSRF from guests)",
      "Never perform write operations in nopriv handlers without a nonce",
      "Sanitize all inputs — no trust assumed for anonymous requests",
      "Return minimal data — avoid leaking private content to unauthenticated users",
    ],
    example: `<?php
/**
 * Handle a public (non-authenticated) AJAX request.
 * Registered via: add_action( 'wp_ajax_nopriv_my_public_action', 'my_plugin_public_ajax' );
 */
function my_plugin_public_ajax(): void {
    // 1. Nonce is still required even for non-logged-in users.
    check_ajax_referer( 'my_public_action_nonce', 'nonce' );

    // 2. Sanitize inputs — treat all data as untrusted.
    $search = sanitize_text_field( wp_unslash( $_POST['search'] ?? '' ) );
    if ( empty( $search ) ) {
        wp_send_json_error( [ 'message' => 'Search term required.' ], 400 );
    }

    // 3. Read-only operation — nopriv handlers must never mutate state without auth.
    $results = my_plugin_search_public_items( $search );

    // 4. Return only safe, public data.
    wp_send_json_success( [ 'items' => $results ] );
}
add_action( 'wp_ajax_nopriv_my_public_action', 'my_plugin_public_ajax' );`,
    antipatterns: [
      "Performing write operations (update_option, update_post_meta) in nopriv handlers",
      "Skipping nonce verification because the user is not logged in",
      "Returning private post content or user data to unauthenticated requests",
    ],
  },

  init: {
    hook: "init",
    requiredPatterns: [
      "wp_verify_nonce|check_admin_referer",
      "current_user_can",
    ],
    checklist: [
      "When processing form submissions in init, verify nonce first",
      "Check current_user_can() before performing any privileged action",
      "Use isset() to check for action parameters before processing",
    ],
    example: `<?php
/**
 * Process a front-end form submission hooked into init.
 */
function my_plugin_init_handler(): void {
    // Only process when our action parameter is present.
    if ( ! isset( $_POST['my_plugin_action'] ) ) {
        return;
    }

    // 1. Verify nonce before anything else.
    $nonce = sanitize_text_field( wp_unslash( $_POST['_wpnonce'] ?? '' ) );
    if ( ! wp_verify_nonce( $nonce, 'my_plugin_form_action' ) ) {
        wp_die( esc_html__( 'Security check failed.', 'my-plugin' ) );
    }

    // 2. Capability check.
    if ( ! current_user_can( 'edit_posts' ) ) {
        wp_die( esc_html__( 'Insufficient permissions.', 'my-plugin' ) );
    }

    // 3. Sanitize and process.
    $data = sanitize_text_field( wp_unslash( $_POST['data'] ?? '' ) );
    my_plugin_process( $data );

    // 4. Redirect after POST to prevent duplicate submissions.
    wp_safe_redirect( add_query_arg( 'updated', '1', wp_get_referer() ) );
    exit;
}
add_action( 'init', 'my_plugin_init_handler' );`,
    antipatterns: [
      "Processing POST data in init without nonce verification",
      "Not redirecting after a successful POST (duplicate submission on refresh)",
      "Running expensive operations in init on every page load — use conditional checks",
    ],
  },

  admin_init: {
    hook: "admin_init",
    requiredPatterns: [
      "wp_doing_ajax|is_admin",
      "check_admin_referer|wp_verify_nonce",
    ],
    checklist: [
      "Guard with wp_doing_ajax() check to avoid interference with AJAX requests",
      "Use check_admin_referer() for settings form submissions",
      "Verify current_user_can() before processing privileged actions",
    ],
    example: `<?php
/**
 * Handle settings form submission in wp-admin.
 */
function my_plugin_admin_init(): void {
    // 1. Skip AJAX requests — admin_init fires for every admin request including AJAX.
    if ( wp_doing_ajax() ) {
        return;
    }

    // 2. Only process our settings form submission.
    if ( ! isset( $_POST['my_plugin_settings_submit'] ) ) {
        return;
    }

    // 3. Verify nonce — check_admin_referer() combines nonce + referer checks.
    check_admin_referer( 'my_plugin_settings_action', 'my_plugin_nonce' );

    // 4. Capability check.
    if ( ! current_user_can( 'manage_options' ) ) {
        wp_die( esc_html__( 'Access denied.', 'my-plugin' ) );
    }

    // 5. Sanitize and save.
    $option = sanitize_text_field( wp_unslash( $_POST['my_option'] ?? '' ) );
    update_option( 'my_plugin_option', $option );

    // 6. Redirect back to settings page with success message.
    wp_safe_redirect( add_query_arg( 'settings-updated', 'true', admin_url( 'options-general.php?page=my-plugin' ) ) );
    exit;
}
add_action( 'admin_init', 'my_plugin_admin_init' );`,
    antipatterns: [
      "Not checking wp_doing_ajax() — causes admin_init logic to run during AJAX calls",
      "Using wp_redirect() instead of wp_safe_redirect() (allows open redirects)",
      "Forgetting exit after wp_safe_redirect()",
    ],
  },

  register_rest_route: {
    hook: "register_rest_route",
    requiredPatterns: [
      "permission_callback",
      "sanitize_callback|validate_callback",
    ],
    checklist: [
      "Always define permission_callback — omitting it defaults to open access in WP 5.5+",
      "Return WP_Error from permission_callback for auth failures (provides correct HTTP 401/403)",
      "Add sanitize_callback on each args parameter",
      "Add validate_callback to enforce arg types before your callback runs",
    ],
    example: `<?php
/**
 * Register a secure custom REST API endpoint.
 */
function my_plugin_register_routes(): void {
    register_rest_route(
        'my-plugin/v1',
        '/items/(?P<id>[\\d]+)',
        [
            'methods'             => WP_REST_Server::READABLE,
            'callback'            => 'my_plugin_get_item',
            // 1. permission_callback is required — return true only for authorized users.
            'permission_callback' => function ( WP_REST_Request $request ): bool {
                return current_user_can( 'read' );
            },
            'args' => [
                'id' => [
                    // 2. validate_callback rejects invalid types before your callback runs.
                    'validate_callback' => function ( $value ): bool {
                        return is_numeric( $value ) && (int) $value > 0;
                    },
                    // 3. sanitize_callback cleans the value after validation.
                    'sanitize_callback' => 'absint',
                    'required'          => true,
                    'description'       => 'The item ID.',
                ],
            ],
        ]
    );
}
add_action( 'rest_api_init', 'my_plugin_register_routes' );

/**
 * Route callback — input is already validated and sanitized.
 *
 * @param WP_REST_Request $request The REST request.
 * @return WP_REST_Response|WP_Error
 */
function my_plugin_get_item( WP_REST_Request $request ) {
    $id   = $request->get_param( 'id' ); // Already absint'd.
    $item = get_post( $id );

    if ( ! $item || 'publish' !== $item->post_status ) {
        return new WP_Error( 'not_found', __( 'Item not found.', 'my-plugin' ), [ 'status' => 404 ] );
    }

    return rest_ensure_response( [ 'id' => $item->ID, 'title' => $item->post_title ] );
}`,
    antipatterns: [
      "Using '__return_true' as permission_callback (publicly writable endpoint)",
      "Omitting permission_callback entirely (WP 5.5+ throws a notice AND defaults to open)",
      "Returning plain booleans from permission_callback instead of WP_Error for failures",
      "Trusting $request->get_param() without sanitize_callback or manual sanitization",
    ],
  },

  pre_get_posts: {
    hook: "pre_get_posts",
    requiredPatterns: [
      "is_main_query",
      "is_admin",
    ],
    checklist: [
      "Always check $query->is_main_query() to avoid modifying secondary queries",
      "Check ! is_admin() to avoid affecting wp-admin list tables",
      "Target specific query contexts (is_home(), is_search(), etc.) to limit scope",
    ],
    example: `<?php
/**
 * Modify the main query on the front end.
 *
 * @param WP_Query $query The WP_Query instance (passed by reference).
 */
function my_plugin_pre_get_posts( WP_Query $query ): void {
    // 1. Only modify the main query — leave secondary queries (nav menus, widgets) alone.
    if ( ! $query->is_main_query() ) {
        return;
    }

    // 2. Never modify admin queries — this would break post list tables.
    if ( is_admin() ) {
        return;
    }

    // 3. Target a specific context — only the blog archive in this case.
    if ( $query->is_home() ) {
        // Limit posts per page and exclude a specific category.
        $query->set( 'posts_per_page', 10 );
        $query->set( 'category__not_in', [ get_option( 'my_plugin_excluded_cat' ) ] );
    }
}
add_action( 'pre_get_posts', 'my_plugin_pre_get_posts' );`,
    antipatterns: [
      "Not checking is_main_query() — modifies widget queries, nav menu queries, etc.",
      "Not checking is_admin() — breaks wp-admin post list tables",
      "Using posts_per_page: -1 (returns all posts, causes memory exhaustion on large sites)",
      "Querying meta_query or tax_query with user-supplied values without sanitization",
    ],
  },

  template_redirect: {
    hook: "template_redirect",
    requiredPatterns: [
      "wp_safe_redirect",
      "exit",
    ],
    checklist: [
      "Use wp_safe_redirect() instead of header('Location:') for redirects",
      "Always call exit after wp_safe_redirect()",
      "Use esc_url_raw() on redirect URLs built from user input",
    ],
    example: `<?php
/**
 * Redirect users based on a condition at template selection time.
 */
function my_plugin_template_redirect(): void {
    // Only act on a specific page.
    if ( ! is_page( 'members-only' ) ) {
        return;
    }

    // Redirect non-logged-in users to the login page.
    if ( ! is_user_logged_in() ) {
        // 1. wp_safe_redirect() validates the host — prevents open redirect attacks.
        wp_safe_redirect( esc_url_raw( wp_login_url( get_permalink() ) ) );
        // 2. Always exit after redirect — PHP execution continues otherwise.
        exit;
    }

    // Redirect users without the required capability.
    if ( ! current_user_can( 'read_premium_content' ) ) {
        wp_safe_redirect( esc_url_raw( home_url( '/upgrade/' ) ) );
        exit;
    }
}
add_action( 'template_redirect', 'my_plugin_template_redirect' );`,
    antipatterns: [
      "Using header('Location: ' . $url) — bypasses WordPress redirect safety checks",
      "Forgetting exit after wp_safe_redirect() — template loads and redirect headers are sent",
      "Using wp_redirect() with an arbitrary URL from user input (open redirect)",
      "Redirecting in template_redirect without checking which page/archive you're on",
    ],
  },

  admin_post_: {
    hook: "admin_post_",
    requiredPatterns: [
      "check_admin_referer",
      "current_user_can",
      "wp_safe_redirect",
    ],
    checklist: [
      "Use check_admin_referer() to verify nonce and referrer",
      "Check current_user_can() before performing any action",
      "Redirect with wp_safe_redirect() + exit after processing (PRG pattern)",
    ],
    example: `<?php
/**
 * Handle a wp-admin form submission.
 * Form action: admin_url( 'admin-post.php' ) with hidden input name="action" value="my_plugin_action"
 * Registered via: add_action( 'admin_post_my_plugin_action', 'my_plugin_handle_action' );
 */
function my_plugin_handle_action(): void {
    // 1. Verify nonce and referrer — check_admin_referer() dies on failure.
    check_admin_referer( 'my_plugin_action_nonce', 'my_plugin_nonce_field' );

    // 2. Capability check.
    if ( ! current_user_can( 'manage_options' ) ) {
        wp_die( esc_html__( 'You do not have permission to perform this action.', 'my-plugin' ), 403 );
    }

    // 3. Sanitize all inputs.
    $item_id = absint( $_POST['item_id'] ?? 0 );
    $note    = sanitize_textarea_field( wp_unslash( $_POST['note'] ?? '' ) );

    if ( $item_id <= 0 ) {
        wp_die( esc_html__( 'Invalid item.', 'my-plugin' ) );
    }

    // 4. Perform the action.
    update_post_meta( $item_id, '_my_plugin_note', $note );

    // 5. Redirect back — PRG (Post/Redirect/Get) pattern prevents double-submission.
    wp_safe_redirect( add_query_arg( 'updated', '1', admin_url( 'tools.php?page=my-plugin' ) ) );
    exit;
}
add_action( 'admin_post_my_plugin_action', 'my_plugin_handle_action' );`,
    antipatterns: [
      "Skipping check_admin_referer() because the form has a nonce field (still need to check it)",
      "Using wp_redirect() instead of wp_safe_redirect() (allows open redirects)",
      "Not calling exit after redirect — remaining code executes and produces output",
      "Storing raw $_POST data without sanitization",
    ],
  },

  user_register: {
    hook: "user_register",
    requiredPatterns: [
      "sanitize_",
      "current_user_can",
    ],
    checklist: [
      "Sanitize all user meta before saving with sanitize_text_field(), sanitize_email(), etc.",
      "Check current_user_can() before assigning roles or capabilities",
      "Never trust $_POST data inside user_register — always sanitize",
    ],
    example: `<?php
/**
 * Save extra user profile fields on registration.
 *
 * @param int $user_id The newly registered user's ID.
 */
function my_plugin_user_register( int $user_id ): void {
    // 1. Sanitize all user-supplied data before saving.
    $phone = sanitize_text_field( wp_unslash( $_POST['phone'] ?? '' ) );
    $bio   = sanitize_textarea_field( wp_unslash( $_POST['bio'] ?? '' ) );

    if ( ! empty( $phone ) ) {
        update_user_meta( $user_id, 'phone', $phone );
    }

    if ( ! empty( $bio ) ) {
        update_user_meta( $user_id, 'description', $bio );
    }

    // 2. Never assign roles based on user input without a capability check.
    // Only administrators can promote users to a higher role.
    $requested_role = sanitize_key( $_POST['role'] ?? 'subscriber' );
    $allowed_roles  = [ 'subscriber', 'contributor' ]; // Roles anyone can register as.

    if ( in_array( $requested_role, $allowed_roles, true ) ) {
        $user = new WP_User( $user_id );
        $user->set_role( $requested_role );
    }

    // Privilege escalation guard — admin role requires existing admin action.
    if ( 'administrator' === $requested_role && ! current_user_can( 'manage_options' ) ) {
        // Silently ignore the escalation attempt.
        return;
    }
}
add_action( 'user_register', 'my_plugin_user_register' );`,
    antipatterns: [
      "Setting user role directly from $_POST['role'] without validating against an allowlist",
      "Saving raw $_POST data to user meta without sanitization",
      "Allowing 'administrator' or other elevated roles to be self-assigned on registration",
      "Not checking current_user_can() when assigning capabilities",
    ],
  },
};
