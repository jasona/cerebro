#!/bin/sh
# One-shot migration step for server deployments (worker image).
#
# With DATABASE_ADMIN_URL (a superuser URL): first prepare the owner role,
# database and vector extension (`db:provision`, idempotent). Then apply
# pending migrations as the owner in DATABASE_URL (`db:migrate`, a no-op when
# up to date). Exits non-zero on any failure, so dependants do not start.
set -eu
cd /app
if [ -n "${DATABASE_ADMIN_URL:-}" ]; then
  node --import tsx packages/database/src/cli/provision.ts
fi
exec node --import tsx packages/database/src/cli/migrate.ts
