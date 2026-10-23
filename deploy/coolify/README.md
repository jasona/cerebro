# Deploying Cerebro on Coolify

Runbook for hosting Cerebro internally on [Coolify](https://coolify.io/docs/) (decision D14). It covers the first deployment, the first owner, health checks, backups, retention, upgrades and rollback.

The backup schedule and backup retention are decided (D26: nightly at 03:00 server time, database and source objects, 14 days kept locally, off-site when a destination is configured), and so is the object store (D25: SeaweedFS inside this stack). Nothing else here sets a target: rate limits, data retention periods, latency targets and cost caps are off until you set them (D18, D21, D22).

## What gets deployed

One Coolify **Application** built from this repository with the **Docker Compose** build pack, using [`deploy/coolify/docker-compose.yml`](docker-compose.yml):

| Service | Image | Role |
| --- | --- | --- |
| `postgres` | `pgvector/pgvector:pg17` | PostgreSQL 17 with pgvector. Data is kept in the `cerebro-postgres` volume. No port is published. |
| `objects` | `chrislusf/seaweedfs:4.48` | [SeaweedFS](https://github.com/seaweedfs/seaweedfs) (D25): the private S3-compatible store for uploaded source files, reachable only inside the stack at `http://objects:8333`. Data is kept in the `cerebro-objects` volume. No port is published and no domain is assigned. |
| `migrate` | [`deploy/docker/worker.Dockerfile`](../docker/worker.Dockerfile) | A one-shot step on every deployment. `db:provision` runs as the Postgres superuser and creates the owner role, the `cerebro` database and the `vector` extension. `db:migrate` then runs as the owner, and `objects:init` creates the source bucket if it does not exist. Must exit 0 before `web` and `worker` start. |
| `web` | [`deploy/docker/web.Dockerfile`](../docker/web.Dockerfile) | The Next.js standalone server on port 3000. Its health check calls `GET /api/health`. |
| `worker` | `deploy/docker/worker.Dockerfile` | The background job runner, also used for scheduled tasks (backups, retention). Backups go to the `cerebro-backups` volume. |

Source files go to the `objects` service by default. To use an S3-compatible service outside the stack instead, see step 3.

### Why this shape

- **Compose build pack, not the Dockerfile build pack.** Cerebro has several processes: web, worker, a migration step and its database. Coolify's Compose build pack deploys them together from Git, with webhooks and previews ([Docker Compose build pack](https://coolify.io/docs/applications/build-packs/docker-compose)). The Dockerfile build pack runs a single container.
- **A `migrate` service, not a pre-deployment command.** Coolify runs a pre-deployment command inside the *currently running* container and skips it when none exists, for example on the first deployment ([Dockerfile build pack](https://coolify.io/docs/applications/build-packs/dockerfile)). Compose deployments run `docker compose up` ([build and deployment model](https://coolify.io/docs/core/build-deployment-model)). With `depends_on: condition: service_completed_successfully`, new web and worker containers are created only after migrations succeed. `exclude_from_hc: true` stops the exited one-shot container from counting against the stack's health ([Compose in Coolify](https://coolify.io/docs/knowledge-base/docker/compose)).
- **No superuser at runtime.** The app connects as the `cerebro` owner role, which has `CREATEROLE` and `BYPASSRLS` but not `SUPERUSER`, and switches to `cerebro_app` for every request (row-level security). Only `postgres` and the one-shot `migrate` container hold the superuser password. CI and `packages/database/test/provision.test.ts` check that this owner can migrate, seed, back up, restore and run under RLS.

## Prerequisites

- A Coolify instance with a server, and an internal hostname with TLS for Cerebro, for example `https://cerebro.example.internal`. The examples here use that name; replace it with yours.
- A **Clerk** production instance (D08, D13): its publishable key and secret key, with your Cerebro URL allowed as an origin.
- Disk space on the server for the `cerebro-postgres`, `cerebro-objects` and `cerebro-backups` volumes. Local backups hold 14 copies of the database and of every source object (D26), so size the disk for roughly 15 times your data.
- Optional: an **S3-compatible bucket for off-site backup copies** (see "Backups").
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

### 3. Object storage (SeaweedFS in the stack)

Cerebro stores uploaded source files privately by content hash (`CEREBRO_OBJECT_STORE=s3`, `packages/domain/src/sources/s3-store.ts`). By default they go to the `objects` service (D25), which needs no setup:

- **Image:** `chrislusf/seaweedfs:4.48`, the official image, pinned. It runs `weed server -s3`: master, volume server, filer and S3 gateway in one process. Upgrade by changing the tag in the compose file and redeploying, after a backup.
- **Credentials:** Coolify generates `SERVICE_USER_S3` and `SERVICE_PASSWORD_S3` on the first deployment. SeaweedFS reads them as its admin identity (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in the `objects` service), and `web`, `worker` and `migrate` use the same values. Anonymous requests are refused. The filer and volume servers' own HTTP APIs accept only requests signed with `SERVICE_PASSWORD_64_OBJECTSJWT`, so other containers cannot bypass the S3 credentials over plain HTTP. SeaweedFS's internal gRPC ports have no authentication; the stack network is the boundary, so do not publish `objects` ports or give it a domain.
- **Bucket:** `cerebro-sources`, created by `objects:init` in the `migrate` step (HeadBucket, then CreateBucket; "already exists" counts as success). It is private: Cerebro never sets ACLs and serves bytes only through authorized domain services.
- **Settings in `web` and `worker`:** `CEREBRO_S3_ENDPOINT=http://objects:8333`, `CEREBRO_S3_BUCKET=cerebro-sources`, `CEREBRO_S3_FORCE_PATH_STYLE=true` and `CEREBRO_S3_REGION=us-east-1`. SeaweedFS accepts any region; `us-east-1` is a nominal value that the AWS SDK requires.
- **Immutability:** the store writes with `If-None-Match: *`, so an existing object is never overwritten. SeaweedFS enforces this (a conditional put of an existing key gets HTTP 412); CI checks it against this image on every run.
- **Volumes:** each bucket starts with one SeaweedFS volume (`WEED_MASTER_VOLUME_GROWTH_COPY_1=1`) and more are added as they fill, up to the free disk space at 1 GB each.

**Using an external S3-compatible service instead.** Create a private bucket and a key limited to it (read, write, delete, list; plus create-bucket only if you want `objects:init` to create it). Then set, on the application's Environment Variables page:

| Variable | Value |
| --- | --- |
| `CEREBRO_S3_ENDPOINT` | The service's URL. A Compose stack has its own network: for a service deployed as another Coolify resource, enable **Connect To Predefined Network** and use its renamed host (`<service>-<uuid>`), or use its HTTPS URL ([Networking in Coolify](https://coolify.io/docs/core/networking-in-coolify)) |
| `CEREBRO_S3_REGION`, `CEREBRO_S3_BUCKET` | The bucket's region and name |
| `CEREBRO_S3_FORCE_PATH_STYLE` | `true` (the default here) for most self-hosted services; `false` for virtual-hosted-style services |
| `CEREBRO_S3_ACCESS_KEY_ID`, `CEREBRO_S3_SECRET_ACCESS_KEY` | The bucket-scoped key. These take precedence over the generated `AWS_*` values |

Remove the `objects` service, its `depends_on` entry under `migrate` and the `cerebro-objects` volume from your copy of the compose file, or leave it running unused. To move existing objects, take a backup with the old settings and restore it with the new ones (see "Backups"); `db:restore` writes every object to the configured store.

`web` and `worker` validate the S3 settings at start (no network call) and refuse to start if they are incomplete. Bucket and credential problems surface in the `migrate` step (`objects:init`).

### 4. Environment variables

Set these on the application's **Environment Variables** page. The compose file marks required variables `${VAR:?}`, and Coolify blocks the deployment until they are set ([environment syntax](https://coolify.io/docs/knowledge-base/docker/compose)). `SERVICE_PASSWORD_*` values are [magic variables](https://coolify.io/docs/knowledge-base/docker/compose): Coolify generates each one on the first deployment and keeps it. The same name always resolves to the same value in every service. `.env.example` and `llm-docs/IMPLEMENTATION_GUIDE.md` ("Runtime configuration") describe each setting.

None of these values is needed at build time. Clear **Build Variable** on each secret, so it is not passed as a Docker build argument ([environment variables](https://coolify.io/docs/applications/configuration/environment-variables)). `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is read by the server at runtime and passed to the browser, so it does not need to be a build variable either.

**Set by you (required):**

| Variable | Value |
| --- | --- |
| `APP_URL` | The exact public URL, for example `https://cerebro.example.internal` (no trailing slash, no port). It is the canonical base URL, the MCP OAuth audience (`APP_URL/api/mcp`), and the only origin whose Clerk session tokens are accepted |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | From the Clerk production instance |

**Generated by Coolify (leave as generated):**

| Variable | Used as |
| --- | --- |
| `SERVICE_PASSWORD_POSTGRES` | Postgres superuser password (`postgres` and `migrate` only) |
| `SERVICE_PASSWORD_CEREBRODB` | Password of the `cerebro` owner role (`DATABASE_URL`) |
| `SERVICE_PASSWORD_64_SESSION` | `SESSION_SECRET` |
| `SERVICE_PASSWORD_64_PSEUDONYM` | `ENGAGEMENT_PSEUDONYM_SECRET` (engagement pseudonyms) |
| `SERVICE_PASSWORD_READINESS` | `READINESS_TOKEN`, which unlocks the full `/api/ready` details |
| `SERVICE_USER_S3`, `SERVICE_PASSWORD_S3` | The SeaweedFS admin access key and secret (`objects`), used by `web`, `worker` and `migrate` as `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` |
| `SERVICE_PASSWORD_64_OBJECTSJWT` | Signs SeaweedFS's internal filer and volume HTTP requests (`objects` only) |

**Fixed in the compose file:** `NODE_ENV=production`, `AUTH_MODE=clerk` (the dev sign-in is refused in production), `CEREBRO_OBJECT_STORE=s3`, `DATABASE_URL` (the `cerebro` role on the `postgres` service) and `CEREBRO_BACKUP_DIR=/backups` (worker).

**Defaults you can override:** `CEREBRO_S3_ENDPOINT` (`http://objects:8333`), `CEREBRO_S3_BUCKET` (`cerebro-sources`), `CEREBRO_S3_REGION` (`us-east-1`), `CEREBRO_S3_FORCE_PATH_STYLE` (`true`) and `CEREBRO_BACKUP_KEEP` (`14`, D26).

**Optional (empty = off or default):**

| Variable | Notes |
| --- | --- |
| `CEREBRO_S3_ACCESS_KEY_ID`, `CEREBRO_S3_SECRET_ACCESS_KEY` | Credentials for an external S3 store (step 3); they take precedence over the generated SeaweedFS key |
| `CEREBRO_S3_PREFIX`, `CEREBRO_S3_SSE`, `CEREBRO_S3_SSE_KMS_KEY_ID` | Key prefix and server-side encryption, if the service supports it (SeaweedFS in this stack does not need them) |
| `CEREBRO_BACKUP_S3_ENDPOINT`, `CEREBRO_BACKUP_S3_BUCKET`, `CEREBRO_BACKUP_S3_ACCESS_KEY_ID`, `CEREBRO_BACKUP_S3_SECRET_ACCESS_KEY`, `CEREBRO_BACKUP_S3_REGION`, `CEREBRO_BACKUP_S3_FORCE_PATH_STYLE`, `CEREBRO_BACKUP_S3_PREFIX`, `CEREBRO_BACKUP_S3_SSE` | Worker: off-site backup copies (see "Backups"). Off unless the endpoint and bucket are set |
| `CEREBRO_OAUTH_ISSUER`, `CEREBRO_OAUTH_JWKS_URL` | MCP OAuth (resource-server side). Set the issuer to the Clerk instance's exact issuer (D13) to enable it. See `packages/integrations/README.md` |
| `CEREBRO_AI_PROVIDER`, `CEREBRO_AI_SDK_MODULE`, `CEREBRO_AI_MODEL`, `CEREBRO_AI_PROVIDER_ID`, `CEREBRO_AI_SDK_EXPORT`, `ANTHROPIC_API_KEY` | AI provider (D12, `packages/ai/README.md`). Empty means the deterministic provider, with no model calls. The provider module must be installed in the images: add it as a dependency of `@cerebro/ai`. The web image copies every installed `@ai-sdk/*` package into the standalone server, and the worker installs `@cerebro/ai`'s dependencies |
| `CEREBRO_EMBEDDINGS`, `CEREBRO_AI_EMBEDDING_MODEL`, `CEREBRO_AI_EMBEDDING_DIMENSIONS`, `CEREBRO_RETRIEVAL_MODE` | Embeddings and retrieval (default `none` and `fts`) |
| `RATE_LIMIT_*`, `AI_USAGE_LIMIT_RUNS`, `AI_USAGE_LIMIT_TOKENS`, `READY_MAX_QUEUED_AGE_SECONDS` | Limits, `<max>/<windowSeconds>` or `off`. None agreed (README "Limits") |
| `RETENTION_SWEEP_INTERVAL_SECONDS` | Worker: schedules retention sweeps (see "Retention") |
| `CEREBRO_OCR`, `CEREBRO_OCR_LANGUAGES` | Worker: OCR on (default) or `off`. English data is bundled |
| `LOG_LEVEL` | `debug`, `info` (default), `warn`, `error` or `silent` |

### 5. Deploy

Click **Deploy**. Coolify builds the two images and starts `postgres` and `objects`. When both are healthy, it runs `migrate`, then starts `web` and `worker`. In the deployment log, look for:

- `migrate`: `Provisioned database cerebro (created) owned by cerebro (role created); vector extension created.`, then `Applied 0001_extensions, …` and `Bucket cerebro-sources created.` Later deployments print `… (existing) …`, `Database is up to date (postgres)` and `Bucket cerebro-sources already exists.`
- `objects`: a healthy status (its health check calls the S3 gateway's `/healthz`).
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

Add these under the application's **Scheduled Tasks** ([application scheduled tasks](https://coolify.io/docs/applications/operations/scheduled-tasks)). Coolify cannot declare scheduled tasks in the compose file, so this is a manual step. Set **Container** to `worker` (the compose service name), and enter the command as it runs inside the container. The schedule uses the server's timezone ([cron syntax](https://coolify.io/docs/knowledge-base/cron-syntax)). Each run's output appears under **Recent executions**. A run fails if the `worker` container is not running.

| Name | Command | Frequency | Container | Notes |
| --- | --- | --- | --- | --- |
| Backup | `npm run -s db:backup` | `0 3 * * *` | `worker` | D26: nightly at 03:00. Database and every source object, then the off-site copy (if configured), then pruning to the newest 14 (see "Backups") |
| Retention sweep | `npm run -s retention:sweep` | `0 4 * * *` | `worker` | Applies each organization's retention policy. With no period set (the default, D18) it deletes nothing, so it is harmless to schedule now |

Raise the task **Timeout** (default 300 seconds) if a backup with many objects or an off-site upload takes longer: check the duration of the first runs under **Recent executions**.

## Backups

Backups follow D26: every night at 03:00 server time (step 8), covering the database **and** the stored source objects, keeping 14 days locally, with an off-site copy when a destination is configured.

**What `db:backup` does** (in the `worker` container, `packages/domain/src/cli/backup.ts`):

1. **Database:** `pg_dump --format=custom` with the image's PostgreSQL 17 client, into `/backups/<UTC timestamp>/database.pgdump`.
2. **Source objects:** every object under the store's prefix in the bucket is streamed to `objects/<organization id>/<sha256>`. Each object's sha256 is checked while it is written, and a mismatch fails the backup. An object deleted between the dump and the copy (a source deleted during the backup) is counted as `missing` in the manifest.
3. **Manifest:** `manifest.json` (format version, time, database kind, applied migrations, object count, bytes and store; no content) is written last, so a directory with a manifest is a complete backup. The directory is private (0700) and its files 0600.
4. **Off-site copy:** when `CEREBRO_BACKUP_S3_ENDPOINT` and `CEREBRO_BACKUP_S3_BUCKET` are set, every file is uploaded to `<CEREBRO_BACKUP_S3_PREFIX, default cerebro-backups>/<UTC timestamp>/…` in that bucket, `manifest.json` last, and each upload's size is checked. When they are not set, the run prints `No off-site copy made`. A failed upload fails the run (exit 1), so it shows as failed in Coolify, but the local backup is kept.
5. **Pruning:** keeps the newest `CEREBRO_BACKUP_KEEP` (default 14) complete backups in `/backups` and deletes older ones. Only directories with a valid Cerebro manifest are counted or deleted; incomplete backups and anything else in the volume are left alone. `CEREBRO_BACKUP_KEEP=off` disables pruning. With one run a night, 14 backups are 14 days; extra runs (for example **Execute Now** before an upgrade) count toward the 14.

Credentials never appear in logs or command lines: the database password goes to `pg_dump` in `PGPASSWORD`, and S3 keys go only to the SDK (D11).

**Off-site destination.** Use any S3-compatible bucket that is not on this server, for example the S3 storage you registered in Coolify for its own backups ([S3 storage](https://coolify.io/docs/knowledge-base/s3/introduction)) or another provider. Create a dedicated bucket or prefix and a key limited to it (write and read is enough; Cerebro never deletes off-site copies). Then set on the application:

| Variable | Value |
| --- | --- |
| `CEREBRO_BACKUP_S3_ENDPOINT` | The service URL, for example `https://s3.example.internal` |
| `CEREBRO_BACKUP_S3_BUCKET` | The bucket name |
| `CEREBRO_BACKUP_S3_ACCESS_KEY_ID`, `CEREBRO_BACKUP_S3_SECRET_ACCESS_KEY` | The key (both required once the endpoint or bucket is set) |
| `CEREBRO_BACKUP_S3_REGION` | Optional, default `us-east-1` (a nominal value for services that ignore regions) |
| `CEREBRO_BACKUP_S3_FORCE_PATH_STYLE` | `true` for most self-hosted services (default `false`) |
| `CEREBRO_BACKUP_S3_PREFIX`, `CEREBRO_BACKUP_S3_SSE` | Optional key prefix (default `cerebro-backups`) and server-side encryption (`AES256` or `aws:kms`) |

A half-configured destination fails the run before anything is written, naming the missing variables. Cerebro does not prune off-site copies: set a lifecycle rule on the destination bucket (for example, expire objects under the prefix after the period you want to keep). Backups contain every tenant's data and are not encrypted by Cerebro, so use a private bucket, server-side encryption where the service supports it, and restricted keys. Each file is sent with a single PUT, which S3 limits to 5 GB per file.

**Alternative: a Coolify-managed database.** Coolify's own PostgreSQL resource offers a PGVector image and scheduled `pg_dump` backups uploaded to an S3 storage you register in Coolify ([PostgreSQL](https://coolify.io/docs/databases/postgresql), [database backups](https://coolify.io/docs/databases/backups)). To use one, remove the `postgres` service and its `depends_on` entries from the compose file. Enable **Connect To Predefined Network**. Point `DATABASE_URL` (owner) and `DATABASE_ADMIN_URL` (the resource's superuser, any database) at the resource's internal URL. `migrate` provisions it in the same way. Keep the `db:backup` task anyway: it is what backs up the source objects.

**Check a backup** without changing anything:

```bash
npm run -s db:restore -- /backups/<timestamp> --check
# Backup verified: postgres, 10 migrations, 42 objects (…), sha256 checked.
```

**Restore.** Restore in a maintenance window, because writes made during a restore are lost. From the `worker` container:

```bash
CEREBRO_ALLOW_PRODUCTION_RESTORE=1 npm run -s db:restore -- /backups/<timestamp> --yes
```

The backup is verified first (manifest, database file size, every object's sha256). Then the database's contents are replaced (`pg_restore --clean --if-exists`) as the `cerebro` owner, keeping the provisioned `vector` extension, and every object in the backup is written back to the configured store with the same immutable put the app uses. Objects already in the bucket are kept, and objects that are not in the backup are not deleted. Then redeploy, or restart `web` and `worker`.

To restore onto a new server or a fresh bucket: deploy once (so `migrate` provisions an empty database and creates the bucket), copy the backup directory into the `cerebro-backups` volume (from the off-site bucket if the server was lost), and run the command above. CI restores a backup into a fresh database and bucket on every run.

Test restores on a non-production environment before you rely on a backup. A successful backup run only shows that files were written and their hashes matched.

## Retention

Retention periods are per-organization rows (`retention_policies`). None is set, so nothing is ever deleted. To apply policies after you set them, choose one of:

- set `RETENTION_SWEEP_INTERVAL_SECONDS` on the worker, which schedules `apply_retention` jobs in process; or
- add the `npm run -s retention:sweep` scheduled task (step 8).

## Logs

Every service logs to stdout, which you can view per service in Coolify's logs view for the application. The web app, worker, MCP adapter, AI runs, rate limiter and retention write structured JSON lines (one object per line) through a redaction allowlist. Source text, prompts, questions and answers are never logged. `LOG_LEVEL` controls verbosity. Ship these logs to a central system with your usual Docker log tooling, since none is chosen here.

## Upgrades

1. Run the **Backup** scheduled task with **Execute Now** (it covers the database and the source objects).
2. Push or merge to the deployed branch (deployed automatically when the repository webhook or Git App is set up), or click **Deploy**.
3. Coolify rebuilds the images, and `migrate` applies new migrations before new `web` and `worker` containers are created. Compose deployments do not use Coolify's rolling replacement ([build and deployment model](https://coolify.io/docs/core/build-deployment-model)). Expect a short interruption while `web` is recreated. The previous `web` keeps serving while `migrate` runs, so a migration must stay compatible with the running version (additive changes first, removals in a later release).
4. Check `/api/ready` (migrations `applied` = `expected`) and the worker log.

## Rollback

Migrations are forward-only: there are no down migrations.

- **No migration in the release:** redeploy the previous commit.
- **The release added migrations:** the previous version must tolerate the newer schema, which is the case when migrations are additive (step 3 of "Upgrades"). Otherwise, restore the backup taken before the upgrade, then deploy the previous commit. `migrate` refuses to run if an applied migration file has changed, and the readiness check reports migrations it does not know.

## Security notes

- Only `web` has a domain. Do not enable public access for Postgres or `objects`, and do not publish their ports. The superuser password is used only by `postgres` and `migrate`.
- `AUTH_MODE=dev` cannot run in production, and dev MCP connection tokens are refused in production. Never set `CEREBRO_ALLOW_DEV_CONNECTION_TOKENS` in a deployment.
- Containers run as the unprivileged `node` user. The images are writable only where the server writes: Next's cache, `/backups` and `.data` (for the optional local object store).
- The bucket must stay private. With an external store, scope its key to the bucket. The in-stack SeaweedFS key is an admin key that only `web`, `worker` and `migrate` hold.

## What CI checks

The `images` job in `.github/workflows/ci.yml` builds both images and starts this compose file (without the Coolify-only `exclude_from_hc` key). It uses production settings and dummy credentials from [`smoke-test.env`](smoke-test.env). It then checks:

- the migration step's exit code, and that it created the `cerebro-sources` bucket;
- that `objects` is healthy, has no published port, refuses anonymous S3 requests and unsigned filer requests;
- `/api/health` and `/api/ready` (summary, plus the token-gated details for the database and migrations);
- that the dev sign-in is not served;
- OCR inside the standalone web image;
- worker start-up;
- a second, idempotent migration;
- `org:bootstrap`, run twice;
- a source object stored through the app's S3 store and present in SeaweedFS ([`smoke-objects.mjs`](smoke-objects.mjs));
- `db:backup` with the image's `pg_dump`, containing that object with a matching sha256, and `db:restore --check`;
- an off-site copy to a second bucket (SeaweedFS standing in for the destination);
- `db:restore` into a fresh database and a fresh bucket, after which the company row and the object are back;
- a retention sweep.

The `s3-store` job runs the S3 store and object-backup integration tests (including the `If-None-Match` 412 check) against a SeaweedFS service container of the same version.

CI does not check Clerk sign-in, an external S3 service, Coolify itself or its scheduled tasks. Check those on your instance after the first deployment.
