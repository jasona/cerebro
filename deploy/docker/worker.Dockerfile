# syntax=docker/dockerfile:1
#
# Cerebro background worker, and the image for one-off operations: database
# provisioning and migrations (migrate.sh), backups, retention sweeps and
# org:bootstrap. Build from the repository root:
#
#   docker build -f deploy/docker/worker.Dockerfile -t cerebro-worker .
#
# Runs the TypeScript sources with tsx (`node --import tsx`), exactly as
# `npm run worker` and the npm CLI scripts do in development and CI. The
# internal packages have no build step, so there is no second (compiled) code
# path to keep in sync, and tsx's per-start transpile cost is paid once by a
# long-running process.

ARG NODE_IMAGE=node:24-trixie-slim

# ---------------------------------------------------------------------------
# Production dependencies of the worker workspace only (not Next.js or React).
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/ai/package.json packages/ai/
COPY packages/briefing-renderer/package.json packages/briefing-renderer/
COPY packages/briefing-schema/package.json packages/briefing-schema/
COPY packages/capture/package.json packages/capture/
COPY packages/database/package.json packages/database/
COPY packages/domain/package.json packages/domain/
COPY packages/integrations/package.json packages/integrations/
COPY packages/ui/package.json packages/ui/
RUN npm ci --no-audit --no-fund --omit=dev --workspace=@cerebro/worker

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS worker
# pg_dump/pg_restore for db:backup and db:restore. Debian trixie ships the
# PostgreSQL 17 client, matching the pgvector/pgvector:pg17 server; pg_dump
# must not be older than the server.
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    CEREBRO_BACKUP_DIR=/backups
WORKDIR /app
# Manifests and node_modules (including any nested workspace node_modules), then sources.
COPY --from=deps /app ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker
COPY deploy/docker/migrate.sh ./deploy/docker/migrate.sh
# Writable only for backups and `.data` (the optional local object store).
RUN mkdir -p /backups .data && chown node:node /backups .data
USER node
CMD ["node", "--import", "tsx", "apps/worker/src/main.ts"]
