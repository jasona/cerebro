# Remaining work

**Status:** Working plan, written 2026-10-23 after the first implementation pass. It lists what stands between the current local prototype and a pilot. The order is a recommendation, not an agreed schedule. Dates, numerical targets, hosting vendors and AI providers stay unset until the user agrees them (see `AGENTS.md`).

For what exists today, see "Completion evidence" in [MVP_PLAN.md](MVP_PLAN.md). For decision IDs, see [RISKS_AND_DECISIONS.md](RISKS_AND_DECISIONS.md).

## Where things stand

The first pass covers Phases 0–4 and parts of Phase 5 at prototype depth. It runs locally on embedded PGlite with a dev sign-in, dev MCP connection tokens and a deterministic AI provider. Evidence: 414 Vitest tests, 29 Playwright journeys, a clean typecheck and a clean `next build`. Nothing is production-ready or pilot-ready, and nothing has been committed to git.

## Recommended order

1. **Housekeeping (W1):** commit the first pass and add CI, so later work has a baseline.
2. **Verify the Postgres server path (W2.1):** this needs no decisions.
3. **Decision session (W0):** most production work depends on it.
4. **Production foundations (W2):** start each item as its decision lands.
5. **Feature depth (W3) and pilot readiness (W4):** these can run in parallel once W2 identity work is underway.

## W0 Decisions for the user

These need the user, not an agent. Implementation should not guess them.

| Item | What is needed | Blocks |
| --- | --- | --- |
| Architecture review | Confirm or revise D03–D10 and T07, T16–T22, which were adopted without sign-off to unblock implementation | Everything marked "revisit at architecture review" |
| Open product proposals | Decide P07–P09 and P11–P19, especially P13 (published visibility) and P14 (hierarchy membership), which the access matrix already relies on | Access matrix, library behavior |
| Admin self-add (D09 accepted risk) | Whether an admin who adds themselves to a team should gain that team's audience access, or whether membership changes by admins need audit or approval | Access rules, audit |
| Withdrawn revisions | Whether older revisions stay readable by pinned link after the current revision is withdrawn | Publication and link resolution |
| Q&A cohort minimum (D07) | Confirm or replace the provisional minimum of 3 distinct readers | Engagement and privacy rules |
| AI provider | Select a provider and models for composition, Q&A and embeddings (T06/T19) | W2.4, W3 search and AI features |
| Hosting and region | Select hosting, managed Postgres and region (T10) | W2.1 deployment, W2.3, W4 |
| Object storage | Select an S3-compatible store (T10) | W2.3 |
| Identity and MCP OAuth | Confirm Clerk for web identity and choose the MCP-compatible OAuth server (T04, T13, D08) | W2.2 |
| First LLM host | Confirm the first supported host (P17) | W2.2 verification, W3.1 |
| Retention policy | Set retention for sources, evidence, conversations, events, audit and backups (P11) | W4 |
| Success targets | Agree pilot measures from representative baselines (P12) | Pilot evaluation |

## W1 Housekeeping

| Item | Work | Done when |
| --- | --- | --- |
| First commit | Commit the first pass; review `.gitignore` so `.data/` and build output stay out | A clean commit exists on the default branch |
| CI | Run `npm run typecheck`, `npm test` and `npm run test:e2e` on every push. E2E needs Chromium in CI, since locally it uses `/usr/bin/chromium` | CI passes on the first commit |
| Migration drift check | Migrations are hand-written SQL and `schema.ts` is maintained by hand. Add a check that a fresh migrated database matches the Drizzle schema | CI fails when the two disagree |

## W2 Production foundations

### W2.1 Postgres server path

The `DATABASE_URL` path (node-postgres pool, separate worker, advisory-locked migrations) is written but has never run against a server.

- Run `docker compose up -d`, `npm run db:reset`, `npm run dev` and `npm run worker` against the bundled pgvector image.
- Run the Vitest suites and Playwright journeys against Postgres as well as PGlite. Include the RLS suites, since pooled connections must not leak the transaction-local `app.user_id` and `app.org_id`.
- Exercise concurrent job claiming with more than one worker (the `SKIP LOCKED` queue, T07).
- Confirm the database user can create the `vector` extension and the `cerebro_app` role, or document the managed-host equivalent.
- Decide whether existing PGlite data ever needs moving. If it does, add a dump and restore procedure. Today `db:reset` re-seeds demo data only.

**Done when:** the full test suite passes against a Postgres server in CI.

### W2.2 Production identity and MCP authorization (D08)

- Replace the dev sign-in with Clerk. `proxy.ts` and the Clerk mode exist only as untested stubs.
- Integrate the chosen OAuth server for MCP so hosts connect with delegated, scoped, revocable tokens instead of `cbr_` dev tokens. Connection tokens stay refused in production (`CEREBRO_ALLOW_DEV_CONNECTION_TOKENS` is a dev-only escape hatch).
- Expose a public HTTPS endpoint so hosted LLMs such as ChatGPT can connect.
- Verify the end-to-end flow in the first supported host (P17).

**Done when:** a user signs in through Clerk, links the first host through OAuth, and completes draft → preview → publish. Security regression tests cover the OAuth path.

### W2.3 Object storage

Replace the local filesystem store with an S3-compatible adapter. It must keep the private-by-default access and tenant-scoped keys, and serve assets only through authorized routes or short-lived signed URLs.

**Done when:** uploads, extraction and evidence assets work against the selected store, and access tests cover cross-tenant and unauthorized fetches.

### W2.4 AI provider

Configure `AiSdkProvider` with the selected provider behind the existing task interfaces. Keep the deterministic provider for tests and as the outage fallback (principle 6).

- Run the evaluation set in `packages/ai` against the real model and record the results.
- Confirm prompts and payloads stay out of logs.

**Done when:** grounded Q&A and composition run on the real model, the evaluation set passes at a threshold the user agrees, and reading, editing and publishing still work with the provider disabled.

## W3 Feature depth

| Item | Current state | Work |
| --- | --- | --- |
| W3.1 In-host preview | No preview UI inside the LLM; hosts get a text summary and a preview link | MCP Apps preview and publish controls where the host supports them (T14), keeping the link fallback |
| W3.2 Embedding search | Full-text search only; vector columns exist but hold no embeddings (T20) | Embedding jobs once a provider is chosen; hybrid retrieval; measure quality before switching defaults |
| W3.3 AI-assisted composition (Phase 3+) | Deterministic stand-ins; no AI-suggested perspectives | AI drafts and suggested perspectives as author-reviewed proposals only (principle 2) |
| W3.4 Rich-text editor | Structured form editor; Tiptap deferred (T22) | Tiptap editing with the same optimistic-concurrency checks |
| W3.5 OCR | Scanned PDFs and images are not read (P09) | OCR in capture, with locators and extraction gaps reported |
| W3.6 Q&A suppression gap | `suppressedQuestionCount` is not itself cohort-suppressed | Apply the D07 suppression to this count, and add a regression test |
| W3.7 Remaining Phase 5 work | Partly done; see MVP_PLAN.md | Finish against the Phase 5 acceptance gates |

## W4 Pilot readiness

| Item | Work |
| --- | --- |
| Backups and restore | Automated backups for the database and object store; a tested restore |
| Retention and deletion | Implement the P11 policy, including deletion propagation to retrieval projections, assets and backups |
| Monitoring | Error tracking, job queue health, and AI provider failures and latency, all without logging source text or prompts |
| Rate limits | Per-user and per-connection limits on MCP tools, Q&A and uploads |
| Cost controls | Per-organization AI usage tracking and limits, set once targets are agreed |
| Accessibility audit | Audit the reader, editor, library and admin surfaces against WCAG 2.2 AA (principle 9); fix the findings |
| Security review | A review of the production auth path, OAuth linking, storage access and the Postgres runtime role once W2 lands |
| Pilot gates | Run the MVP_PLAN.md pilot acceptance gates against the P12 targets |

## Known noise (not defects)

- Next.js generated `apps/web/AGENTS.md`.
- E2E runs log a harmless "destination stream errored" message.

## Keeping this current

When an item is finished, record its evidence in MVP_PLAN.md and decisions in RISKS_AND_DECISIONS.md. Then remove or update the item here and add an `AGENTS.md` history entry.
