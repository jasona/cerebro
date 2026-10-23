# syntax=docker/dockerfile:1
#
# Cerebro web app (Next.js standalone server). Build from the repository root:
#
#   docker build -f deploy/docker/web.Dockerfile -t cerebro-web .
#
# The internal packages are TypeScript sources with no build step; `next build`
# transpiles them (`transpilePackages`) and output file tracing copies only the
# server files and node_modules it can see into `.next/standalone`. The
# server-external packages that load files tracing cannot see (OCR worker and
# WASM core, OCR language data, a runtime-selected AI SDK provider) are copied
# whole by copy-runtime-packages.mjs. PGlite is never used here: production
# requires DATABASE_URL (PostgreSQL).

ARG NODE_IMAGE=node:24-trixie-slim

# ---------------------------------------------------------------------------
# Dependencies: manifests first so the install layer is cached across source
# changes. A new workspace package must be added here (npm ci fails otherwise).
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
RUN npm ci --no-audit --no-fund

# ---------------------------------------------------------------------------
FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN npm run build \
 && node deploy/docker/copy-runtime-packages.mjs /app /app/apps/web/.next/standalone \
      tesseract.js tesseract.js-core @tesseract.js-data/eng @napi-rs/canvas unpdf --scope @ai-sdk

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS web
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
# Server, traced node_modules and the overlaid runtime packages (root-owned, read-only for the app user).
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
# The root manifest marks the repository root (findRepoRoot), and the
# readiness check compares applied migrations with these files.
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/database/migrations ./packages/database/migrations
# Writable only where the server writes: Next's cache, and `.data` for the
# optional local object store (mount a volume there if CEREBRO_OBJECT_STORE=local).
RUN mkdir -p apps/web/.next/cache .data \
 && chown -R node:node apps/web/.next/cache .data
USER node
EXPOSE 3000
# Liveness only (never touches the database); readiness is /api/ready.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
