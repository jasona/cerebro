# AGENTS.md

Guidance for AI agents and contributors working in this repository. Read this first, then the relevant documents in `llm-docs/`.

## What Cerebro is

Cerebro is an AI-native executive communication platform. **Purpose: turn executive thinking into shared understanding.**

It replaces slide decks with interactive, evidence-backed **briefings**. A briefing keeps the author's position, reasoning, evidence, assumptions, tradeoffs, and requested outcome attached to one persistent, versioned object. Readers can explore that object, ask grounded questions, and give feedback.

Lifecycle: **Capture → Compose → Publish → Engage → Analyze → Evolve.**

## Current state

- **Phase:** Second implementation pass complete (2026-10-23) on branch `remaining-work`. Every `llm-docs/REMAINING_WORK.md` item that needs no user decision is built, and the vendor-neutral part of each remaining item is built. See "Completion evidence" in `llm-docs/MVP_PLAN.md`. Architecture review is still pending, and nothing is production-ready or pilot-ready.
- **Code:** npm-workspace monorepo (`apps/web`, `apps/worker`, `packages/*`), described in `README.md` and `llm-docs/IMPLEMENTATION_GUIDE.md`. It has SQL migrations with RLS, Vitest suites (unit, security regression, and RLS under the runtime role) and Playwright journeys.
- **Repository:** GitHub `jasona/cerebro`, default branch `main`. CI (`.github/workflows/ci.yml`) passes on `main`: typecheck, unit tests on PGlite and PostgreSQL, the database CLI, Playwright on both databases, and production images.
- **Decisions:** D01–D02 and D12–D22 were set by the user. D19 approved the earlier adopted decisions (D03–D11, T07, T16–T29), and D20 adopted the product proposals with Claude as the first host. P11's default is D18, and pilot targets wait for usage data (D22). D03–D10, the implementation amendments T07 and T16–T22, and the second-pass selections T23–T29 were adopted to unblock implementation at the user's direction; all are subject to architecture review. P13/P14 remain proposals.
- **Not production:** built for the chosen vendors but unconfigured: Claude (D12) needs an API key, Clerk web sign-in and MCP OAuth (D13) need keys and instance settings, and the Coolify deployment (D14) needs the instance and an S3-compatible storage service. Rate limits, AI usage caps and retention periods are built but unset. Local development uses the dev sign-in, dev connection tokens, the deterministic AI provider and the filesystem store.

The documents in `llm-docs/` describe intent and proposals. Treat implemented behavior as evidenced only by the code and tests, and do not describe a decision as approved unless the user approved it.

## Goals

**Primary goal:** Let an executive turn existing thinking into a trustworthy interactive briefing that colleagues can understand, question, and revisit.

**First end-to-end proof:**
1. An executive connects Cerebro to a supported LLM, creates a draft from selected thinking, reviews it, and explicitly publishes to an authorized home and audience.
2. A colleague discovers the brief through the company/department/team library, understands the requested decision, and inspects its evidence.
3. The author uses submitted reader feedback to publish a clearer revision from the connected LLM.

**Next milestone:** Phase 0, Experience and Contract. It delivers:
- A representative strategy briefing.
- A desktop and mobile reader prototype.
- A document schema proposal.
- Design tokens and the core block vocabulary.
- An access matrix.
- A connected-LLM preview/publication flow, structured handoff contract, and first-host/OAuth feasibility review.

The first review must settle five questions: the initial audience, authenticated sharing, perspective behavior, reader privacy, and publication authority.

For the full scope, non-goals, and success measures, see `llm-docs/GOALS.md`. For the phases and their acceptance gates, see `llm-docs/MVP_PLAN.md`.

## Documentation map

| Need | Read |
| --- | --- |
| Why the product exists and its principles | `llm-docs/VISION.md` |
| Scope, non-goals, and quality bars | `llm-docs/GOALS.md` |
| Company/department/team structure and discovery | `llm-docs/TEAM_WORKSPACES.md` |
| Primary LLM authoring workflow and MCP contracts | `llm-docs/LLM_INTEGRATION.md` |
| Stack, modules, and runtime shape | `llm-docs/ARCHITECTURE.md` |
| Entities, tables, and invariants | `llm-docs/DOMAIN_MODEL.md` |
| Author, reader, and admin flows | `llm-docs/USER_JOURNEYS.md` |
| Visual direction and UI surfaces | `llm-docs/DESIGN_SYSTEM.md` |
| AI composition, retrieval, and Q&A rules | `llm-docs/AI_AND_EVIDENCE.md` |
| Tenancy, permissions, publication, and sharing | `llm-docs/SECURITY_AND_PUBLICATION.md` |
| Open decisions and risks | `llm-docs/RISKS_AND_DECISIONS.md` |
| What is left to build, in recommended order | `llm-docs/REMAINING_WORK.md` |

## Proposed stack (not yet approved)

- **Architecture:** A modular monolith with a background worker.
- **Application and UI:** Next.js, React, and strict TypeScript, with Tailwind CSS, Radix, and Tiptap.
- **Validation:** Zod.
- **Data:** PostgreSQL with Drizzle. Documents are stored as JSONB; retrieval uses pgvector and full-text search; row-level security adds a second layer of protection.
- **Identity and AI:** Clerk handles identity, while Cerebro owns authorization. AI SDK calls sit behind task interfaces.
- **LLM integration:** A remote MCP adapter calls the same domain services. An established OAuth server provides delegated authorization, subject to compatibility review; optional MCP Apps UI provides preview and publish controls in supported hosts.
- **Jobs and storage:** a Cerebro-owned PostgreSQL jobs table (T07, replacing pg-boss) and private S3-compatible object storage.
- **Testing:** Vitest and Playwright.

The proposed monorepo layout is `apps/{web,worker}` plus `packages/{domain,database,briefing-schema,briefing-renderer,ui,ai,capture,integrations}`. Both now exist as adopted defaults (see `README.md` and `llm-docs/IMPLEMENTATION_GUIDE.md`) and remain subject to architecture review.

## Non-negotiable principles

These are the project's core constraints. Apply them in every design and every line of code:

1. **The briefing is the product.** Lead with the position, the stakes, and the requested outcome. Do not drift toward a generic chatbot, slide builder, or page builder. New block types must serve a clear communication purpose and have a defined schema.
2. **The author stays accountable.** AI output is a proposal. Nothing AI-generated is published without an explicit author action. AI edits use the same optimistic-concurrency checks as manual edits.
3. **Private sources are not reader evidence.** Readers see only the approved excerpts in a revision's evidence package. Reader Q&A retrieves only from the published revision and its approved evidence, never from private source chunks.
4. **Authorization lives close to the data.** Enforce access in domain services on every query, mutation, job, asset, citation, retrieval, and cache. UI and route middleware are not the security boundary. Use composite tenant foreign keys and runtime-role RLS tests.
5. **Published revisions are immutable.** Publication runs as a single idempotent transaction. Answers, feedback, and pinned links stay bound to their revision. Never answer from an older revision under the identity of a newer one.
6. **Reading never depends on a live model.** Readers, manual editing, and publication must keep working during an AI provider outage.
7. **Grounded answers or honest abstention.** Do not invent evidence IDs, quotes, or numbers. A valid citation ID alone does not prove that the claim is supported.
8. **Do not overclaim from analytics.** Dwell time and scroll depth are not comprehension or agreement. Reader Q&A is private by default, and attributed feedback requires an explicit submission.
9. **Accessibility:** Target WCAG 2.2 AA from the start.
10. **The connected LLM is a primary authoring surface.** Preserve selected thinking and provenance, never assume complete history or hidden reasoning, and apply the same draft/publication policies as the studio. Release the exact reviewed content and audience; a preview reference alone is not human approval.

## Working conventions

- **Decisions:** When a decision is made, record it in `llm-docs/RISKS_AND_DECISIONS.md` with its ID, date, chosen behavior, rationale, and affected documents. Update every related document together. For example, a permission change affects the schema, reader, retrieval, sharing, and tests.
- **Progress claims:** Mark a phase or feature complete only when acceptance evidence exists. Record that evidence in `llm-docs/MVP_PLAN.md`.
- **Unagreed details:** Do not invent dates, numerical targets, hosting vendors, or AI providers. Leave them unset until they are agreed.
- **Logging:** Keep extracted source text and model prompts or payloads out of logs by default.
- **Project history:** Add an entry to the history section below for each meaningful milestone, decision, or change in direction.

## Project history

| Date | Event |
| --- | --- |
| 2026-10-22 | Project created. The product brief was recorded, and planning documents were written in `llm-docs/`: vision, goals, architecture, domain model, user journeys, design system, AI and evidence, security, MVP plan, and the decision register. All technical and product choices remain proposals pending review. |
| 2026-10-22 | `AGENTS.md` was added to orient agents and to start tracking project history and goals. |
| 2026-10-22 | User established Company → Department → Team and shared discovery (D01). Planning documents and workspace concept images were updated; publication visibility details remain proposals. |
| 2026-10-22 | User accepted LLM-native authoring as a core MVP direction (D02). Added `LLM_INTEGRATION.md`, moved connected publication/discovery ahead of advanced studio composition, and updated domain, security, UX, and acceptance planning. No application implementation began. |
| 2026-10-22 | Security review follow-ups adopted as D10 (grant revocation on membership removal, inviter recheck, preview bound to base publication, home authorization, named readers limited to members/grantees). Engagement counts and topic summaries are cohort-suppressed on server-computed reader counts. Admin self-add to a team is an accepted risk under D09; older revisions stay readable by pinned link after withdrawal, open for review. |
| 2026-10-22 | Integration pass: briefing sources listing, deterministic "draft from source" composition for uploads (candidate evidence only), server-rendered briefing breadcrumbs, full-width external reader shell, `section_view` events, and a private per-user `briefing_reads` table (migration 0005) for library Unread / New version badges. |
| 2026-10-22 | User directed implementation of the full plan using agent judgement. Recorded D03–D09 and the implementation amendments, added `ACCESS_MATRIX.md` and `IMPLEMENTATION_GUIDE.md`, and built the monorepo: the schema/RLS/database layer, domain services, the deterministic AI provider with an evaluation set, capture, the renderer and design tokens, the web app (library, reader, editor, preview/publish, history, access, engagement, admin, settings), the MCP adapter, and the worker. Verified by 414 Vitest tests and 29 Playwright journeys, all passing. |
| 2026-10-23 | Added `llm-docs/REMAINING_WORK.md`: user decisions, housekeeping, production foundations (Postgres server path, Clerk/OAuth, object storage, AI provider), feature depth and pilot readiness. No dates, targets or vendors set. |
| 2026-10-23 | Added a System / Light / Dark theme switch (account menu and Settings → Appearance), saved per browser in localStorage and applied before first paint. Dark tokens now also apply under `data-theme="dark"`. Covered by `e2e/11-theme.spec.ts` and a token parity test. |
| 2026-10-23 | Second implementation pass on `remaining-work`. Built CI with a schema drift check, Postgres server test mode (all suites pass on PostgreSQL 17.6), Clerk identity and the MCP OAuth resource server, an S3-compatible store, AI provider wiring, embeddings and AI suggestions, the MCP Apps inline preview, the Tiptap editor, local OCR, cohort-suppression fixes, rate limits, AI usage limits, health checks, retention, backup/restore and a latency script. Recorded T23–T29. All are vendor-neutral, and every limit and retention period is unset. The user removed the accessibility audit from scope. |
| 2026-10-23 | Security review of the second-pass production paths: 11 fixes with regression tests, recorded as D11 (sign-in open redirect, Clerk `azp` binding, OAuth audience only from `APP_URL`, discovery timeout, connection revocation on membership removal, a first-sign-in race on PostgreSQL, a constant-time readiness token, backup credential and permission hardening, a shared-object deletion race, archive inflation checks). Full suites pass on PGlite and PostgreSQL. |
| 2026-10-23 | User decisions: Anthropic (Claude) as the AI provider (D12), Clerk as the MCP OAuth authorization server (D13), internal hosting on Coolify (D14). CI passes on GitHub; `remaining-work` merged into `main`. |
| 2026-10-23 | Implemented D12–D14: the Anthropic provider through the official SDK, Clerk as the MCP OAuth server (Clerk token profile, audited reconnect, migration 0010), and Coolify deployment (images, compose stack, `db:provision`, `org:bootstrap`, runbook, CI image smoke test). All CI jobs green on `main`. Live checks wait for credentials and the Coolify instance. |
| 2026-10-23 | User decisions D15–D18: admin self-add allowed and audited, withdrawing a brief withdraws every revision (implemented), cohort minimum 3, default retention keep everything. |
| 2026-10-23 | User decisions D19–D22: adopted decisions approved (architecture review), product proposals adopted with Claude as the first LLM host, limits off for the pilot, pilot targets after first usage. Remaining work is credentials, the Coolify deployment and pilot data. |
