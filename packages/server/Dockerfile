# syntax=docker/dockerfile:1

# ── Stage 1: Build and create deployable server bundle ────────────────────────
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

# Produce a portable server folder with isolated production node_modules.
# --legacy avoids requiring inject-workspace-packages in pnpm-workspace.yaml.
RUN pnpm --filter @wp-know-it-all/server --prod deploy --legacy /prod/server

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

# Default local data dir; Railway provides mount path via RAILWAY_VOLUME_MOUNT_PATH
RUN mkdir -p /app/data /tmp/.cache/node/corepack/v1 \
 && chown -R nodejs:nodejs /app/data /tmp/.cache

USER nodejs

EXPOSE 3000

# Dockerfile HEALTHCHECK for local dev — Railway uses railway.toml healthcheckPath
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "packages/server/dist/index.js"]
