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

## Core tools

- **`search_wordpress_docs`** — BM25 full-text search with optional category/type filters
- **`get_wordpress_doc`** — Fetch the full documentation page by slug or ID
- **`lookup_wordpress_hook`** — Exact name lookup for functions, hooks, and classes with cross-references
- **`answer_wordpress_question`** — Grounded answer synthesis with structured citations, confidence, and abstention

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
| `OLLAMA_HOST` (optional) | Ollama endpoint used for query expansion and answer synthesis |
| `OLLAMA_MODEL` (optional) | Default Ollama model; used for query expansion unless overridden |
| `OLLAMA_EXPAND_TIMEOUT_MS` (optional) | Ollama query-expansion time budget in ms (default `250`) |
| `GITHUB_TIER` (optional) | Curated WordPress GitHub tier for scraper (`tier1` default, `tier2` opt-in) |
| `GITHUB_REPOS` (optional) | Comma-separated WordPress GitHub repo keys to ingest (subset override) |
| `GITHUB_MAX_DOCS_PER_REPO` (optional) | Hard cap for docs ingested per WordPress GitHub repo |
| `SKIP_GITHUB_WORDPRESS` (optional) | Set `1` to skip curated WordPress GitHub repo ingestion |
| `OLLAMA_ANSWER_MODEL` (optional) | Ollama model for grounded answer synthesis (default `qwen2.5-coder:7b`) |
| `OLLAMA_CRITIC_MODEL` (optional) | Ollama model for answer critique pass (default `OLLAMA_ANSWER_MODEL`) |
| `OLLAMA_ANSWER_TIMEOUT_MS` (optional) | Ollama answer synthesis timeout in ms (default `1800`) |
| `OLLAMA_CRITIC_TIMEOUT_MS` (optional) | Ollama critique timeout in ms (default `1200`) |

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

- `.github/workflows/ci.yml` — build, typecheck, lint, test, and quality eval gate on PR/push
- `.github/workflows/security.yml` — weekly dependency audit

### Quality telemetry and thresholds

The answer pipeline emits quality telemetry lines in logs with:

- retrieval latency, rerank latency, answer latency
- evidence count
- citation coverage
- unsupported claim rate
- abstain reason and confidence

Run local quality gate:

```bash
pnpm eval:quality
```

Current thresholds enforced by the evaluator:

- hit@k >= 0.80
- citation precision >= 0.60
- unsupported claim rate <= 0.20
- abstain accuracy >= 1.00

### Wrangler persona policy

The system persona is **Wrangler** with a light cowboy voice:

- subtle folksy phrasing only (no heavy slang)
- practical and concise guidance first
- factual sections stay grounded to citations
- structured JSON/citation blocks remain unchanged in format

Wrangler style is checked in the quality eval gate to prevent drift.

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
