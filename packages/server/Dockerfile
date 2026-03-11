# syntax=docker/dockerfile:1

# ── Stage 1: Build and create deployable server bundle ────────────────────────
FROM node:22-slim AS build
WORKDIR /app

RUN corepack enable
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/scraper/package.json ./packages/scraper/

# Full install (includes devDeps for tsc)
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/shared/ ./packages/shared/
COPY packages/server/ ./packages/server/
COPY packages/scraper/ ./packages/scraper/

# Build shared first (server depends on it)
RUN pnpm --filter @wp-know-it-all/shared build
RUN pnpm --filter @wp-know-it-all/server build
RUN pnpm --filter @wp-know-it-all/scraper build

# Produce a portable server folder with isolated production node_modules.
# --legacy avoids requiring inject-workspace-packages in pnpm-workspace.yaml.
RUN pnpm --filter @wp-know-it-all/server --prod deploy --legacy /prod/server
RUN pnpm --filter @wp-know-it-all/scraper --prod deploy --legacy /prod/scraper
# Ensure native binding exists in deploy bundle even if prebuild download misses.
RUN cd /prod/server && pnpm rebuild better-sqlite3
RUN cd /prod/scraper && pnpm rebuild better-sqlite3

# ── Stage 2: Production image ─────────────────────────────────────────────────
FROM node:22-slim AS production

ENV NODE_ENV=production
ENV HOME=/tmp
ENV XDG_CACHE_HOME=/tmp/.cache

WORKDIR /app

# Non-root user
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 --ingroup nodejs nodejs

# Copy deploy bundle to expected service path used by Railway start command
COPY --from=build --chown=nodejs:nodejs /prod/server ./packages/server
COPY --from=build --chown=nodejs:nodejs /prod/scraper ./packages/scraper

# Default local data dir; Railway provides mount path via RAILWAY_VOLUME_MOUNT_PATH
RUN mkdir -p /app/data /tmp/.cache/node/corepack/v1 \
 && chown -R nodejs:nodejs /app/data /tmp/.cache

EXPOSE 3000

# Dockerfile HEALTHCHECK for local dev — Railway uses railway.toml healthcheckPath
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "packages/server/dist/index.js"]
