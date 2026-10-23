# Cerebro

Interactive, evidence-backed executive briefings. Planning documents live in [`llm-docs/`](llm-docs/README.md); agent guidance is in [`AGENTS.md`](AGENTS.md).

This is a local-testing build. It is not production-ready. Production pieces (Clerk sign-in, MCP OAuth, S3-compatible storage, an AI provider, rate limits and retention) are built but unconfigured, because no vendor, limit or retention period has been chosen. Locally it uses a dev sign-in, dev MCP connection tokens, a deterministic AI provider that answers only from published content, and the filesystem.

## Quick start

Requirements: Node 22+ (tested on Node 26), npm. No database server is needed: Cerebro uses embedded PGlite at `.data/pglite` unless `DATABASE_URL` is set.

```bash
npm install
npm run db:reset        # migrate + seed the Acme and Globex demo companies
npm run dev             # http://localhost:3000
```

Open <http://localhost:3000/dev/sign-in> and pick a user:

| User | Role in Acme | Useful for |
| --- | --- | --- |
| Riley Lee | Owner/admin, author of the strategy brief | Authoring, publishing, admin, settings |
| Maya Chen | Member (Product: Platform, Experience) | Reading, team-restricted briefs, feedback |
| Alex Rivera | Member (Engineering: Infrastructure; Product: Platform) | Discovery across departments |
| Priya Shah | Member (explicit Product department member; Finance: Planning) | Department audiences |
| Jordan Ellis | Member (Go-to-market: Marketing, Sales) | Cannot see Platform team brief |
| Sam Taylor | Member (Engineering: Applications) | |
| Casey Morgan | External reader (no membership) | Reads only the granted strategy brief |
| Taylor Kim | Globex owner | Tenant isolation |

Only one process can open the PGlite data directory. Stop `npm run dev` before running `npm run db:reset`. Background jobs (Q&A indexing, extraction, topic summaries) run inside the web process under PGlite.

### Real Postgres (optional)

```bash
docker compose up -d
export DATABASE_URL=postgres://cerebro:cerebro@localhost:5432/cerebro
npm run db:reset
npm run dev            # web
npm run worker         # background jobs (required with DATABASE_URL)
```

The `DATABASE_URL` user is the owner/migration role. The compose user is a superuser. A non-superuser owner needs `BYPASSRLS` (tables force row-level security and no policy targets the owner) and `CREATEROLE` (migrations create `cerebro_app` and grant it to the owner), and a superuser must first run `create extension vector` in the database, since pgvector is not a trusted extension. `db:reset` drops schema `public`, and the extension with it, so it needs a superuser; use `db:migrate` and `db:seed` otherwise.

### Source object storage (optional)

Uploaded source files are stored privately by content hash. By default they go to `.data/objects`. To use any S3-compatible service instead, set `CEREBRO_OBJECT_STORE=s3` with `CEREBRO_S3_ENDPOINT`, `CEREBRO_S3_REGION`, `CEREBRO_S3_BUCKET` and the standard `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` (see `.env.example` for optional path-style, prefix and server-side encryption settings). No provider is assumed. The bucket must be private: Cerebro sends no ACLs, writes with `If-None-Match: *`, verifies hashes on read, and never serves bytes from the bucket directly. The web app and worker refuse to start if `s3` is selected but misconfigured.

The S3 integration test (`packages/domain/src/sources/s3-store.integration.test.ts`) runs only when `TEST_S3_ENDPOINT` is set:

```bash
TEST_S3_ENDPOINT=http://127.0.0.1:9100 TEST_S3_ACCESS_KEY_ID=… TEST_S3_SECRET_ACCESS_KEY=… \
  npx vitest run packages/domain/src/sources/s3-store.integration.test.ts
```

## What to try

1. **Library**: `/c/acme`. Shared company library, Department → Team tree, filters, search, My drafts.
2. **Reader**: open "Our next chapter: a focused move upmarket". Try the perspective chips, evidence markers, "Ask about this" (grounded Q&A with citations, private by default), and "Respond to the author".
3. **Author flow** (as Riley): Edit → Preview & publish → History (compare, withdraw) → Access (audience, grants, share links) → Engagement.
4. **New brief**: `/c/acme/new` from blank, Markdown, a handoff JSON or an uploaded PDF/DOCX/PPTX or image (PNG/JPEG/WebP, read by OCR in the background).
5. **Send this to Cerebro (MCP)**: in Settings → Connections, create a development connection token, then:

   ```bash
   claude mcp add --transport http cerebro http://localhost:3000/api/mcp \
     --header "Authorization: Bearer cbr_…"
   ```

   Ask your LLM: "Turn this into a Cerebro brief for the Platform team. Make it visible to the company." The tools create a private draft, show a preview with home and audience, and publish only when you explicitly ask. See [`packages/integrations/README.md`](packages/integrations/README.md). ChatGPT needs OAuth and a public URL, so it cannot connect with dev tokens.

## Production configuration (unconfigured by default)

Every setting is documented in `.env.example` and `llm-docs/IMPLEMENTATION_GUIDE.md`. Nothing below has a vendor default.

- **Web sign-in:** `AUTH_MODE=clerk` with `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`. First sign-in needs a pending invitation for the verified email. `AUTH_MODE=dev` is refused when `NODE_ENV=production`.
- **MCP OAuth:** set `CEREBRO_OAUTH_ISSUER` to the chosen authorization server's issuer, and `APP_URL` to the public HTTPS URL, which defines the token audience. Metadata is served at `/.well-known/oauth-protected-resource`. See `packages/integrations/README.md`.
- **AI provider (Anthropic, D12):** `CEREBRO_AI_PROVIDER=anthropic` with `ANTHROPIC_API_KEY` (model default `claude-opus-5-5` via `CEREBRO_AI_MODEL`). Each organization must allow the provider id `anthropic` in its settings before its data is sent there. The generic `CEREBRO_AI_PROVIDER=ai-sdk` path (`CEREBRO_AI_SDK_MODULE`, `CEREBRO_AI_MODEL`) remains. `npm run ai:eval` writes answer and retrieval metrics to `.data/ai-eval/`; `npm run ai:live` checks every task against Claude when credentials exist. See `packages/ai/README.md`.
- **Embeddings and retrieval:** `CEREBRO_EMBEDDINGS` (`none`, `local` or `ai-sdk`) and `CEREBRO_RETRIEVAL_MODE` (`fts`, the default, or `hybrid`). Anthropic has no embeddings API; the embedding source is still open.
- **Object storage:** see "Source object storage" above.

## Operations

Nothing here sets a pilot target: no limits, retention periods, cost caps or latency targets have been agreed (P11, P12). Every limit below is **off unless you set it**.

### Backup and restore

```bash
npm run db:backup                         # → .data/backups/<timestamp> (or --out <dir>, or CEREBRO_BACKUP_DIR)
npm run db:restore -- <backup dir> --yes  # restore database + object store
```

A backup directory holds `manifest.json` (time, database kind, applied migrations, object count; no content), the database (`database.pglite.tar.gz` from PGlite's `dumpDataDir`, or `database.pgdump` from `pg_dump --format=custom`) and a copy of the private object store (`.data/objects` or `CEREBRO_OBJECTS_DIR`). Under PGlite, stop `npm run dev` first. A PGlite restore moves the current data and object directories aside to `<dir>.pre-restore-<timestamp>` rather than deleting them; a Postgres restore runs `pg_restore --clean --if-exists` into `DATABASE_URL`. Postgres tools come from `PG_BIN_DIR` if set, else `PATH`. Scheduling, encryption and off-site copies depend on the undecided hosting choice (T10) and are not automated here. Tests: `packages/database/test/backup.test.ts` (PGlite) and `packages/domain/test/postgres.test.ts` (Postgres, runs when the binaries are available).

### Retention and deletion

Per-organization retention lives in `retention_policies` (categories `sources`, `conversations`, `events`). With no period set — the default — nothing is ever deleted. When a period is set, the `apply_retention` job deletes expired data and everything derived from it (source objects, chunks and embeddings, links and draft-side candidate evidence; Q&A messages and citations), and audits the counts. Published revisions, their approved evidence, submitted feedback and audit events are not deleted by this mechanism. Sweeps are scheduled only when `RETENTION_SWEEP_INTERVAL_SECONDS` is set; `npm run retention:sweep` applies the policies once. Authors (and owners/admins, as the privileged erasure path) can hard-delete a source with `deleteSource`.

### Monitoring

- `GET /api/health` — liveness; never touches the database.
- `GET /api/ready` — 200/503 on database reachability, current migrations, job queue (depth, oldest pending age) and valid limit configuration. Full details only with `Authorization: Bearer $READINESS_TOKEN`; everyone else gets the status and failing check names.
- Structured JSON logs (one object per line) from the job runner, MCP adapter, AI runs, rate limiter and retention. Fields pass a redaction allowlist, so source text, prompts, questions and answers cannot be logged. `LOG_LEVEL` = `debug` | `info` (default) | `warn` | `error` | `silent`.

### Limits

| Variable | Meaning (format `<max>/<windowSeconds>`, or `off`) |
| --- | --- |
| `RATE_LIMIT_MCP_TOOL_PER_USER`, `RATE_LIMIT_MCP_TOOL_PER_CONNECTION` | MCP tool calls |
| `RATE_LIMIT_QA_PER_USER`, `RATE_LIMIT_QA_PER_CONNECTION` | Reader questions |
| `RATE_LIMIT_UPLOAD_PER_USER`, `RATE_LIMIT_UPLOAD_PER_CONNECTION` | Source uploads |
| `AI_USAGE_LIMIT_RUNS`, `AI_USAGE_LIMIT_TOKENS` | Per-organization AI runs / tokens; an organization's `settings.ai.usageLimits.{runs,tokens}` overrides |
| `READY_MAX_QUEUED_AGE_SECONDS` | Make `/api/ready` fail when the oldest runnable job is older than this |

Rate limits are fixed-window counters in Postgres (`rate_limit_counters`), shared by every process. Exceeding one returns `rate_limited` with a retry-after (an MCP tool error with `retry_after_seconds`; HTTP 429 mapping in the web app). At an AI usage limit, Q&A answers "unavailable" exactly as during a provider outage and reading is unaffected; topic summaries retry later. AI usage (task, provider, model, latency, tokens when reported; never content) is recorded in `ai_runs` and summarised for owners/admins by `getAiUsageSummary`. The reader Q&A per-briefing hourly cap in `ENGAGEMENT_SETTINGS` predates this and remains a provisional implementation setting.

### Latency measurement

```bash
npm run perf    # p50/p95 for library list, reader open, Q&A (deterministic), preview, publish on in-memory PGlite
```

It prints numbers only; there are no agreed targets to compare against.

## Tests

```bash
npm test               # Vitest: domain, security regression, RLS under the runtime role, AI eval, MCP
npm run typecheck      # tsc --noEmit for every package and app
npm run test:e2e       # Playwright journeys on their own .data/pglite-e2e
```

Vitest uses in-memory PGlite by default. To run the same suites against a PostgreSQL 17 server with pgvector, set `TEST_DATABASE_URL` to an owner/superuser URL (for example its `postgres` database). Each test database is created from a migrated template and dropped when the test closes it:

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npx vitest run
```

Playwright uses `PLAYWRIGHT_CHROMIUM_PATH`, else `/usr/bin/chromium`, else its own Chromium (`npx playwright install chromium`). `E2E_PORT` changes the port (default 3400). With `E2E_EXTERNAL_SERVER=1` it uses a server you started yourself, such as `next dev` and `npm run worker` against `DATABASE_URL`. CI (`.github/workflows/ci.yml`) runs typecheck, Vitest in both modes, the database CLI against PostgreSQL, and Playwright on PGlite and on PostgreSQL with a separate worker.

## Layout

```text
apps/web               Next.js app (library, reader, editor, preview/publish, admin, /api/mcp)
apps/worker            Job runner for Postgres deployments
packages/domain        Domain services and authorization (the security boundary)
packages/database      Drizzle schema, SQL migrations with RLS, PGlite/Postgres client, jobs, seed
packages/briefing-schema  Document schema, validation, diff, LLM handoff contract, fixtures
packages/briefing-renderer Shared reader/preview renderer
packages/ui            Design tokens and primitives
packages/ai            Task interfaces, deterministic provider, answer validation, evaluation set
packages/capture       Text/Markdown/PDF/DOCX/PPTX extraction with locators; local OCR for scans and images
packages/integrations  MCP server for LLM-native authoring
```
