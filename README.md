# Cerebro

Interactive, evidence-backed executive briefings. Planning documents live in [`llm-docs/`](llm-docs/README.md); agent guidance is in [`AGENTS.md`](AGENTS.md).

This is a first implementation pass for local testing. It is not production-ready: identity uses a dev sign-in, MCP uses dev connection tokens instead of OAuth, and no AI vendor is configured (a deterministic local provider answers from published content only).

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

## What to try

1. **Library**: `/c/acme`. Shared company library, Department → Team tree, filters, search, My drafts.
2. **Reader**: open "Our next chapter: a focused move upmarket". Try the perspective chips, evidence markers, "Ask about this" (grounded Q&A with citations, private by default), and "Respond to the author".
3. **Author flow** (as Riley): Edit → Preview & publish → History (compare, withdraw) → Access (audience, grants, share links) → Engagement.
4. **New brief**: `/c/acme/new` from blank, Markdown, a handoff JSON or an uploaded PDF/DOCX/PPTX.
5. **Send this to Cerebro (MCP)**: in Settings → Connections, create a development connection token, then:

   ```bash
   claude mcp add --transport http cerebro http://localhost:3000/api/mcp \
     --header "Authorization: Bearer cbr_…"
   ```

   Ask your LLM: "Turn this into a Cerebro brief for the Platform team. Make it visible to the company." The tools create a private draft, show a preview with home and audience, and publish only when you explicitly ask. See [`packages/integrations/README.md`](packages/integrations/README.md). ChatGPT needs OAuth and a public URL, so it cannot connect with dev tokens.

## Tests

```bash
npm test               # Vitest: domain, security regression, RLS under the runtime role, AI eval, MCP
npm run typecheck      # tsc --noEmit for every package and app
npm run test:e2e       # Playwright journeys (uses /usr/bin/chromium and its own .data/pglite-e2e)
```

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
packages/capture       Text/Markdown/PDF/DOCX/PPTX extraction with locators
packages/integrations  MCP server for LLM-native authoring
```
