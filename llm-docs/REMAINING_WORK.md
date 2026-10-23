# Remaining work

**Status:** Working plan, written 2026-10-23 after the first implementation pass and updated the same day after the second pass (branch `remaining-work`). It lists what stands between the current local prototype and a pilot. The order is a recommendation, not an agreed schedule. Dates, numerical targets, hosting vendors and AI providers stay unset until the user agrees them (see `AGENTS.md`).

For evidence, see "Completion evidence" in [MVP_PLAN.md](MVP_PLAN.md). For decision IDs, see [RISKS_AND_DECISIONS.md](RISKS_AND_DECISIONS.md).

## Where things stand

The second pass built every item that needs no user decision, and the vendor-neutral half of every item that does. What remains is mostly **choosing vendors and values**, then **re-running the existing tests against those choices**.

Status key:
- **Done:** built and verified.
- **Built, needs a decision:** the vendor-neutral part is done; finishing needs a W0 decision.
- **Open:** not started.
- **Removed:** taken out of scope by the user.

## Next steps

1. **Decisions:** settled (D12–D22). What remains is credentials, the Coolify instance and pilot data (W0).
2. **Credentials and the Coolify instance:** provide an Anthropic API key, Clerk keys and instance settings, and an S3-compatible bucket on Coolify, then follow `deploy/coolify/README.md` and the live checks below.
3. **Per decision, connect and re-test:** each W2 item lists what to run once its vendor or value is chosen.
4. **Pilot gates:** run them once the P12 targets exist.

## W0 Decisions for the user

Settled on 2026-10-23: the AI provider (D12), MCP OAuth (D13), hosting (D14), admin self-add (D15), withdrawal (D16), the cohort minimum (D17), default retention (D18), the architecture review of the adopted decisions (D19), the open product proposals with Claude as the first host (D20), limits off for the pilot (D21), pilot targets set after first usage (D22), full-text search with no embedding vendor (D23), retention covering sources, Q&A and events only (D24), SeaweedFS storage in the Coolify stack (D25), nightly backups with 14 kept and an off-site copy (D26), `low` Claude effort for reader answers (D27), and provisional pilot targets (D28).

What remains needs the user's credentials, infrastructure or later data:

| Item | What is needed | Blocks |
| --- | --- | --- |
| Anthropic API key | Provide a key; then run `npm run ai:live` and `npm run ai:eval`, and check answer latency against the 15-second answer timeout | Live verification of D12 |
| Clerk instance | Provide keys and apply the instance settings in `packages/integrations/README.md` (including `aud_claim_enabled` through Clerk's API) | Live verification of D13, web sign-in |
| Coolify instance | Deploy with `deploy/coolify/README.md` (storage is SeaweedFS in-stack, D25; backups nightly, D26) and set the off-site backup destination | Live verification of D14 |
| Pilot targets | **Provisional targets set (D28)** in MVP_PLAN.md; revise from pilot baselines | Final pilot exit gates |

## W1 Housekeeping — Done

| Item | Status | Evidence |
| --- | --- | --- |
| First commit | Done | `main` on GitHub, `4f5a19c` |
| CI | Done; passing on GitHub | `.github/workflows/ci.yml`: typecheck, Vitest on PGlite and Postgres, the database CLI, and Playwright on both databases |
| Migration drift check | Done | `packages/database/test/schema-drift.test.ts`. It caught one real drift during the second-pass merges |

## W2 Production foundations

| Item | Status | Built | Still needed |
| --- | --- | --- | --- |
| W2.1 Postgres server path | Done | `TEST_DATABASE_URL` test mode; the full Vitest suite and all Playwright journeys pass on PostgreSQL 17.6 with pgvector, with a separate `npm run worker`; a pooled-connection leak regression test; owner privileges documented in the README | Confirm privileges on the chosen managed host. Moving existing PGlite data is not built; `db:backup`/`db:restore` are per-engine |
| W2.2 Identity and MCP OAuth | Built for Clerk; needs keys | Clerk web mode (T23); MCP OAuth with Clerk's token profile, `typ: at+jwt`, audience binding and an audited reconnect after revocation (T24, D13); setup steps in `packages/integrations/README.md` | Clerk keys and instance settings (`aud_claim_enabled` is set through Clerk's API), a public HTTPS `APP_URL`, a company picker for users in several companies, and an end-to-end run in Claude and ChatGPT |
| W2.3 Object storage | Built, needs a decision | S3-compatible adapter, verified against MinIO, including uploads and extraction through the domain services (T25) | The store vendor; private-bucket, encryption and lifecycle setup; a re-run of the integration test against it. Signed URLs are only needed if a feature ever serves original bytes |
| W2.4 AI provider | Built for Anthropic; needs a key | `AnthropicProvider` through the official SDK for all five tasks: structured outputs, per-task effort (provisional), a cached system prompt, server-side refusal fallback, fallback to the offline provider on failure (D12). Gated by each organization's `allowedProviders` | An API key; `npm run ai:live` and `npm run ai:eval`; agree thresholds. Check answer latency against the 15-second answer timeout |
| W2.5 Deployment | Built for Coolify; needs the instance | Web and worker images, the `deploy/coolify` compose stack (pgvector PostgreSQL, one-shot migrate, web, worker), `db:provision`, `org:bootstrap`, and the runbook `deploy/coolify/README.md`. A CI `images` job builds and smoke-tests the stack (D14) | Deploy on the Coolify instance, choose the storage service, schedule backups with off-site copies |

## W3 Feature depth

| Item | Status | Notes |
| --- | --- | --- |
| W3.1 In-host preview | Done; not yet verified in a real host | MCP Apps inline preview with a confirmed Publish bound to the server-issued preview (T14). Text fallback unchanged |
| W3.2 Embedding search | Built; off by decision (D23) | Embedding jobs over published blocks and approved evidence only; hybrid retrieval behind `CEREBRO_RETRIEVAL_MODE`, default full-text. The default needs measurements with a real embedding model |
| W3.3 AI-assisted composition | Done | Suggested perspectives and revision proposals stored as suggestions; the author accepts or dismisses them through the normal versioned save; D06 checks applied |
| W3.4 Rich-text editor | Done | Tiptap v3 for prose fields, limited to the existing `RichText` syntax; no schema change |
| W3.5 OCR | Done | Local `tesseract.js` with bundled English data, in the extraction job only; limits are provisional (T26) |
| W3.6 Q&A suppression gap | Done | The withheld-question count and topic-summary requests are cohort-suppressed; 2 vs 3 reader boundary tests |
| W3.7 Remaining Phase 5 work | Done, mechanisms only | See W4. The Phase 5 exit gate still needs the W0 decisions |

## W4 Pilot readiness

| Item | Status | Notes |
| --- | --- | --- |
| Backups and restore | Done (mechanism) | `npm run db:backup` / `db:restore` for PGlite, Postgres and the object store; backup → change → restore tested on both databases. Schedule, encryption and off-site copies depend on hosting |
| Retention and deletion | Built, needs a decision | Per-organization policies (none set), a sweep job, source hard delete, propagation to chunks, embeddings, links and stored objects; nothing is deleted without a policy |
| Monitoring | Done (mechanism) | `/api/health`, `/api/ready`, an allowlisted JSON logger. No error-tracking vendor is selected |
| Rate limits | Built, needs a decision | Postgres-backed, per user and per connection, for MCP tools, Q&A and uploads; off until configured |
| Cost controls | Built, needs a decision | Per-organization AI usage recording and optional limits; Q&A and suggestions degrade as during an outage. No admin UI yet |
| Latency measurement | Done (measurement) | `npm run perf` prints p50/p95 for key operations; no targets |
| Accessibility audit | Removed | Removed from scope by the user on 2026-10-23. Principle 9 in `AGENTS.md` is unchanged |
| Security review | Done | Production paths reviewed; 11 fixes with regression tests, recorded as D11. Its open items are listed there. Repeat for the production auth path once real vendors are configured |
| Pilot gates | Open | Needs the P12 targets |

## Known noise (not defects)

- Next.js generated `apps/web/AGENTS.md`.
- E2E runs log a harmless "destination stream errored" message, and against Postgres the dev server logs ECONNRESET when browser contexts close.

## Keeping this current

When an item is finished, record its evidence in MVP_PLAN.md and decisions in RISKS_AND_DECISIONS.md. Then remove or update the item here and add an `AGENTS.md` history entry.
