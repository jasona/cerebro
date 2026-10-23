# Deploying Cerebro on Coolify

Runbook for hosting Cerebro internally on [Coolify](https://coolify.io/docs/) (decision D14). It covers the first deployment, the first owner, health checks, backups, retention, upgrades and rollback.

Nothing here sets a target. No backup frequency, retention period, rate limit, latency target or cost cap has been agreed (P11, P12), so every schedule and limit below is yours to choose and is off until you set it.

## What gets deployed

One Coolify **Application** built from this repository with the **Docker Compose** build pack, using [`deploy/coolify/docker-compose.yml`](docker-compose.yml):

| Service | Image | Role |
| --- | --- | --- |
| `postgres` | `pgvector/pgvector:pg17` | PostgreSQL 17 with pgvector. Data is kept in the `cerebro-postgres` volume. No port is published. |
| `migrate` | [`deploy/docker/worker.Dockerfile`](../docker/worker.Dockerfile) | A one-shot step on every deployment. `db:provision` runs as the Postgres superuser and creates the owner role, the `cerebro` database and the `vector` extension. `db:migrate` then runs as the owner. Must exit 0 before `web` and `worker` start. |
| `web` | [`deploy/docker/web.Dockerfile`](../docker/web.Dockerfile) | The Next.js standalone server on port 3000. Its health check calls `GET /api/health`. |
| `worker` | `deploy/docker/worker.Dockerfile` | The background job runner, also used for scheduled tasks (backups, retention). Backups go to the `cerebro-backups` volume. |

Source files go to an **S3-compatible object store that you run**, outside this stack (see step 3).

### Why this shape

- **Compose build pack, not the Dockerfile build pack.** Cerebro has several processes: web, worker, a migration step and its database. Coolify's Compose build pack deploys them together from Git, with webhooks and previews ([Docker Compose build pack](https://coolify.io/docs/applications/build-packs/docker-compose)). The Dockerfile build pack runs a single container.
- **A `migrate` service, not a pre-deployment command.** Coolify runs a pre-deployment command inside the *currently running* container and skips it when none exists, for example on the first deployment ([Dockerfile build pack](https://coolify.io/docs/applications/build-packs/dockerfile)). Compose deployments run `docker compose up` ([build and deployment model](https://coolify.io/docs/core/build-deployment-model)). With `depends_on: condition: service_completed_successfully`, new web and worker containers are created only after migrations succeed. `exclude_from_hc: true` stops the exited one-shot container from counting against the stack's health ([Compose in Coolify](https://coolify.io/docs/knowledge-base/docker/compose)).
- **No superuser at runtime.** The app connects as the `cerebro` owner role, which has `CREATEROLE` and `BYPASSRLS` but not `SUPERUSER`, and switches to `cerebro_app` for every request (row-level security). Only `postgres` and the one-shot `migrate` container hold the superuser password. CI and `packages/database/test/provision.test.ts` check that this owner can migrate, seed, back up, restore and run under RLS.

## Prerequisites

- A Coolify instance with a server, and an internal hostname with TLS for Cerebro, for example `https://cerebro.example.internal`. The examples here use that name; replace it with yours.
- A **Clerk** production instance (D08, D13): its publishable key and secret key, with your Cerebro URL allowed as an origin.
- An **S3-compatible bucket** (step 3).
- Access to this Git repository from Coolify, via a deploy key or a Git App.

## Step by step

### 1. Create the project

In Coolify, create a **Project** (for example `Cerebro`) and choose an **Environment** (for example `production`). Keep production and non-production in separate environments (ARCHITECTURE "Reliability and deployment").

### 2. Add the application

1. **+ New → Application**, then pick the repository and branch (`main`).
2. Set **Build pack** to **Docker Compose**.
3. Set **Base Directory** to `/deploy/coolify` and **Docker Compose Location** to `/docker-compose.yml`. Do not use Base Directory `/` with the full path. Coolify still checks out the whole repository, but it runs Compose with `--project-directory` set to the Base Directory, and relative paths in the file resolve from that directory ([`ApplicationDeploymentJob.php`](https://github.com/coollabsio/coolify/blob/main/app/Jobs/ApplicationDeploymentJob.php)). The file builds with `context: ../..`, which is the repository root only when the Base Directory is `deploy/coolify`.
4. Coolify reads the compose file and lists its variables (step 4). After you change the compose file in Git, use **Reload Compose File**. Do not edit the rendered copy.
5. **Domains:** assign your URL to the **`web`** service *with the container port*: `https://cerebro.example.internal:3000`. The `:3000` tells Coolify's proxy which container port to use; users still connect on 443 ([Compose build pack, domains](https://coolify.io/docs/applications/build-packs/docker-compose)). Give no other service a domain. Do not add `ports:`, because published host ports bypass the proxy.

### 3. Object storage (S3-compatible)

Cerebro stores uploaded source files privately by content hash (`CEREBRO_OBJECT_STORE=s3`, `packages/domain/src/sources/s3-store.ts`). No storage product is assumed. Any S3-compatible service reachable from the `web` and `worker` containers will work, such as:

- an S3-compatible object store deployed as another resource from Coolify's service catalog (check what your Coolify version offers), or
- an S3-compatible service your organization already runs.

Whichever you choose:

1. Create a **private** bucket. Cerebro never sets ACLs and serves bytes only through authorized domain services, so the bucket needs no public access or policy.
2. Create an access key limited to that bucket (read, write, delete, list).
3. Note the endpoint URL, region and bucket name, and whether the service needs path-style addressing. Most self-hosted services do, in which case set `CEREBRO_S3_FORCE_PATH_STYLE=true`.
4. **Reachability:** a Compose stack in Coolify has its own network. To reach a storage service deployed as another Coolify resource by container name, enable **Connect To Predefined Network** on the Cerebro application and use that resource's renamed host (`<service>-<uuid>`). Otherwise use the storage service's HTTPS URL ([Networking in Coolify](https://coolify.io/docs/core/networking-in-coolify)).

`web` and `worker` validate the S3 settings at start (no network call) and refuse to start if they are incomplete. Configuration and credential problems surface on the first upload.

### 4. Environment variables

Set these on the application's **Environment Variables** page. The compose file marks required variables `${VAR:?}`, and Coolify blocks the deployment until they are set ([environment syntax](https://coolify.io/docs/knowledge-base/docker/compose)). `SERVICE_PASSWORD_*` values are [magic variables](https://coolify.io/docs/knowledge-base/docker/compose): Coolify generates each one on the first deployment and keeps it. The same name always resolves to the same value in every service. `.env.example` and `llm-docs/IMPLEMENTATION_GUIDE.md` ("Runtime configuration") describe each setting.

None of these values is needed at build time. Clear **Build Variable** on each secret, so it is not passed as a Docker build argument ([environment variables](https://coolify.io/docs/applications/configuration/environment-variables)). `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is read by the server at runtime and passed to the browser, so it does not need to be a build variable either.

**Set by you (required):**

| Variable | Value |
| --- | --- |
| `APP_URL` | The exact public URL, for example `https://cerebro.example.internal` (no trailing slash, no port). It is the canonical base URL, the MCP OAuth audience (`APP_URL/api/mcp`), and the only origin whose Clerk session tokens are accepted |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | From the Clerk production instance |
| `CEREBRO_S3_ENDPOINT`, `CEREBRO_S3_REGION`, `CEREBRO_S3_BUCKET` | From step 3 |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | The bucket-scoped key from step 3 |

**Generated by Coolify (leave as generated):**

| Variable | Used as |
| --- | --- |
| `SERVICE_PASSWORD_POSTGRES` | Postgres superuser password (`postgres` and `migrate` only) |
| `SERVICE_PASSWORD_CEREBRODB` | Password of the `cerebro` owner role (`DATABASE_URL`) |
| `SERVICE_PASSWORD_64_SESSION` | `SESSION_SECRET` |
| `SERVICE_PASSWORD_64_PSEUDONYM` | `ENGAGEMENT_PSEUDONYM_SECRET` (engagement pseudonyms) |
| `SERVICE_PASSWORD_READINESS` | `READINESS_TOKEN`, which unlocks the full `/api/ready` details |

**Fixed in the compose file:** `NODE_ENV=production`, `AUTH_MODE=clerk` (the dev sign-in is refused in production), `CEREBRO_OBJECT_STORE=s3`, `DATABASE_URL` (the `cerebro` role on the `postgres` service) and `CEREBRO_BACKUP_DIR=/backups` (worker).

**Optional (empty = off or default):**

| Variable | Notes |
| --- | --- |
| `CEREBRO_S3_FORCE_PATH_STYLE` | `true` for most self-hosted services (default `false`) |
| `CEREBRO_S3_PREFIX`, `CEREBRO_S3_SSE`, `CEREBRO_S3_SSE_KMS_KEY_ID` | Key prefix and server-side encryption, if the service supports it |
| `CEREBRO_OAUTH_ISSUER`, `CEREBRO_OAUTH_JWKS_URL` | MCP OAuth (resource-server side). Set the issuer to the Clerk instance's exact issuer (D13) to enable it. See `packages/integrations/README.md` |
| `CEREBRO_AI_PROVIDER`, `CEREBRO_AI_SDK_MODULE`, `CEREBRO_AI_MODEL`, `CEREBRO_AI_PROVIDER_ID`, `CEREBRO_AI_SDK_EXPORT`, `ANTHROPIC_API_KEY` | AI provider (D12, `packages/ai/README.md`). Empty means the deterministic provider, with no model calls. The provider module must be installed in the images: add it as a dependency of `@cerebro/ai`. The web image copies every installed `@ai-sdk/*` package into the standalone server, and the worker installs `@cerebro/ai`'s dependencies |
| `CEREBRO_EMBEDDINGS`, `CEREBRO_AI_EMBEDDING_MODEL`, `CEREBRO_AI_EMBEDDING_DIMENSIONS`, `CEREBRO_RETRIEVAL_MODE` | Embeddings and retrieval (default `none` and `fts`) |
| `RATE_LIMIT_*`, `AI_USAGE_LIMIT_RUNS`, `AI_USAGE_LIMIT_TOKENS`, `READY_MAX_QUEUED_AGE_SECONDS` | Limits, `<max>/<windowSeconds>` or `off`. None agreed (README "Limits") |
| `RETENTION_SWEEP_INTERVAL_SECONDS` | Worker: schedules retention sweeps (see "Retention") |
| `CEREBRO_OCR`, `CEREBRO_OCR_LANGUAGES` | Worker: OCR on (default) or `off`. English data is bundled |
| `LOG_LEVEL` | `debug`, `info` (default), `warn`, `error` or `silent` |

### 5. Deploy

Click **Deploy**. Coolify builds the two images and starts `postgres`. When Postgres is healthy, it runs `migrate`, then starts `web` and `worker`. In the deployment log, look for:

- `migrate`: `Provisioned database cerebro (created) owned by cerebro (role created); vector extension created.`, then `Applied 0001_extensions, …`. Later deployments print `… (existing) …` and `Database is up to date (postgres)`.
- `worker`: a JSON line with `"event":"worker.started"`.
- `web`: `✓ Ready`, then a healthy status.

If `migrate` fails, `web` and `worker` are not recreated. Read the `migrate` logs, fix the problem and redeploy.

### 6. Check health

```bash
curl -fsS https://cerebro.example.internal/api/health   # {"status":"ok"}: process is up; never touches the database
curl -fsS https://cerebro.example.internal/api/ready    # {"status":"ready","failing":[]} or 503 with failing check names
curl -fsS -H "Authorization: Bearer $READINESS_TOKEN" https://cerebro.example.internal/api/ready
# full details: database latency, migrations applied/expected, job queue depth and age, limit configuration
```

`$READINESS_TOKEN` is the value of `SERVICE_PASSWORD_READINESS` in Coolify. The container health check uses `/api/health` (liveness), so a database outage does not restart healthy web containers. Use `/api/ready` for monitoring. Both endpoints bypass Clerk. The `worker` has no HTTP endpoint, so watch its logs and the `jobs` check in `/api/ready`. Set `READY_MAX_QUEUED_AGE_SECONDS` if a backlog should make the service not-ready.

### 7. Create the first company and owner

Nobody joins a company just by signing in. On first Clerk sign-in, a person either accepts a pending invitation or claims an existing, never-linked Cerebro user with the same **verified** email (`resolveWebIdentity`). On a new deployment, create the first company and its owner from the `worker` container: use the container **Terminal** in Coolify, or a one-off scheduled task with **Execute Now**.

```bash
npm run -s org:bootstrap -- --slug acme --name "Acme Corp" --owner-email owner@acme.example --owner-name "Riley Lee"
# Created company acme (<id>) with owner <id> (new user). The owner can now sign in with that verified email.
```

- `--slug`, `--name` and `--owner-email` are required. The command refuses to run without them. `--owner-name` is optional.
- The command is idempotent: running it again with the same owner changes nothing. It never grants owner rights in a company that already exists. Manage existing companies' members in the app, which audits each change. The bootstrap itself is audited as `organization.bootstrapped`.
- The owner then opens `https://cerebro.example.internal/sign-in` and signs in with Clerk using that email, which must be verified in Clerk. The first sign-in links the Clerk identity to the bootstrapped user. The owner invites everyone else from the company's admin pages.

### 8. Scheduled tasks

Configure these under the application's **Scheduled Tasks** ([application scheduled tasks](https://coolify.io/docs/applications/operations/scheduled-tasks)). Set **Container** to `worker` (the compose service name), and enter the command as it runs inside the container. The schedule uses the server's timezone, and the default timeout is 300 seconds ([cron syntax](https://coolify.io/docs/knowledge-base/cron-syntax)). Each run's output appears under **Recent executions**. A run fails if the `worker` container is not running.

| Task | Command | Notes |
| --- | --- | --- |
| Database backup | `npm run -s db:backup` | Writes `/backups/<timestamp>/` to the `cerebro-backups` volume (see "Backups") |
| Retention sweep (alternative to the interval) | `npm run -s retention:sweep` | Applies every organization's retention policy once. With no period set, the default, it deletes nothing |

You choose the frequency. None has been agreed.

## Backups

**Database.** `npm run db:backup` in the `worker` container runs `pg_dump --format=custom` with the image's PostgreSQL 17 client. It writes a directory to `/backups` containing `manifest.json` and `database.pgdump`. The directory is private (0700) and the dump is 0600. It is the same format as local backups (README "Backup and restore").

- **Off-site copies and backup retention are not automated.** The `cerebro-backups` volume is on the same server as the database. Copy backup directories elsewhere with your normal tooling, and prune them under the backup-retention policy you adopt (none is set).
- **Alternative: a Coolify-managed database.** Coolify's own PostgreSQL resource offers a PGVector image and scheduled `pg_dump` backups uploaded to an S3 storage you register in Coolify ([PostgreSQL](https://coolify.io/docs/databases/postgresql), [database backups](https://coolify.io/docs/databases/backups), [S3 storage](https://coolify.io/docs/knowledge-base/s3/introduction)). To use one, remove the `postgres` service and its `depends_on` entries from the compose file. Enable **Connect To Predefined Network**. Point `DATABASE_URL` (owner) and `DATABASE_ADMIN_URL` (the resource's superuser, any database) at the resource's internal URL. `migrate` provisions it in the same way.

**Source objects.** With `CEREBRO_OBJECT_STORE=s3`, `db:backup` does **not** copy the bucket. Its manifest reports 0 objects. Object backup for the S3 store is an open item from the D11 review. Until it is decided, back up the bucket with the storage service's own mechanisms (versioning, replication or snapshots, whichever it supports). Database rows refer to objects by content hash, so keep bucket copies at least as long as the database backups that reference them.

**Restore.** Restore in a maintenance window, because writes made during a restore are lost. From the `worker` container:

```bash
CEREBRO_ALLOW_PRODUCTION_RESTORE=1 npm run -s db:restore -- /backups/<timestamp> --yes
```

This replaces the database's contents (`pg_restore --clean --if-exists`) as the `cerebro` owner. The provisioned `vector` extension stays in place. Then redeploy, or restart `web` and `worker`. To restore onto a new server, deploy once (so that `migrate` provisions an empty database), copy the backup directory into the `cerebro-backups` volume, and run the command above. Restore the bucket separately.

Test restores on a non-production environment before you rely on a backup. A successful backup run only shows that a file was written.

## Retention

Retention periods are per-organization rows (`retention_policies`). None is set, so nothing is ever deleted. To apply policies after you set them, choose one of:

- set `RETENTION_SWEEP_INTERVAL_SECONDS` on the worker, which schedules `apply_retention` jobs in process; or
- add the `npm run -s retention:sweep` scheduled task (step 8).

## Logs

Every service logs to stdout, which you can view per service in Coolify's logs view for the application. The web app, worker, MCP adapter, AI runs, rate limiter and retention write structured JSON lines (one object per line) through a redaction allowlist. Source text, prompts, questions and answers are never logged. `LOG_LEVEL` controls verbosity. Ship these logs to a central system with your usual Docker log tooling, since none is chosen here.

## Upgrades

1. Run the **Database backup** scheduled task with **Execute Now**, and back up the bucket.
2. Push or merge to the deployed branch (deployed automatically when the repository webhook or Git App is set up), or click **Deploy**.
3. Coolify rebuilds the images, and `migrate` applies new migrations before new `web` and `worker` containers are created. Compose deployments do not use Coolify's rolling replacement ([build and deployment model](https://coolify.io/docs/core/build-deployment-model)). Expect a short interruption while `web` is recreated. The previous `web` keeps serving while `migrate` runs, so a migration must stay compatible with the running version (additive changes first, removals in a later release).
4. Check `/api/ready` (migrations `applied` = `expected`) and the worker log.

## Rollback

Migrations are forward-only: there are no down migrations.

- **No migration in the release:** redeploy the previous commit.
- **The release added migrations:** the previous version must tolerate the newer schema, which is the case when migrations are additive (step 3 of "Upgrades"). Otherwise, restore the backup taken before the upgrade, then deploy the previous commit. `migrate` refuses to run if an applied migration file has changed, and the readiness check reports migrations it does not know.

## Security notes

- Only `web` has a domain. Do not enable public access for Postgres. The superuser password is used only by `postgres` and `migrate`.
- `AUTH_MODE=dev` cannot run in production, and dev MCP connection tokens are refused in production. Never set `CEREBRO_ALLOW_DEV_CONNECTION_TOKENS` in a deployment.
- Containers run as the unprivileged `node` user. The images are writable only where the server writes: Next's cache, `/backups` and `.data` (for the optional local object store).
- The bucket must stay private, and its key should be scoped to it.

## What CI checks

The `images` job in `.github/workflows/ci.yml` builds both images and starts this compose file (without the Coolify-only `exclude_from_hc` key). It uses production settings and dummy credentials from [`smoke-test.env`](smoke-test.env). It then checks:

- the migration step's exit code;
- `/api/health` and `/api/ready` (summary, plus the token-gated details for the database and migrations);
- that the dev sign-in is not served;
- OCR inside the standalone web image;
- worker start-up;
- a second, idempotent migration;
- `org:bootstrap`, run twice;
- `db:backup` with the image's `pg_dump`, and a retention sweep.

CI does not check Clerk sign-in, the S3 service or Coolify itself. Check those on your instance after the first deployment.
