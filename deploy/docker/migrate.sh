#!/bin/sh
# One-shot migration step for server deployments (worker image).
#
# With DATABASE_ADMIN_URL (a superuser URL): first prepare the owner role,
# database and vector extension (`db:provision`, idempotent). Then apply
# pending migrations as the owner in DATABASE_URL (`db:migrate`, a no-op when
# up to date). With CEREBRO_OBJECT_STORE=s3, finally make sure the source
# bucket exists (`objects:init`, idempotent). Exits non-zero on any failure,
# so dependants do not start.
set -eu
cd /app
if [ -n "${DATABASE_ADMIN_URL:-}" ]; then
  node --import tsx packages/database/src/cli/provision.ts
fi
node --import tsx packages/database/src/cli/migrate.ts
if [ "${CEREBRO_OBJECT_STORE:-}" = "s3" ]; then
  node --import tsx packages/domain/src/cli/objects-init.ts
fi
