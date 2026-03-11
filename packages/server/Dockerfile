# syntax=docker/dockerfile:1

# ── Stage 1: Install production dependencies ──────────────────────────────────
FROM node:22-slim AS deps
WORKDIR /app

# Enable corepack for pnpm
RUN corepack enable

# Copy workspace files needed for install
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/

# Install production deps only (better-sqlite3 native build happens here)
RUN pnpm install --frozen-lockfile --prod

# ── Stage 2: Build TypeScript ─────────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/

# Full install (includes devDeps for tsc)
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/shared/ ./packages/shared/
COPY packages/server/ ./packages/server/

# Build shared first (server depends on it)
RUN pnpm --filter @wp-know-it-all/shared build
RUN pnpm --filter @wp-know-it-all/server build

# ── Stage 3: Production image ─────────────────────────────────────────────────
FROM node:22-slim AS production

ENV NODE_ENV=production

WORKDIR /app

# Non-root user
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 --ingroup nodejs nodejs

# Copy built artifacts
COPY --from=deps  --chown=nodejs:nodejs /app/node_modules                    ./node_modules
COPY --from=build --chown=nodejs:nodejs /app/packages/shared/dist            ./packages/shared/dist
COPY --from=build --chown=nodejs:nodejs /app/packages/server/dist            ./packages/server/dist
COPY --chown=nodejs:nodejs package.json pnpm-workspace.yaml                  ./
COPY --chown=nodejs:nodejs packages/shared/package.json                      ./packages/shared/
COPY --chown=nodejs:nodejs packages/server/package.json                      ./packages/server/

# Default local data dir; Railway provides mount path via RAILWAY_VOLUME_MOUNT_PATH
RUN mkdir -p /app/data && chown nodejs:nodejs /app/data

USER nodejs

EXPOSE 3000

# Dockerfile HEALTHCHECK for local dev — Railway uses railway.toml healthcheckPath
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "packages/server/dist/index.js"]
