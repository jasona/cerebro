# Implementation guide

**Status:** Working contract for the first implementation pass (started 2026-10-22). It describes how the code is organised and the interfaces packages rely on. Product rules live in the other planning documents; when they disagree, the planning documents win and this guide must be corrected.

## Workspace

npm workspaces; packages are TypeScript source consumed directly (`"exports": {".": "./src/index.ts"}`), no build step. Strict TypeScript 6 (`tsconfig.base.json`, `noUncheckedIndexedAccess`). Import sibling packages as `@cerebro/<name>`. Use `.js`-less relative imports (bundler resolution). Tests: Vitest from the repo root (`npm test`), files `packages/*/src/**/*.test.ts` or `packages/*/test/**/*.test.ts`.

Dependencies are pre-installed at the root. **Do not run `npm install`** — if a new dependency is truly required, report it instead.

| Package | Owns |
| --- | --- |
| `@cerebro/briefing-schema` | Zod document schema (`src/document.ts`), ids, validation issues, published-document projection, revision diff, LLM handoff schema, sample fixtures |
| `@cerebro/database` | Drizzle schema, SQL migrations (incl. RLS + roles), client factory (PGlite or node-postgres), `withAuthContext`, job queue table helpers, seed |
| `@cerebro/domain` | All domain services and authorization. Every protected read/write goes through here |
| `@cerebro/ai` | Task interfaces (compose, propose revision, answer, summarise topics), deterministic local provider, AI SDK adapter (injected model), retrieval, citation validation |
| `@cerebro/capture` | Text/Markdown/PDF/DOCX/PPTX extraction to chunks with locators; local OCR (tesseract.js, bundled English data) for scanned PDF pages and PNG/JPEG/WebP images, run only in the extraction job; Markdown → draft document |
| `@cerebro/briefing-renderer` | React components rendering a published or preview document (shared by reader, preview, studio canvas) |
| `@cerebro/ui` | Design tokens (CSS variables), Tailwind theme, small accessible primitives |
| `@cerebro/integrations` | MCP server (tools from LLM_INTEGRATION.md) calling domain services; connection-token auth |
| `apps/web` | Next.js App Router application: library, reader, studio, preview/publish, sharing, engagement, admin, settings, `/api/mcp` |
| `apps/worker` | Job runner loop: indexing, extraction, topic summaries |

## Runtime configuration

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Postgres URL. Unset → PGlite persisted at `.data/pglite` (tests use in-memory PGlite) |
| `AUTH_MODE` | `dev` (default locally) enables the dev identity adapter; `clerk` uses Clerk |
| `SESSION_SECRET` | HMAC key for dev session cookies (dev default provided with a warning) |
| `APP_URL` | Canonical base URL, default `http://localhost:3000` |
<<<<<<< HEAD
| `CEREBRO_OCR` | `off` disables OCR in extraction jobs (scanned pages and images are then reported as gaps). Default on |
| `CEREBRO_OCR_LANGUAGES` | Comma-separated Tesseract language codes. Default `eng`; only English data is bundled |
| `CEREBRO_OCR_LANG_PATH` | Local directory of `<lang>.traineddata.gz` files for other languages (never a URL; nothing is downloaded at runtime) |
| `E2E_PORT` | Port for the Playwright dev server, default 3400 |
=======
| `CEREBRO_OBJECT_STORE` | Source byte store: `local` (default, `.data/objects` or `CEREBRO_OBJECTS_DIR`) or `s3` (any S3-compatible service). Unknown values fail at startup |
| `CEREBRO_S3_ENDPOINT`, `CEREBRO_S3_REGION`, `CEREBRO_S3_BUCKET` | Required with `s3`; no provider endpoint or region is assumed. Startup (web `instrumentation.ts`, worker `main.ts`) fails fast, naming missing variables |
| `CEREBRO_S3_FORCE_PATH_STYLE`, `CEREBRO_S3_PREFIX`, `CEREBRO_S3_SSE`, `CEREBRO_S3_SSE_KMS_KEY_ID` | Optional: path-style addressing (`true`/`false`), a key prefix, server-side encryption (`AES256` or `aws:kms` with an optional key id) |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | S3 credentials (standard variables; both key variables or neither). Unset → the SDK default credential chain |
>>>>>>> worktree-agent-a85a0080b9acbbce6

## Data access contract

- `createDatabase(opts?)` returns `{ db, close }` where `db` is a Drizzle database for PGlite or node-postgres. Migrations run with the owner connection.
- The runtime role is `cerebro_app` (no ownership, no `BYPASSRLS`). `withAuthContext(db, ctx, fn)` opens a transaction, runs `SET LOCAL ROLE cerebro_app`, sets `app.user_id` and `app.org_id` with `set_config(..., true)`, then calls `fn(tx)`. Tenant RLS policies compare `organization_id` with `current_setting('app.org_id', true)::uuid`. Global tables (`users`) have their own policies.
- `withSystemContext(db, fn)` exists only for migrations, seed, worker job claiming and the narrow identity lookups listed in the database package. Domain code must justify each use in a comment.
- Composite foreign keys `(organization_id, id)` for every tenant-owned reference.

## Domain contract

Shared types live in `packages/domain/src/context.ts` and `errors.ts`:

- `RequestContext = { userId: string; organizationId: string; via: "web" | "mcp" | "worker"; connectionId?: string; requestId: string }` — always resolved server-side.
- `DomainError` with `code`: `not_found` (also used for unauthorized reads, to avoid disclosure), `forbidden`, `conflict`, `stale_preview`, `validation`, `idempotency_mismatch`, `ambiguous`, `unauthenticated`, `rate_limited`, `unavailable`.

Domain modules (each directory exports from its own `index.ts`; `src/index.ts` re-exports them):

| Directory | Responsibilities |
| --- | --- |
| `access/` | Capability resolution for a user on a briefing (`read`, `view_evidence`, `view_draft`, `edit`, `publish`, `manage_access`, `withdraw`, `view_engagement`), company role checks, SQL predicate for readable published briefings, membership activity checks. See ACCESS_MATRIX.md |
| `org/` | Companies, departments, teams, memberships, invitations, team reparent with impact preview, audit |
| `library/` | Company/department/team/author/recency views, My drafts, title/summary search, permission-filtered counts |
| `briefings/` | Create briefing, drafts with `lock_version`, evidence approve/exclude, home move vs audience change, revisions list, revision diff |
| `publication/` | Previews (digest binding, expiry), publish transaction, withdrawal, share links, stable/pinned resolution |
| `integration/` | Connections + connection tokens, authoring preferences, destination resolution, idempotent `integration_operations` |
| `engagement/` | Q&A threads (private), feedback submission, engagement events, topic insights with cohort suppression, author feedback |
| `sources/` | Source records and chunks, extraction job enqueue, briefing-source links; the private `SourceStore` (`store.ts` local filesystem, `s3-store.ts` S3-compatible, chosen by `getSourceStore()` from the environment). Keys are `<organizationId>/<sha256>` (validated by `parseSourceKey`, shared by both adapters); `get(organizationId, key)` refuses another tenant's key and verifies the hash. No route serves source bytes; they are read only by domain services and the extraction job after an access check |

Rules: validate input with Zod at every exported function; return purpose-specific DTOs (never raw rows with draft-only fields to readers); write audit events for the actions in SECURITY_AND_PUBLICATION.md; enqueue jobs in the same transaction.

## Document identity

Document-internal ids are prefixed strings (`blk_`, `sec_`, `ev_`, `psp_`, `itm_`) generated by `newId(prefix)` in briefing-schema. Database rows use UUIDs. Published revisions contain only approved evidence; references to candidate/excluded evidence are removed at publication and listed in the preview as "claims publishing without evidence".

## Web routes

| Route | Surface |
| --- | --- |
| `/dev/sign-in` | Dev-only user picker (404 unless `AUTH_MODE=dev`) |
| `/c/[company]` | Company library (All briefs), filters `?department=&team=&author=&q=&sort=` |
| `/c/[company]/d/[department]` and `/t/[team]` below it | Department and team homes |
| `/c/[company]/drafts` | My drafts |
| `/c/[company]/b/[briefing]` | Reader, latest publication; `/v/[n]` pinned revision; `?perspective=psp_…` |
| `/c/[company]/b/[briefing]/edit` | Structured editor (draft); Tiptap for RichText prose fields |
| `/c/[company]/b/[briefing]/preview` | Reader preview + home/audience/evidence review + Publish |
| `/c/[company]/b/[briefing]/history`, `/engagement`, `/access` | Author views |
| `/c/[company]/new` | New brief (inherits home from `?department=&team=`) and import |
| `/c/[company]/settings` | Connections (connection tokens), authoring preferences |
| `/c/[company]/admin` | Departments, teams, members, invitations |
| `/s/[token]` | Share link resolution (authentication required) |
| `/api/mcp` | MCP Streamable HTTP endpoint (Bearer connection token) |

## Seed data

`npm run db:seed` creates company **Acme** (Product: Platform, Experience; Engineering: Infrastructure, Applications; Go-to-market: Marketing, Sales; Finance: Planning), users Riley Lee (owner/admin, executive author), Maya Chen, Alex Rivera, Priya Shah, Jordan Ellis, Sam Taylor, an external reader Casey Morgan (no membership), and a second company **Globex** with Taylor Kim for isolation tests. Fixture briefings include the representative strategy briefing (company-visible, published, with approved evidence and perspectives), a team-restricted brief, and a private draft.
