# WP Know It All

The definitive WordPress documentation MCP server. Indexes 10,000+ pages of WordPress developer documentation — Code Reference, Block Editor Handbook, Plugin/Theme/REST API handbooks, WP-CLI — into a SQLite database with FTS5 BM25 search. Hosted on Railway, accessible from any MCP-compatible AI client.

## What's in the index

| Source | Content | ~Pages |
|---|---|---|
| Code Reference (functions) | `wp_enqueue_script`, `add_action`, etc. | 2,500 |
| Code Reference (hooks) | Actions & filters | 2,500 |
| Code Reference (classes/methods) | `WP_Query`, `WP_Post`, etc. | 2,500 |
| Plugin Handbook | Plugin development guides | 150 |
| Theme Handbook | Theme development guides | 100 |
| Block Editor Handbook | Gutenberg, block.json, Interactivity API | 350 |
| REST API Handbook | Endpoints, authentication, schema | 80 |
| Common APIs Handbook | Options, transients, HTTP API, etc. | 100 |
| Coding Standards | PHP, JS, CSS, HTML standards | 40 |
| WP-CLI Handbook | All `wp` commands + handbook | 300 |

## Three tools

- **`search_wordpress_docs`** — BM25 full-text search with optional category/type filters
- **`get_wordpress_doc`** — Fetch the full documentation page by slug or ID
- **`lookup_wordpress_hook`** — Exact name lookup for functions, hooks, and classes with cross-references

## Connecting to your AI client

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "wordpress-docs": {
      "url": "https://YOUR-SERVICE.up.railway.app/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_AUTH_TOKEN"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project (or global `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "wordpress-docs": {
      "url": "https://YOUR-SERVICE.up.railway.app/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_AUTH_TOKEN"
      }
    }
  }
}
```

### VS Code Copilot

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "wordpress-docs": {
      "type": "http",
      "url": "https://YOUR-SERVICE.up.railway.app/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_AUTH_TOKEN"
      }
    }
  }
}
```

---

## Deploying to Railway

### 1. Create a Railway project

```bash
railway login
railway init
```

### 2. Deploy the server service

The root `railway.toml` configures the server service. Railway will build and deploy automatically on push.

Set these environment variables in the Railway dashboard:

| Variable | Value |
|---|---|
| `MCP_AUTH_TOKEN` | A strong random secret (e.g. `openssl rand -hex 32`) |
| `ADMIN_PASSWORD` | Required in production to enable admin sign-in |
| `ALLOWED_HOSTS` | Comma-separated host allowlist for DNS-rebinding protection (e.g. `your-service.up.railway.app`) |
| `SCRAPER_ENTRY` (optional) | Absolute path to scraper entrypoint. Default auto-resolves to `/app/packages/scraper/dist/index.js` |
| `OLLAMA_HOST` (optional) | Ollama endpoint used for query expansion |
| `OLLAMA_MODEL` (optional) | Query expansion model (default `qwen2.5-coder:1.5b`) |
| `OLLAMA_EXPAND_TIMEOUT_MS` (optional) | Ollama query-expansion time budget in ms (default `250`) |

### 3. Attach a persistent volume

In the Railway dashboard for the server service:
- Add a volume → set mount path to `/data`
- The database will be stored at `/data/wordpress.db`

The `RAILWAY_VOLUME_MOUNT_PATH` env var is auto-injected.

### 4. Add the scraper service

In the Railway dashboard:
- Create a new service in the same project
- Connect the same GitHub repo
- Set the config file path to `packages/scraper/railway.scraper.toml`
- Attach the **same volume** at `/data` (so it writes to the same DB the server reads)
- Trigger a one-off deploy to run the initial scrape

The scraper runs weekly on Sundays at 3 AM UTC thereafter.

### 5. Generate a domain

```bash
railway domain
```

Use the generated URL in your MCP client config above.

### Troubleshooting admin-triggered scraper runs

If `/admin/scraper` shows `Cannot find module '/packages/scraper/dist/index.js'`, set:

```env
SCRAPER_ENTRY=/app/packages/scraper/dist/index.js
```

The server now checks common paths automatically and logs checked candidates in `scraper.log` if the entrypoint is missing.

### Health and readiness endpoints

- `GET /livez` — liveness probe
- `GET /readyz` — readiness probe (DB + volume write access)
- `GET /startupz` — startup probe
- `GET /health` — compatibility endpoint backed by readiness

Set Railway healthcheck to `/readyz` (already configured in `railway.toml`).

---

## Local Development

### Prerequisites

- Node.js 22+
- pnpm 9+

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run server locally (creates ./data/wordpress.db if it doesn't exist)
pnpm dev:server

# Run scraper locally (test with a few types first)
INGEST_TYPES=plugin-handbook,theme-handbook SKIP_GITHUB=0 pnpm dev:scraper

# Run full scrape locally
pnpm dev:scraper
```

### Environment variables (local)

Create `packages/server/.env`:

```env
MCP_AUTH_TOKEN=your-local-dev-token
ADMIN_PASSWORD=your-local-admin-password
ALLOWED_HOSTS=localhost:3000
# RAILWAY_VOLUME_MOUNT_PATH defaults to ./data when not set
```

### Backup and restore

Use the included scripts to snapshot and restore SQLite data:

```bash
# Create backup under ./backups
pnpm backup:db

# Restore backup file into current DB path
pnpm restore:db ./backups/wordpress-YYYYMMDD-HHMMSS.db
```

### CI and security workflows

GitHub Actions includes:

- `.github/workflows/ci.yml` — build, typecheck, lint, and test on PR/push
- `.github/workflows/security.yml` — weekly dependency audit

### Test with MCP Inspector

```bash
npx @modelcontextprotocol/inspector node packages/server/dist/index.js
```

Navigate to `http://localhost:5173` to invoke tools interactively.

---

## Architecture

```
packages/
├── shared/          TypeScript types shared between server and scraper
├── server/          MCP server — Express + Streamable HTTP transport
│   ├── src/db/      SQLite schema + typed query helpers (better-sqlite3)
│   ├── src/tools/   search_wordpress_docs, get_wordpress_doc, lookup_wordpress_hook
│   ├── src/middleware/  Bearer token auth
│   ├── src/resources.ts  Static MCP resources
│   ├── src/prompts.ts    Workflow prompts
│   └── Dockerfile
└── scraper/         Documentation ingestion pipeline
    ├── src/ingestors/  DevHub REST API, Gutenberg GitHub, WP-CLI GitHub
    ├── src/pipeline/   Turndown HTML→MD, heading-based chunker, metadata extractor
    ├── src/db/         SQLite writer with batch upsert
    ├── Dockerfile.scraper
    └── railway.scraper.toml
```

## License

Content indexed by this server is © WordPress contributors, licensed under CC0 (documentation) and GPLv2+ (code examples). This project's source code is MIT licensed.
