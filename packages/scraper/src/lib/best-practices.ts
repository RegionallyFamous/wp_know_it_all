import type { InsertableDocument } from "../db/writer.js";

function strip(markdown: string): string {
  return markdown.replace(/```php\n?|```\n?/g, "").trim();
}

function doc(
  slug: string,
  title: string,
  category: string,
  since_version: string,
  content_markdown: string
): InsertableDocument {
  return {
    url: `https://developer.wordpress.org/best-practices/${slug}/`,
    slug: `best-practice-${slug}`,
    title,
    doc_type: "example",
    source: "curated",
    category,
    signature: null,
    since_version,
    parent_id: null,
    content_markdown,
    content_plain: strip(content_markdown),
    functions_mentioned: null,
    hooks_mentioned: null,
    metadata: null,
  };
}

export function getCuratedBestPractices(): InsertableDocument[] {
  return [
    // ─────────────────────────────────────────────────────────────────────────
    // 1. Enqueue scripts and styles
    // ─────────────────────────────────────────────────────────────────────────
    doc(
      "enqueue-scripts-styles",
      "Enqueue Scripts and Styles Correctly",
      "assets",
      "2.6.0",
      `# Enqueue Scripts and Styles Correctly

Always use the \`wp_enqueue_scripts\` hook — never print \`<script>\` or \`<link>\` tags
directly. This lets WordPress manage dependencies, deduplication, and load order.

\`\`\`php
<?php
add_action( 'wp_enqueue_scripts', 'myplugin_enqueue_assets' );

function myplugin_enqueue_assets(): void {
    // Register first so other code can depend on it without enqueuing immediately.
    wp_register_style(
        'myplugin-style',                          // handle — must be unique
        plugin_dir_url( __FILE__ ) . 'css/main.css',
        [],                                        // no CSS dependencies
        '1.2.0'                                    // cache-bust version string
    );

    // Only load the stylesheet on single posts — conditional loading reduces
    // page weight on every other template.
    if ( is_single() ) {
        wp_enqueue_style( 'myplugin-style' );
    }

    wp_enqueue_script(
        'myplugin-script',
        plugin_dir_url( __FILE__ ) . 'js/main.js',
        [ 'jquery' ],                              // declare jQuery as a dependency
        '1.2.0',
        [
            'strategy' => 'defer',                 // HTML5 defer — non-blocking load
            'in_footer' => true,                   // keep scripts out of <head>
        ]
    );
}
\`\`\`
`
    ),

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Register custom post type
    // ─────────────────────────────────────────────────────────────────────────
    doc(
      "register-custom-post-type",
      "Register a Custom Post Type with REST API Support",
      "post-types",
      "5.0.0",
      `# Register a Custom Post Type with REST API Support

Call \`register_post_type()\` inside the \`init\` hook. Setting \`show_in_rest => true\`
enables the Gutenberg editor and exposes the type via the REST API at
\`/wp-json/wp/v2/{rest_base}\`.

\`\`\`php
<?php
add_action( 'init', 'myplugin_register_book_post_type' );

function myplugin_register_book_post_type(): void {
    $labels = [
        'name'               => _x( 'Books', 'post type general name', 'myplugin' ),
        'singular_name'      => _x( 'Book', 'post type singular name', 'myplugin' ),
        'add_new_item'       => __( 'Add New Book', 'myplugin' ),
        'edit_item'          => __( 'Edit Book', 'myplugin' ),
        'view_item'          => __( 'View Book', 'myplugin' ),
        'search_items'       => __( 'Search Books', 'myplugin' ),
        'not_found'          => __( 'No books found.', 'myplugin' ),
        'not_found_in_trash' => __( 'No books found in Trash.', 'myplugin' ),
    ];

    register_post_type(
        'book',
        [
            'labels'              => $labels,
            'public'              => true,
            'hierarchical'        => false,
            'supports'            => [ 'title', 'editor', 'thumbnail', 'excerpt', 'custom-fields' ],
            'taxonomies'          => [ 'category', 'post_tag' ],
            'has_archive'         => true,       // enables /books/ archive URL
            'rewrite'             => [ 'slug' => 'books', 'with_front' => false ],
            'show_in_rest'        => true,       // required for Gutenberg + REST API
            'rest_base'           => 'books',    // /wp-json/wp/v2/books
            'rest_controller_class' => 'WP_REST_Posts_Controller',
            'menu_icon'           => 'dashicons-book-alt',
            'capability_type'     => 'post',
        ]
    );
}
\`\`\`
`
    ),

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Save post meta securely
    // ─────────────────────────────────────────────────────────────────────────
    doc(
      "save-post-meta-securely",
      "Save Post Meta Securely",
      "security",
      "1.5.0",
      `# Save Post Meta Securely

A \`save_post\` handler must pass five guards before touching the database:
1. Nonce verification (CSRF protection)
2. Autosave bail-out (prevent half-written data)
3. Capability check (the user must be allowed to edit this post)
4. Correct post type (only run for the intended CPT)
5. Sanitization (never trust raw user input)

\`\`\`php
<?php
add_action( 'save_post_book', 'myplugin_save_book_meta' );

function myplugin_save_book_meta( int $post_id ): void {
    // 1. Verify the nonce that was output in the meta box.
    if (
        ! isset( $_POST['myplugin_book_nonce'] ) ||
        ! wp_verify_nonce( sanitize_key( $_POST['myplugin_book_nonce'] ), 'myplugin_save_book_' . $post_id )
    ) {
        return;
    }

    // 2. Skip autosaves — WordPress fires save_post during autosave too.
    if ( defined( 'DOING_AUTOSAVE' ) && DOING_AUTOSAVE ) {
        return;
    }

    // 3. Check the current user can edit this specific post.
    if ( ! current_user_can( 'edit_post', $post_id ) ) {
        return;
    }

    // 4. The hook suffix already limits us to 'book' posts, but be explicit
    //    if using the generic save_post hook instead.

    // 5. Sanitize: strip HTML, cast to expected type, validate range.
    $isbn = isset( $_POST['myplugin_isbn'] )
        ? sanitize_text_field( wp_unslash( $_POST['myplugin_isbn'] ) )
        : '';

    $page_count = isset( $_POST['myplugin_page_count'] )
        ? absint( $_POST['myplugin_page_count'] )
        : 0;

    // Persist — use update_post_meta which handles insert-or-update transparently.
    update_post_meta( $post_id, '_myplugin_isbn', $isbn );
    update_post_meta( $post_id, '_myplugin_page_count', $page_count );
}
\`\`\`
`
    ),

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Handle AJAX securely
    // ─────────────────────────────────────────────────────────────────────────
    doc(
      "handle-ajax-securely",
      "Handle AJAX Securely with Nonces",
      "security",
      "2.8.0",
      `# Handle AJAX Securely with Nonces

WordPress routes all AJAX to \`wp-admin/admin-ajax.php\`. Hooks prefixed
\`wp_ajax_\` run only for logged-in users; \`wp_ajax_nopriv_\` also runs for
guests. Always verify a nonce and check capabilities before processing.

\`\`\`php
<?php
// ── Enqueue the nonce so JavaScript can send it ──────────────────────────────
add_action( 'wp_enqueue_scripts', 'myplugin_enqueue_ajax_script' );

function myplugin_enqueue_ajax_script(): void {
    wp_enqueue_script(
        'myplugin-ajax',
        plugin_dir_url( __FILE__ ) . 'js/ajax.js',
        [ 'jquery' ],
        '1.0.0',
        [ 'in_footer' => true ]
    );

    // wp_localize_script makes PHP values available as window.mypluginAjax.
    wp_localize_script( 'myplugin-ajax', 'mypluginAjax', [
        'ajaxUrl' => admin_url( 'admin-ajax.php' ),
        'nonce'   => wp_create_nonce( 'myplugin_do_thing' ),
    ] );
}

// ── AJAX handler (logged-in users only) ──────────────────────────────────────
add_action( 'wp_ajax_myplugin_do_thing', 'myplugin_ajax_do_thing' );

function myplugin_ajax_do_thing(): void {
    // 1. Verify nonce — wp_verify_nonce returns false or the tick number.
    if ( ! check_ajax_referer( 'myplugin_do_thing', 'nonce', false ) ) {
        wp_send_json_error( [ 'message' => 'Invalid nonce.' ], 403 );
    }

    // 2. Capability check.
    if ( ! current_user_can( 'edit_posts' ) ) {
        wp_send_json_error( [ 'message' => 'Insufficient permissions.' ], 403 );
    }

    // 3. Sanitize input.
    $item_id = isset( $_POST['item_id'] ) ? absint( $_POST['item_id'] ) : 0;
    if ( $item_id <= 0 ) {
        wp_send_json_error( [ 'message' => 'Invalid item ID.' ], 400 );
    }

    // 4. Do work…
    $result = [ 'id' => $item_id, 'processed' => true ];

    // 5. wp_send_json_success automatically sets Content-Type and calls die().
    wp_send_json_success( $result );
}
\`\`\`
`
    ),

    // ─────────────────────────────────────────────────────────────────────────
    // 5. Register a REST API endpoint
    // ─────────────────────────────────────────────────────────────────────────
    doc(
      "register-rest-api-endpoint",
      "Register a REST API Endpoint with Proper Authentication",
      "rest-api",
      "4.7.0",
      `# Register a REST API Endpoint with Proper Authentication

Use \`register_rest_route()\` inside the \`rest_api_init\` hook. Always provide a
\`permission_callback\` — returning \`__return_true\` is intentional for public
endpoints, but must be explicit to avoid a deprecation notice.

\`\`\`php
<?php
add_action( 'rest_api_init', 'myplugin_register_rest_routes' );

function myplugin_register_rest_routes(): void {
    register_rest_route(
        'myplugin/v1',      // namespace: plugin-slug/version
        '/books/(?P<id>\\d+)',  // route: named capture group <id>
        [
            [
                'methods'             => WP_REST_Server::READABLE, // GET
                'callback'            => 'myplugin_get_book',
                'permission_callback' => '__return_true',          // public read
                'args'                => [
                    'id' => [
                        'validate_callback' => fn( $v ) => is_numeric( $v ),
                        'sanitize_callback' => 'absint',
                        'required'          => true,
                    ],
                ],
            ],
            [
                'methods'             => WP_REST_Server::EDITABLE, // POST/PUT/PATCH
                'callback'            => 'myplugin_update_book',
                'permission_callback' => fn() => current_user_can( 'edit_posts' ),
                'args'                => [
                    'id'    => [
                        'sanitize_callback' => 'absint',
                        'required'          => true,
                    ],
                    'title' => [
                        'sanitize_callback' => 'sanitize_text_field',
                        'required'          => true,
                    ],
                ],
            ],
        ]
    );
}

function myplugin_get_book( WP_REST_Request $request ): WP_REST_Response|WP_Error {
    $id   = $request->get_param( 'id' ); // already sanitized by args above
    $post = get_post( $id );

    if ( ! $post || 'book' !== $post->post_type ) {
        return new WP_Error( 'book_not_found', __( 'Book not found.', 'myplugin' ), [ 'status' => 404 ] );
    }

    return new WP_REST_Response(
        [
            'id'    => $post->ID,
            'title' => $post->post_title,
            'slug'  => $post->post_name,
        ],
        200
    );
}

function myplugin_update_book( WP_REST_Request $request ): WP_REST_Response|WP_Error {
    $id    = $request->get_param( 'id' );
    $title = $request->get_param( 'title' );

    $updated = wp_update_post( [ 'ID' => $id, 'post_title' => $title ], true );

    if ( is_wp_error( $updated ) ) {
        return $updated;
    }

    return new WP_REST_Response( [ 'id' => $updated ], 200 );
}
\`\`\`
`
    ),

    // ─────────────────────────────────────────────────────────────────────────
    // 6. Settings page with Settings API
    // ─────────────────────────────────────────────────────────────────────────
    doc(
      "settings-page-settings-api",
      "Create a Settings Page with the Settings API",
      "admin",
      "2.7.0",
      `# Create a Settings Page with the Settings API

The Settings API handles nonce generation, option sanitization dispatch, and
the settings-updated notice automatically. Never build a settings form by hand
with \`$_POST\` processing.

\`\`\`php
<?php
add_action( 'admin_menu',  'myplugin_add_settings_page' );
add_action( 'admin_init',  'myplugin_register_settings' );

function myplugin_add_settings_page(): void {
    add_options_page(
        __( 'My Plugin Settings', 'myplugin' ), // page <title>
        __( 'My Plugin', 'myplugin' ),           // menu label
        'manage_options',                         // required capability
        'myplugin-settings',                      // menu slug
        'myplugin_render_settings_page'
    );
}

function myplugin_register_settings(): void {
    // register_setting stores sanitized values in wp_options automatically.
    register_setting(
        'myplugin_options_group',   // option group
        'myplugin_options',         // option name in wp_options
        [
            'type'              => 'array',
            'sanitize_callback' => 'myplugin_sanitize_options',
            'default'           => [ 'api_key' => '', 'enabled' => false ],
        ]
    );

    add_settings_section(
        'myplugin_general_section',
        __( 'General Settings', 'myplugin' ),
        '__return_false',           // no section description needed
        'myplugin-settings'
    );

    add_settings_field(
        'myplugin_api_key',
        __( 'API Key', 'myplugin' ),
        'myplugin_render_api_key_field',
        'myplugin-settings',
        'myplugin_general_section'
    );
}

function myplugin_sanitize_options( mixed $input ): array {
    $clean = [];
    $clean['api_key'] = isset( $input['api_key'] )
        ? sanitize_text_field( $input['api_key'] )
        : '';
    $clean['enabled'] = ! empty( $input['enabled'] );
    return $clean;
}

function myplugin_render_api_key_field(): void {
    $options = get_option( 'myplugin_options', [ 'api_key' => '' ] );
    $api_key = esc_attr( $options['api_key'] ?? '' );
    echo '<input type="text" name="myplugin_options[api_key]" value="' . $api_key . '" class="regular-text" />';
}

function myplugin_render_settings_page(): void {
    // Capability check even though add_options_page already guards the menu.
    if ( ! current_user_can( 'manage_options' ) ) {
        return;
    }
    ?>
    <div class="wrap">
        <h1><?php echo esc_html( get_admin_page_title() ); ?></h1>
        <form method="post" action="options.php">
            <?php
            settings_fields( 'myplugin_options_group' ); // outputs nonce + action fields
            do_settings_sections( 'myplugin-settings' );
            submit_button();
            ?>
        </form>
    </div>
    <?php
}
\`\`\`
`
    ),

    // ─────────────────────────────────────────────────────────────────────────
    // 7. Custom Gutenberg block
    // ─────────────────────────────────────────────────────────────────────────
    doc(
      "custom-gutenberg-block",
      "Create a Custom Gutenberg Block",
      "blocks",
      "5.0.0",
      `# Create a Custom Gutenberg Block

The modern approach uses a \`block.json\` manifest and \`register_block_type()\`
pointing at the compiled build folder. WordPress auto-enqueues the editor and
front-end assets declared in block.json.

\`\`\`php
<?php
// In your plugin's main file:
add_action( 'init', 'myplugin_register_blocks' );

function myplugin_register_blocks(): void {
    // register_block_type reads block.json from the given directory and
    // registers editor/front-end scripts and styles automatically.
    register_block_type( __DIR__ . '/build/my-block' );
}
\`\`\`

\`block.json\` (at \`src/my-block/block.json\`, compiled to \`build/my-block/\`):

\`\`\`php
<?php
/*
{
    "$schema": "https://schemas.wp.org/trunk/block.json",
    "apiVersion": 3,
    "name": "myplugin/my-block",
    "title": "My Block",
    "category": "text",
    "description": "A simple block example.",
    "version": "1.0.0",
    "textdomain": "myplugin",
    "attributes": {
        "message": {
            "type": "string",
            "default": "Hello, world!"
        }
    },
    "supports": {
        "html": false,
        "color": { "background": true, "text": true },
        "spacing": { "padding": true }
    },
    "editorScript": "file:./index.js",
    "style":        "file:./style-index.css",
    "editorStyle":  "file:./index.css",
    "render":       "file:./render.php"
}
*/

// render.php — server-side render for the front end:
// $attributes and $content are available as local variables.
$message = isset( $attributes['message'] )
    ? sanitize_text_field( $attributes['message'] )
    : '';
?>
<p <?php echo get_block_wrapper_attributes(); ?>>
    <?php echo esc_html( $message ); ?>
</p>
\`\`\`
`
    ),

    // ─────────────────────────────────────────────────────────────────────────
    // 8. Custom REST fields
    // ─────────────────────────────────────────────────────────────────────────
    doc(
      "register-rest-field",
      "Add Custom REST API Fields to Posts",
      "rest-api",
      "4.7.0",
      `# Add Custom REST API Fields to Posts

\`register_rest_field()\` non-destructively appends a field to an existing REST
response without modifying core controllers. Ideal for exposing post meta.

\`\`\`php
<?php
add_action( 'rest_api_init', 'myplugin_register_post_rest_fields' );

function myplugin_register_post_rest_fields(): void {
    register_rest_field(
        'post',                         // object type: post, page, CPT slug, or array
        'reading_time_minutes',         // field key in the JSON response
        [
            'get_callback'    => 'myplugin_get_reading_time',
            'update_callback' => null,  // read-only — no update needed
            'schema'          => [
                'description' => __( 'Estimated reading time in minutes.', 'myplugin' ),
                'type'        => 'integer',
                'context'     => [ 'view', 'embed' ],
                'readonly'    => true,
            ],
        ]
    );
}

/**
 * @param array<string,mixed> $post  REST-prepared post data array.
 * @param string              $field The field name ('reading_time_minutes').
 * @param WP_REST_Request     $request
 * @return int
 */
function myplugin_get_reading_time( array $post, string $field, WP_REST_Request $request ): int {
    $content    = get_post_field( 'post_content', $post['id'] );
    $word_count = str_word_count( wp_strip_all_tags( $content ) );
    // Average adult reading speed: ~200 words per minute.
    return (int) ceil( $word_count / 200 );
}
\`\`\`
`
    ),

    // ─────────────────────────────────────────────────────────────────────────
    // 9. Transients for caching
    // ─────────────────────────────────────────────────────────────────────────
    doc(
      "transients-for-caching",
      "Use Transients to Cache Expensive Queries",
      "performance",
      "2.8.0",
      `# Use Transients to Cache Expensive Queries

Transients are the portable WordPress cache layer — they use an object cache
(Redis/Memcached) if available and fall back to the database automatically.
Never cache results indefinitely; always set a sensible expiry.

\`\`\`php
<?php
/**
 * Return the 5 most-commented posts, cached for one hour.
 *
 * @return WP_Post[]
 */
function myplugin_get_popular_posts(): array {
    $cache_key = 'myplugin_popular_posts_v1';

    // get_transient returns false when the transient is absent or expired.
    $posts = get_transient( $cache_key );

    if ( false === $posts ) {
        $query = new WP_Query( [
            'post_type'      => 'post',
            'post_status'    => 'publish',
            'posts_per_page' => 5,
            'orderby'        => 'comment_count',
            'order'          => 'DESC',
            'no_found_rows'  => true,   // skip COUNT(*) — we don't need pagination
        ] );

        $posts = $query->posts;

        // Cache for 1 hour. HOUR_IN_SECONDS is a WordPress constant.
        set_transient( $cache_key, $posts, HOUR_IN_SECONDS );
    }

    return $posts;
}

// Bust the cache whenever any post is saved so stale data can't linger.
add_action( 'save_post', function (): void {
    delete_transient( 'myplugin_popular_posts_v1' );
} );
\`\`\`
`
    ),

    // ─────────────────────────────────────────────────────────────────────────
    // 10. WP_Query
    // ─────────────────────────────────────────────────────────────────────────
    doc(
      "wp-query-correctly",
      "Query Posts Correctly with WP_Query",
      "queries",
      "1.5.0",
      `# Query Posts Correctly with WP_Query

Never write raw \`SELECT\` queries for standard post data. \`WP_Query\` handles
join logic, caching, status filtering, and capability checks automatically.

\`\`\`php
<?php
/**
 * Fetch published books in a given genre, paginated.
 *
 * @param string $genre     Term slug for the 'genre' taxonomy.
 * @param int    $paged     Current page number (from get_query_var('paged')).
 * @return WP_Query
 */
function myplugin_get_books_by_genre( string $genre, int $paged = 1 ): WP_Query {
    return new WP_Query( [
        'post_type'      => 'book',
        'post_status'    => 'publish',
        'posts_per_page' => 12,
        'paged'          => $paged,
        'orderby'        => 'title',
        'order'          => 'ASC',

        // Tax query: filter by a custom taxonomy term.
        'tax_query' => [ // phpcs:ignore WordPress.DB.SlowDBQuery
            [
                'taxonomy' => 'genre',
                'field'    => 'slug',
                'terms'    => sanitize_key( $genre ),
            ],
        ],

        // Meta query: only include books with a page count.
        'meta_query' => [ // phpcs:ignore WordPress.DB.SlowDBQuery
            [
                'key'     => '_myplugin_page_count',
                'value'   => 0,
                'compare' => '>',
                'type'    => 'NUMERIC',
            ],
        ],
    ] );
}

// Usage in a template:
$books_query = myplugin_get_books_by_genre( 'science-fiction', (int) get_query_var( 'paged', 1 ) );

if ( $books_query->have_posts() ) :
    while ( $books_query->have_posts() ) : $books_query->the_post();
        // ... render post
    endwhile;
    wp_reset_postdata(); // Always restore global $post after a custom query.
endif;
\`\`\`
`
    ),

    // ─────────────────────────────────────────────────────────────────────────
    // 11. Custom admin columns
    // ─────────────────────────────────────────────────────────────────────────
    doc(
      "custom-admin-columns",
      "Add Custom Admin Columns to a Post List",
      "admin",
      "1.5.0",
      `# Add Custom Admin Columns to a Post List

Two hooks do the work: \`manage_{post_type}_posts_columns\` registers the column
header, and \`manage_{post_type}_posts_custom_column\` renders each cell.

\`\`\`php
<?php
// Register the column header.
add_filter( 'manage_book_posts_columns', 'myplugin_book_columns' );

function myplugin_book_columns( array $columns ): array {
    // Insert our column before the date column for a logical order.
    $date = $columns['date'] ?? null;
    unset( $columns['date'] );

    $columns['isbn']       = __( 'ISBN', 'myplugin' );
    $columns['page_count'] = __( 'Pages', 'myplugin' );

    if ( $date !== null ) {
        $columns['date'] = $date;
    }

    return $columns;
}

// Render each cell.
add_action( 'manage_book_posts_custom_column', 'myplugin_book_column_content', 10, 2 );

function myplugin_book_column_content( string $column, int $post_id ): void {
    switch ( $column ) {
        case 'isbn':
            echo esc_html( get_post_meta( $post_id, '_myplugin_isbn', true ) ?: '—' );
            break;

        case 'page_count':
            $count = (int) get_post_meta( $post_id, '_myplugin_page_count', true );
            echo $count > 0 ? esc_html( number_format_i18n( $count ) ) : '—';
            break;
    }
}

// Make the page-count column sortable.
add_filter( 'manage_edit-book_sortable_columns', 'myplugin_sortable_book_columns' );

function myplugin_sortable_book_columns( array $columns ): array {
    $columns['page_count'] = 'page_count';
    return $columns;
}

// Translate the custom orderby to a meta_key query.
add_action( 'pre_get_posts', 'myplugin_book_orderby' );

function myplugin_book_orderby( WP_Query $query ): void {
    if ( ! is_admin() || ! $query->is_main_query() ) {
        return;
    }
    if ( 'page_count' === $query->get( 'orderby' ) ) {
        $query->set( 'meta_key', '_myplugin_page_count' );
        $query->set( 'orderby', 'meta_value_num' );
    }
}
\`\`\`
`
    ),

    // ─────────────────────────────────────────────────────────────────────────
    // 12. Widget
    // ─────────────────────────────────────────────────────────────────────────
    doc(
      "create-widget",
      "Create a Widget Using WP_Widget",
      "widgets",
      "2.8.0",
      `# Create a Widget Using WP_Widget

Extend \`WP_Widget\` and register the class with \`widgets_init\`. Override the
four methods: \`widget()\`, \`form()\`, \`update()\`, and the constructor.

\`\`\`php
<?php
add_action( 'widgets_init', function (): void {
    register_widget( 'Myplugin_Recent_Books_Widget' );
} );

class Myplugin_Recent_Books_Widget extends WP_Widget {

    public function __construct() {
        parent::__construct(
            'myplugin_recent_books',                       // base ID
            __( 'Recent Books', 'myplugin' ),              // widget name
            [ 'description' => __( 'Displays recent books.', 'myplugin' ) ]
        );
    }

    /**
     * Front-end output.
     *
     * @param array<string,mixed> $args     Sidebar registration args (before/after_widget, etc.)
     * @param array<string,mixed> $instance Saved widget settings.
     */
    public function widget( $args, $instance ): void {
        $title = apply_filters(
            'widget_title',
            ! empty( $instance['title'] ) ? $instance['title'] : '',
            $instance,
            $this->id_base
        );

        $count = ! empty( $instance['count'] ) ? absint( $instance['count'] ) : 5;

        echo wp_kses_post( $args['before_widget'] );

        if ( $title ) {
            echo wp_kses_post( $args['before_title'] ) . esc_html( $title ) . wp_kses_post( $args['after_title'] );
        }

        $books = new WP_Query( [
            'post_type'      => 'book',
            'posts_per_page' => $count,
            'no_found_rows'  => true,
        ] );

        if ( $books->have_posts() ) :
            echo '<ul>';
            while ( $books->have_posts() ) : $books->the_post();
                printf(
                    '<li><a href="%s">%s</a></li>',
                    esc_url( get_permalink() ),
                    esc_html( get_the_title() )
                );
            endwhile;
            wp_reset_postdata();
            echo '</ul>';
        endif;

        echo wp_kses_post( $args['after_widget'] );
    }

    /** Admin form to configure the widget. */
    public function form( $instance ): void {
        $title = ! empty( $instance['title'] ) ? sanitize_text_field( $instance['title'] ) : '';
        $count = ! empty( $instance['count'] ) ? absint( $instance['count'] ) : 5;
        ?>
        <p>
            <label for="<?php echo esc_attr( $this->get_field_id( 'title' ) ); ?>">
                <?php esc_html_e( 'Title:', 'myplugin' ); ?>
            </label>
            <input class="widefat"
                   id="<?php echo esc_attr( $this->get_field_id( 'title' ) ); ?>"
                   name="<?php echo esc_attr( $this->get_field_name( 'title' ) ); ?>"
                   type="text"
                   value="<?php echo esc_attr( $title ); ?>">
        </p>
        <p>
            <label for="<?php echo esc_attr( $this->get_field_id( 'count' ) ); ?>">
                <?php esc_html_e( 'Number of books:', 'myplugin' ); ?>
            </label>
            <input class="tiny-text"
                   id="<?php echo esc_attr( $this->get_field_id( 'count' ) ); ?>"
                   name="<?php echo esc_attr( $this->get_field_name( 'count' ) ); ?>"
                   type="number" min="1" max="20" step="1"
                   value="<?php echo esc_attr( $count ); ?>">
        </p>
        <?php
    }

    /** Sanitize and save widget settings. */
    public function update( $new_instance, $old_instance ): array {
        return [
            'title' => sanitize_text_field( $new_instance['title'] ?? '' ),
            'count' => min( 20, max( 1, absint( $new_instance['count'] ?? 5 ) ) ),
        ];
    }
}
\`\`\`
`
    ),

    // ─────────────────────────────────────────────────────────────────────────
    // 13. Rewrite rules
    // ─────────────────────────────────────────────────────────────────────────
    doc(
      "add-rewrite-rules",
      "Add Custom Rewrite Rules",
      "routing",
      "1.5.0",
      `# Add Custom Rewrite Rules

\`add_rewrite_rule()\` maps a URL pattern to a \`index.php\` query string.
\`add_rewrite_tag()\` registers the custom query var so WordPress forwards it.
Only call \`flush_rewrite_rules()\` on activation/deactivation — never on every
request.

\`\`\`php
<?php
// Register the rewrite rule and query var on every request.
add_action( 'init', 'myplugin_add_rewrite_rules' );

function myplugin_add_rewrite_rules(): void {
    // Register a custom query var so WordPress doesn't strip it.
    add_rewrite_tag( '%book_isbn%', '([\\w-]+)' );

    // Map /isbn/978-0-7432-7356-5/ → index.php?book_isbn=978-0-7432-7356-5
    add_rewrite_rule(
        '^isbn/([\\w-]+)/?$',
        'index.php?book_isbn=$matches[1]',
        'top'   // check before WordPress's default rules
    );
}

// Flush rules once on plugin activation so the new rule takes effect immediately.
register_activation_hook( __FILE__, function (): void {
    myplugin_add_rewrite_rules();
    flush_rewrite_rules();
} );

// Remove flush on deactivation to keep rules clean.
register_deactivation_hook( __FILE__, 'flush_rewrite_rules' );

// Handle the request when the custom var is present.
add_action( 'template_redirect', 'myplugin_handle_isbn_request' );

function myplugin_handle_isbn_request(): void {
    $isbn = get_query_var( 'book_isbn' );

    if ( empty( $isbn ) ) {
        return;
    }

    $posts = get_posts( [
        'post_type'  => 'book',
        'meta_key'   => '_myplugin_isbn',
        'meta_value' => sanitize_text_field( $isbn ),
        'numberposts' => 1,
    ] );

    if ( $posts ) {
        wp_safe_redirect( get_permalink( $posts[0] ), 301 );
        exit;
    }

    // ISBN not found — let WordPress show a 404.
    global $wp_query;
    $wp_query->set_404();
    status_header( 404 );
}
\`\`\`
`
    ),

    // ─────────────────────────────────────────────────────────────────────────
    // 14. wp_remote_get with error handling
    // ─────────────────────────────────────────────────────────────────────────
    doc(
      "wp-remote-get-error-handling",
      "Use wp_remote_get with Proper Error Handling",
      "http",
      "2.7.0",
      `# Use wp_remote_get with Proper Error Handling

Always use the WordPress HTTP API (\`wp_remote_get\`, \`wp_remote_post\`) instead
of \`file_get_contents\` or \`curl\` directly. It respects WordPress proxy
settings, SSL verification, and timeout configuration.

\`\`\`php
<?php
/**
 * Fetch data from an external JSON API.
 *
 * @param string $endpoint Full URL of the API endpoint.
 * @return array<string,mixed>|WP_Error Decoded response body or WP_Error on failure.
 */
function myplugin_fetch_api_data( string $endpoint ): array|WP_Error {
    $response = wp_remote_get(
        esc_url_raw( $endpoint ),
        [
            'timeout'     => 15,                                 // seconds; never use 0
            'redirection' => 5,                                  // max redirects to follow
            'sslverify'   => true,                               // never disable in production
            'headers'     => [
                'Accept'        => 'application/json',
                'Authorization' => 'Bearer ' . myplugin_get_api_token(),
            ],
            'user-agent'  => 'MyPlugin/1.0 (+https://example.com)',
        ]
    );

    // wp_remote_get returns a WP_Error on transport failure (DNS, timeout, etc.)
    if ( is_wp_error( $response ) ) {
        return $response; // let the caller decide how to handle it
    }

    $http_code = wp_remote_retrieve_response_code( $response );

    if ( 200 !== (int) $http_code ) {
        return new WP_Error(
            'api_error',
            sprintf( __( 'API returned HTTP %d.', 'myplugin' ), $http_code ),
            [ 'status' => $http_code ]
        );
    }

    $body = wp_remote_retrieve_body( $response );
    $data = json_decode( $body, true );

    if ( JSON_ERROR_NONE !== json_last_error() ) {
        return new WP_Error( 'json_decode_error', __( 'Invalid JSON response.', 'myplugin' ) );
    }

    return $data;
}

// Usage:
$result = myplugin_fetch_api_data( 'https://api.example.com/v1/books' );
if ( is_wp_error( $result ) ) {
    // log and bail gracefully
    error_log( 'myplugin: ' . $result->get_error_message() );
    return;
}
\`\`\`
`
    ),

    // ─────────────────────────────────────────────────────────────────────────
    // 15. Custom database table on activation
    // ─────────────────────────────────────────────────────────────────────────
    doc(
      "custom-database-table",
      "Create a Custom Database Table on Plugin Activation",
      "database",
      "1.5.0",
      `# Create a Custom Database Table on Plugin Activation

Use \`dbDelta()\` (not raw \`CREATE TABLE\`) because it safely creates or upgrades
the table. Run it on activation and whenever the plugin's \`DB_VERSION\` constant
changes.

\`\`\`php
<?php
define( 'MYPLUGIN_DB_VERSION', '1.0' );

register_activation_hook( __FILE__, 'myplugin_create_tables' );

function myplugin_create_tables(): void {
    global $wpdb;

    $charset_collate = $wpdb->get_charset_collate();

    // dbDelta requires: two spaces before each field definition, PRIMARY KEY
    // on its own line, and no trailing comma on the last field.
    $sql = "CREATE TABLE {$wpdb->prefix}myplugin_log (
      id          BIGINT(20)   UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id     BIGINT(20)   UNSIGNED NOT NULL DEFAULT 0,
      action      VARCHAR(255) NOT NULL,
      object_id   BIGINT(20)   UNSIGNED NOT NULL DEFAULT 0,
      created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY  (id),
      KEY user_id  (user_id),
      KEY created_at (created_at)
    ) $charset_collate;";

    // dbDelta lives in wp-admin/includes/upgrade.php.
    require_once ABSPATH . 'wp-admin/includes/upgrade.php';
    dbDelta( $sql );

    // Store the schema version so future activations can detect upgrades.
    update_option( 'myplugin_db_version', MYPLUGIN_DB_VERSION );
}

// Run the upgrade check on every admin load (cheap: only does work when version changes).
add_action( 'plugins_loaded', 'myplugin_maybe_upgrade_db' );

function myplugin_maybe_upgrade_db(): void {
    if ( get_option( 'myplugin_db_version' ) !== MYPLUGIN_DB_VERSION ) {
        myplugin_create_tables();
    }
}
\`\`\`
`
    ),

    // ─────────────────────────────────────────────────────────────────────────
    // 16. Localize scripts for AJAX
    // ─────────────────────────────────────────────────────────────────────────
    doc(
      "localize-scripts-ajax",
      "Localize Scripts for AJAX (wp_localize_script Pattern)",
      "assets",
      "2.2.0",
      `# Localize Scripts for AJAX (wp_localize_script Pattern)

\`wp_localize_script\` outputs a JSON object as an inline \`<script>\` before the
enqueued file, making PHP values (AJAX URL, nonces, i18n strings) available to
JavaScript without hardcoding them.

\`\`\`php
<?php
add_action( 'wp_enqueue_scripts', 'myplugin_enqueue_and_localize' );

function myplugin_enqueue_and_localize(): void {
    wp_enqueue_script(
        'myplugin-cart',
        plugin_dir_url( __FILE__ ) . 'js/cart.js',
        [ 'wp-api-fetch' ],   // use the built-in REST API fetch utility
        '1.0.0',
        [ 'in_footer' => true, 'strategy' => 'defer' ]
    );

    // wp_localize_script must be called AFTER the script is registered/enqueued.
    wp_localize_script(
        'myplugin-cart',     // handle must match
        'mypluginCart',      // JavaScript global variable name (camelCase by convention)
        [
            'ajaxUrl'   => admin_url( 'admin-ajax.php' ),
            'restUrl'   => esc_url_raw( rest_url( 'myplugin/v1/' ) ),
            'nonce'     => wp_create_nonce( 'wp_rest' ),           // for REST requests
            'ajaxNonce' => wp_create_nonce( 'myplugin_cart' ),     // for admin-ajax.php
            'userId'    => get_current_user_id(),
            'i18n'      => [
                'addedToCart'   => __( 'Added to cart!', 'myplugin' ),
                'errorOccurred' => __( 'An error occurred. Please try again.', 'myplugin' ),
            ],
        ]
    );
}
\`\`\`

In \`cart.js\`, access the values as \`window.mypluginCart.ajaxUrl\`, etc.
The nonce is automatically set on REST requests when you use \`wp.apiFetch\` with
\`{ nonce: mypluginCart.nonce }\`.
`
    ),

    // ─────────────────────────────────────────────────────────────────────────
    // 17. Custom post statuses
    // ─────────────────────────────────────────────────────────────────────────
    doc(
      "custom-post-statuses",
      "Add Custom Post Statuses",
      "post-types",
      "3.0.0",
      `# Add Custom Post Statuses

Register custom statuses with \`register_post_status()\` inside \`init\`. You also
need to inject the status into the quick-edit and Gutenberg dropdowns, as
WordPress doesn't do this automatically.

\`\`\`php
<?php
add_action( 'init', 'myplugin_register_post_statuses' );

function myplugin_register_post_statuses(): void {
    register_post_status(
        'pending_review',
        [
            'label'                     => _x( 'Pending Review', 'post status', 'myplugin' ),
            'public'                    => false,
            'exclude_from_search'       => true,
            'show_in_admin_all_list'    => true,   // appears in "All" view
            'show_in_admin_status_list' => true,   // appears in status filter row
            /* translators: %s: number of posts */
            'label_count'               => _n_noop(
                'Pending Review <span class="count">(%s)</span>',
                'Pending Review <span class="count">(%s)</span>',
                'myplugin'
            ),
        ]
    );
}

// Inject the status into the classic editor's status dropdown.
add_action( 'post_submitbox_misc_actions', 'myplugin_add_status_to_submit_box' );

function myplugin_add_status_to_submit_box(): void {
    global $post;

    if ( 'book' !== $post->post_type ) {
        return;
    }

    $selected = selected( 'pending_review', $post->post_status, false );
    ?>
    <script>
    jQuery(function($) {
        $('select#post_status').append(
            $('<option>').val('pending_review')
                         .text('<?php esc_html_e( 'Pending Review', 'myplugin' ); ?>')
                         <?php echo $selected ? '.prop("selected", true)' : ''; ?>
        );
        <?php if ( 'pending_review' === $post->post_status ) : ?>
        $('#post-status-display').text('<?php esc_html_e( 'Pending Review', 'myplugin' ); ?>');
        <?php endif; ?>
    });
    </script>
    <?php
}
\`\`\`
`
    ),

    // ─────────────────────────────────────────────────────────────────────────
    // 18. Filter post content safely
    // ─────────────────────────────────────────────────────────────────────────
    doc(
      "filter-post-content-safely",
      "Filter Post Content Safely with the_content",
      "security",
      "0.71",
      `# Filter Post Content Safely with the_content

Never echo raw content directly. Use \`wp_kses_post()\` (or stricter \`wp_kses()\`)
when outputting HTML you've modified, and make sure your filter has the right
priority so it runs at the correct moment.

\`\`\`php
<?php
// Priority 20 — after WordPress's own content filters (autop, shortcodes, embeds)
// have already run. This means we're working with the final HTML.
add_filter( 'the_content', 'myplugin_append_reading_time', 20 );

function myplugin_append_reading_time( string $content ): string {
    // Only append on singular book posts — not in loops, excerpts, or RSS.
    if ( ! is_singular( 'book' ) || ! in_the_loop() || ! is_main_query() ) {
        return $content;
    }

    $word_count    = str_word_count( wp_strip_all_tags( $content ) );
    $reading_time  = (int) ceil( $word_count / 200 );

    // Build the HTML addition as a string — never concatenate unescaped values.
    $addition = sprintf(
        '<p class="myplugin-reading-time">%s</p>',
        sprintf(
            /* translators: %d: number of minutes */
            esc_html( _n( 'Reading time: %d minute', 'Reading time: %d minutes', $reading_time, 'myplugin' ) ),
            $reading_time
        )
    );

    // Append after the content. wp_kses_post strips anything that isn't
    // safe post HTML (no <script>, no event attributes, etc.).
    return $content . wp_kses_post( $addition );
}
\`\`\`
`
    ),

    // ─────────────────────────────────────────────────────────────────────────
    // 19. Shortcode with attributes
    // ─────────────────────────────────────────────────────────────────────────
    doc(
      "shortcode-with-attributes",
      "Create a Shortcode with Attributes",
      "shortcodes",
      "2.5.0",
      `# Create a Shortcode with Attributes

Register shortcodes with \`add_shortcode()\`. Always use \`shortcode_atts()\` to
merge user-supplied attributes with sane defaults and whitelist allowed values.
Return the output — never echo it.

\`\`\`php
<?php
add_shortcode( 'myplugin_books', 'myplugin_books_shortcode' );

/**
 * [myplugin_books count="5" genre="fantasy" orderby="title"]
 *
 * @param array<string,string>|string $atts    Shortcode attributes (can be empty string).
 * @param string|null                 $content Enclosed content (not used here).
 * @return string HTML output.
 */
function myplugin_books_shortcode( $atts, ?string $content = null ): string {
    // shortcode_atts merges user values with defaults and strips unknown keys.
    $atts = shortcode_atts(
        [
            'count'   => '5',
            'genre'   => '',
            'orderby' => 'date',
        ],
        $atts,
        'myplugin_books'   // shortcode tag — enables the shortcode_atts_{tag} filter
    );

    // Sanitize every attribute before using it in a query.
    $count   = min( 20, max( 1, absint( $atts['count'] ) ) );
    $genre   = sanitize_key( $atts['genre'] );
    $orderby = in_array( $atts['orderby'], [ 'date', 'title', 'rand' ], true )
        ? $atts['orderby']
        : 'date';

    $query_args = [
        'post_type'      => 'book',
        'post_status'    => 'publish',
        'posts_per_page' => $count,
        'orderby'        => $orderby,
        'no_found_rows'  => true,
    ];

    if ( $genre ) {
        $query_args['tax_query'] = [ // phpcs:ignore WordPress.DB.SlowDBQuery
            [
                'taxonomy' => 'genre',
                'field'    => 'slug',
                'terms'    => $genre,
            ],
        ];
    }

    $books = new WP_Query( $query_args );

    // Build output in a buffer — never echo from a shortcode callback.
    ob_start();

    if ( $books->have_posts() ) :
        echo '<ul class="myplugin-books-list">';
        while ( $books->have_posts() ) : $books->the_post();
            printf(
                '<li><a href="%s">%s</a></li>',
                esc_url( get_permalink() ),
                esc_html( get_the_title() )
            );
        endwhile;
        wp_reset_postdata();
        echo '</ul>';
    else :
        echo '<p>' . esc_html__( 'No books found.', 'myplugin' ) . '</p>';
    endif;

    return ob_get_clean();
}
\`\`\`
`
    ),

    // ─────────────────────────────────────────────────────────────────────────
    // 20. Meta boxes
    // ─────────────────────────────────────────────────────────────────────────
    doc(
      "add-meta-boxes",
      "Add Meta Boxes to Posts",
      "admin",
      "2.5.0",
      `# Add Meta Boxes to Posts

Use the \`add_meta_boxes\` hook to register boxes and \`save_post\` (with all
security guards) to persist the values. Always render a nonce field and verify
it on save.

\`\`\`php
<?php
add_action( 'add_meta_boxes', 'myplugin_add_book_meta_boxes' );

function myplugin_add_book_meta_boxes(): void {
    add_meta_box(
        'myplugin_book_details',            // unique ID
        __( 'Book Details', 'myplugin' ),   // box title
        'myplugin_render_book_details_box', // callback
        'book',                             // post type (or array of types)
        'normal',                           // context: normal | side | advanced
        'high'                              // priority: high | default | low | core
    );
}

function myplugin_render_book_details_box( WP_Post $post ): void {
    // Output a nonce field scoped to this post ID so we can verify it on save.
    wp_nonce_field( 'myplugin_save_book_details_' . $post->ID, 'myplugin_book_details_nonce' );

    $isbn       = get_post_meta( $post->ID, '_myplugin_isbn', true );
    $page_count = get_post_meta( $post->ID, '_myplugin_page_count', true );
    ?>
    <table class="form-table">
        <tr>
            <th scope="row">
                <label for="myplugin_isbn"><?php esc_html_e( 'ISBN', 'myplugin' ); ?></label>
            </th>
            <td>
                <input type="text"
                       id="myplugin_isbn"
                       name="myplugin_isbn"
                       value="<?php echo esc_attr( $isbn ); ?>"
                       class="regular-text">
            </td>
        </tr>
        <tr>
            <th scope="row">
                <label for="myplugin_page_count"><?php esc_html_e( 'Page Count', 'myplugin' ); ?></label>
            </th>
            <td>
                <input type="number"
                       id="myplugin_page_count"
                       name="myplugin_page_count"
                       value="<?php echo esc_attr( $page_count ); ?>"
                       min="0" class="small-text">
            </td>
        </tr>
    </table>
    <?php
}

// Hook to the specific post-type variant to narrow scope automatically.
add_action( 'save_post_book', 'myplugin_save_book_details_meta' );

function myplugin_save_book_details_meta( int $post_id ): void {
    // 1. Nonce.
    if (
        ! isset( $_POST['myplugin_book_details_nonce'] ) ||
        ! wp_verify_nonce(
            sanitize_key( $_POST['myplugin_book_details_nonce'] ),
            'myplugin_save_book_details_' . $post_id
        )
    ) {
        return;
    }

    // 2. Autosave.
    if ( defined( 'DOING_AUTOSAVE' ) && DOING_AUTOSAVE ) {
        return;
    }

    // 3. Capability.
    if ( ! current_user_can( 'edit_post', $post_id ) ) {
        return;
    }

    // 4. Sanitize and save.
    $isbn = isset( $_POST['myplugin_isbn'] )
        ? sanitize_text_field( wp_unslash( $_POST['myplugin_isbn'] ) )
        : '';

    $page_count = isset( $_POST['myplugin_page_count'] )
        ? absint( $_POST['myplugin_page_count'] )
        : 0;

    update_post_meta( $post_id, '_myplugin_isbn', $isbn );
    update_post_meta( $post_id, '_myplugin_page_count', $page_count );
}
\`\`\`
`
    ),
  ];
}
