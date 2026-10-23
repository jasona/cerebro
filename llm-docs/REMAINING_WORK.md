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

1. **Decision session (W0):** this is now the main blocker.
2. **Merge and CI:** review `remaining-work`, merge it to `main`, and confirm the GitHub Actions workflow passes. It has not yet run on GitHub.
3. **Per decision, connect and re-test:** each W2 item lists what to run once its vendor or value is chosen.
4. **Pilot gates:** run them once the P12 targets exist.

## W0 Decisions for the user

These need the user, not an agent. Implementation should not guess them.

| Item | What is needed | Blocks |
| --- | --- | --- |
| Architecture review | Confirm or revise D03–D10, T07, T16–T22 and the second-pass selections T23–T29, all adopted without sign-off to unblock implementation | Everything marked "revisit at architecture review" |
| Open product proposals | Decide P07–P09 and P11–P19, especially P13 (published visibility) and P14 (hierarchy membership), which the access matrix already relies on | Access matrix, library behavior |
| Admin self-add (D09 accepted risk) | Whether an admin who adds themselves to a team should gain that team's audience access, or whether membership changes by admins need audit or approval | Access rules, audit |
| Withdrawn revisions | Whether older revisions stay readable by pinned link after the current revision is withdrawn | Publication and link resolution |
| Q&A cohort minimum (D07) | Confirm or replace the provisional minimum of 3 distinct readers | Engagement and privacy rules |
| AI provider | Select a provider and models for composition, Q&A and embeddings | W2.4, the retrieval default (W3.2) |
| Hosting and region | Select hosting, managed Postgres and region (T10) | Deployment, backup schedule |
| Object storage | Select an S3-compatible service (T10) | W2.3 |
| Identity and MCP OAuth | Provide Clerk keys and choose the MCP OAuth authorization server (T13) | W2.2 |
| First LLM host | Confirm the first supported host (P17) | W2.2 and W3.1 verification |
| Retention policy | Set periods for sources, conversations and events, and decide whether audit, published evidence, feedback and backups are covered (P11) | Turning on the W4 retention sweep |
| Limits and costs | Set rate limits, AI run and token caps, and the readiness queue-age threshold, or confirm they stay off. Also decide whether the pre-existing cap of 30 reader questions per briefing per hour stays | Turning on W4 limits |
| Success targets | Agree pilot measures from representative baselines, including latency and AI evaluation thresholds (P12) | Pilot evaluation |

## W1 Housekeeping — Done

| Item | Status | Evidence |
| --- | --- | --- |
| First commit | Done | `main` on GitHub, `4f5a19c` |
| CI | Done; not yet run on GitHub | `.github/workflows/ci.yml`: typecheck, Vitest on PGlite and Postgres, the database CLI, and Playwright on both databases |
| Migration drift check | Done | `packages/database/test/schema-drift.test.ts`. It caught one real drift during the second-pass merges |

## W2 Production foundations

| Item | Status | Built | Still needed |
| --- | --- | --- | --- |
| W2.1 Postgres server path | Done | `TEST_DATABASE_URL` test mode; the full Vitest suite and all Playwright journeys pass on PostgreSQL 17.6 with pgvector, with a separate `npm run worker`; a pooled-connection leak regression test; owner privileges documented in the README | Confirm privileges on the chosen managed host. Moving existing PGlite data is not built; `db:backup`/`db:restore` are per-engine |
| W2.2 Identity and MCP OAuth | Built, needs a decision | Clerk mode with an explicit identity link and invitation-only first sign-in (T23); MCP as an OAuth protected resource with per-tool scopes and revocable grants (T24); dev sign-in refused in production | Clerk keys, the authorization server choice, a public HTTPS `APP_URL`, a company picker for users in several companies, and an end-to-end run in the first host |
| W2.3 Object storage | Built, needs a decision | S3-compatible adapter, verified against MinIO, including uploads and extraction through the domain services (T25) | The store vendor; private-bucket, encryption and lifecycle setup; a re-run of the integration test against it. Signed URLs are only needed if a feature ever serves original bytes |
| W2.4 AI provider | Built, needs a decision | Provider selected by environment, failing fast if misconfigured; policy-bounded fallback; honest "unavailable" answers on failure; `npm run ai:eval` reports (T27) | Run the eval against the chosen model, then agree pass thresholds |

## W3 Feature depth

| Item | Status | Notes |
| --- | --- | --- |
| W3.1 In-host preview | Done; not yet verified in a real host | MCP Apps inline preview with a confirmed Publish bound to the server-issued preview (T14). Text fallback unchanged |
| W3.2 Embedding search | Built, needs a decision | Embedding jobs over published blocks and approved evidence only; hybrid retrieval behind `CEREBRO_RETRIEVAL_MODE`, default full-text. The default needs measurements with a real embedding model |
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
