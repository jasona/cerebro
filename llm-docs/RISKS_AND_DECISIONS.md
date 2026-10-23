# Risks and decision register

**Status:** Decision and risk register. D01–D02 record accepted product direction. D03–D10 and the implementation selections below were adopted 2026-10-22 to unblock implementation, at the user's direction to proceed on the planned defaults; revisit at architecture review. Remaining proposals are not recorded as approved.

## Accepted product direction

On 2026-10-22, the user specified Company → Department → Team and easy discovery of colleagues' briefs. This product direction is established. The detailed visibility, membership, and administration behaviors in [TEAM_WORKSPACES.md](TEAM_WORKSPACES.md) remain proposed defaults.

| ID | Date | Accepted direction | Rationale and affected documents |
| --- | --- | --- | --- |
| D01 | 2026-10-22 | Organize the shared workspace as Company → Department → Team and make colleagues' briefs easy to discover | Supports shared company communication; reflected in team workspaces, vision, goals, journeys, design, schema, security, and MVP plan |
| D02 | 2026-10-22 | Make creating, reviewing, publishing, and updating briefs from an executive's existing LLM a core MVP workflow, ahead of advanced in-app composition | Removes manual content transfer and preserves existing thinking workflows; reflected in LLM integration, vision, goals, architecture, schema, journeys, design, AI/evidence, security, team workspaces, and MVP plan |

D02 records the user's instruction to update the plan after reviewing the proposed integration experience. It does not imply approval of every technical detail, host, identity vendor, or outstanding privacy decision.

## Defaults adopted to unblock implementation

Each decision below was adopted 2026-10-22 to unblock implementation, at the user's direction to proceed on the planned defaults; revisit at architecture review. The user directed work to proceed on the planned defaults; these entries do not record the user's approval of any specific detail.

| ID | Date | Chosen behavior | Rationale | Affected documents |
| --- | --- | --- | --- | --- |
| D03 | 2026-10-22 | Resolves P01. The initial audience is internal executive communication: executives and senior teams communicating strategy and consequential decisions within one company | Matches the representative briefing and the company library; keeps external access an explicit extension | Vision, goals, journeys, access matrix, MVP plan |
| D04 | 2026-10-22 | Resolves P02 and P03. External recipients receive explicit, authenticated briefing or revision grants with no company membership or directory access. Sharing provides stable links to the current publication and pinned links to one revision; a link is a locator, never sufficient authorization | Keeps every reader authenticated and accountable; defines version resolution without public URLs | Security, domain model, team workspaces, journeys, access matrix |
| D05 | 2026-10-22 | Resolves P04. The briefing owner or a designated publisher may publish; self-publication is allowed and no second approver is required. Publication and withdrawal are audited | Keeps the author accountable without an approval engine, which remains out of MVP scope | Security, LLM integration, journeys, access matrix |
| D06 | 2026-10-22 | Resolves P05. Perspectives carry author-approved emphasis and implications over the same authorized facts. They never conceal content or change access; a sensitive variant requires a separately permissioned briefing. Author-written perspectives ship in Phase 2; AI-suggested perspectives follow in Phase 3 | Avoids section-level confidentiality and contradictory audience versions | Domain model, AI/evidence, design, journeys, LLM integration, MVP plan |
| D07 | 2026-10-22 | Resolves P06. Reader Q&A is private to the asker. Authors see only disclosed aggregate topics with cohort suppression, and attributed feedback only when the reader explicitly submits it. Minimum cohort: 3 distinct readers, as a provisional implementation setting | Protects readers from surveillance while letting authors learn what needs clarification | AI/evidence, security, journeys, access matrix, MVP plan |
| D08 | 2026-10-22 | Separates development identity from production identity and delegated MCP authorization. See [D08 detail](#d08-identity-and-mcp-authorization) | Clerk (T04) may not provide the delegated MCP OAuth flow (T13); local development and tests must not depend on either vendor | Architecture, security, LLM integration, domain model, MVP plan |
| D09 | 2026-10-22 | Resolves P10. Company admins manage structure, memberships, invitations, and policy. They read only what their own audience membership or grants allow, with no implicit access to drafts, restricted briefs, sources, or private Q&A. An audited break-glass access path is deferred | Prevents administrative status from becoming silent content access | Access matrix, security, team workspaces, journeys |
| D10 | 2026-10-22 | Security review follow-ups: membership removal revokes grants, inviter authority is rechecked at acceptance, previews bind to the base publication, homes are limited to authorized destinations, and named readers by id are limited to members and existing grantees. See [D10 detail](#d10-security-review-follow-ups) | Closes defects and gaps found in the security review of the domain layer | Access matrix, security, LLM integration |

### D08 identity and MCP authorization

| Environment | Web identity | MCP connection authorization |
| --- | --- | --- |
| Local development and tests | Dev identity adapter: seeded users, a signed session cookie, and an explicitly dev-only sign-in page that is disabled unless `AUTH_MODE=dev` | Connection tokens: high entropy, stored hashed, tied to an `integration_connections` row, created by the user in Settings, and revocable |
| Production | Clerk | An established MCP-compatible OAuth authorization server. Clerk's OAuth/MCP support is the first candidate; verification is pending |

Connection tokens are a dev/test stand-in only, not the production delegated-authorization design. Both paths resolve to the same Cerebro user, company membership, and capability checks.

### D10 security review follow-ups

Adopted 2026-10-22 to unblock implementation; revisit at architecture review.

| Topic | Chosen behavior |
| --- | --- |
| Membership removal | Removing a company membership revokes every briefing grant the user holds in that company, each audited. A re-invited member does not regain earlier editor, publisher, or reader grants; re-granting is an explicit decision |
| Invitation acceptance | Acceptance rechecks the inviter's current authority: membership invitations need a current owner or admin, briefing invitations need current `manage_access`. Otherwise acceptance is `forbidden` |
| Preview binding | A preview is bound to the briefing's current publication when it was created. If the publication pointer changes (another publication or a withdrawal), the preview is stale with reason `publication` |
| Home authorization | Owners and admins may home a briefing anywhere in the company. Other members may home only where they could publish: the company home; a department through explicit department membership or one of its teams; a team through team membership. Applies to creation and home moves |
| Named readers | `readerUserIds` accepts only active company members or users who already hold a grant on that briefing. Anything else, including an unknown id, gets one uniform validation error. External readers are added by email through grants or invitations |
| Admin self-add to a team | **Accepted risk under D09.** An admin adding themselves to a team or department is an audited structural action, and it does grant that unit's audience access. It is not treated as break-glass |
| Older revisions after withdrawal | **Current behavior, open for review.** Withdrawing the current publication does not withdraw earlier revisions; a pinned link to an older, non-withdrawn revision stays readable for its audience |

The MCP adapter enforces connection revocation by authenticating every request; the domain does not recheck the connection inside `withAuthContext`.

### D11 production-path security review follow-ups

Adopted 2026-10-23 after a security review of the second-pass production paths (identity, OAuth, MCP, ops endpoints, storage, retention, backups, capture); revisit at architecture review. Each fix has a regression test.

| Topic | Chosen behavior |
| --- | --- |
| Sign-in redirects | Post-sign-in `next` destinations must be same-origin paths with no control characters or backslashes |
| Clerk session binding | Clerk session tokens are accepted only when their authorized party (`azp`) is the `APP_URL` origin |
| MCP OAuth audience | The token audience comes only from `APP_URL`; OAuth stays off until `APP_URL` is set, in every environment |
| OAuth discovery | Each authorization-server metadata request has a bounded timeout; a failed discovery is not cached |
| Connections on membership removal | Removing a company membership revokes the user's MCP connections (dev tokens and OAuth grants) in that company, each audited. Re-adding the member does not revive them (extends D10) |
| Concurrent first sign-in | A sign-in that races another first sign-in for the same identity resolves to the linked user, never `identity_conflict` |
| Readiness token | Compared as fixed-length SHA-256 digests in constant time |
| Backups | Postgres tools receive the password via `PGPASSWORD`, never argv; failures report only the tool, exit code and redacted stderr. Backup directories are 0700 and dumps 0600; restore accepts only the fixed file name for the backup's kind |
| Shared stored objects | Deleting a content-addressed object is serialized with uploads of the same object by a per-object advisory lock, and references are rechecked just before deletion |
| Archive inflation | DOCX/PPTX entries must inflate to exactly their declared size, capped at that size, before any parser runs; a mismatch is `unsafe_archive` |

**Open for review:** whether editors of a linked briefing (not only the source's creator and owners/admins) may hard-delete a source; a per-page time limit for PDF parsing and rendering; object backup when the S3 store is selected; checking the access-token `typ`; the cross-company effect of revoking an OAuth grant; accepting tokens with no Cerebro scope; and a relink procedure if the Clerk instance (issuer) changes.

## Product decisions

| ID | Decision | Proposed default | Status and review consequence |
| --- | --- | --- | --- |
| P01 | Initial audience | Internal executive communication | Adopted as D03. Sets onboarding, sharing, and pilot scenarios |
| P02 | External recipients | Explicit invitations to authenticated readers without automatic membership | Adopted as D04. Requires resource-level grants and external-reader journeys |
| P03 | Link behavior | Stable latest-publication links plus optional pinned revisions | Adopted as D04. Defines version resolution and history access |
| P04 | Publication authority | Owner or designated publisher; self-publication allowed | Adopted as D05. Defines capability matrix and audit events |
| P05 | Perspectives | Author-approved emphasis and implications over the same authorized facts | Adopted as D06. Avoids section-level confidentiality in the MVP |
| P06 | Reader privacy | Private Q&A, disclosed aggregate topics, explicit attributed submissions | Adopted as D07. Requires suppression rules and clear disclosure |
| P07 | Source disclosure | Approved excerpts; originals require separate access | Defines evidence packaging and citation behavior |
| P08 | Collaboration | Multiple editors with optimistic conflict detection | Defers simultaneous live editing |
| P09 | Import fidelity | Text and provenance from supported files | OCR and layout/chart reconstruction deferred |
| P10 | Administrator content access | No implicit content access | Adopted as D09. Defined in [ACCESS_MATRIX.md](ACCESS_MATRIX.md) |
| P11 | Retention | Explicit organization policy before pilot | Must cover sources, evidence, conversations, events, audit, and backups |
| P12 | Success targets | Agree measurable targets from representative baselines | Required before pilot evaluation |
| P13 | Published visibility | Company-visible by default; optional department/team/named-reader restriction; drafts collaborator-only | Enables easy discovery while keeping audience explicit; used by the access matrix |
| P14 | Hierarchy membership | One department per team; users may join multiple teams; department access derives from direct or child-team membership | Determines library aggregation and audience checks; used by the access matrix |
| P15 | Organizational placement | One company/department/team home per briefing, independent of audience | Moving content must not silently change access |
| P16 | Structure administration | Company administrators initially manage departments and teams | Delegated team management can follow an explicit capability decision |
| P17 | First supported LLM host | ChatGPT proposed; validate capabilities, distribution, and workspace availability | Establishes a real end-to-end path without promising universal support |
| P18 | Authoring preferences | Remember explicitly chosen company/team and style; reauthorize on use | Reduces repeated input without guessing destinations or broadening audience |
| P19 | Integrated publication review | One explicit release action after content and audience review, subject to host policy | Requires an exact preview binding and supported review/action flow |

P07–P09 and P11–P19 remain proposed defaults.

## Technical decisions

| ID | Proposal | Main tradeoff or prerequisite | Status |
| --- | --- | --- | --- |
| T01 | Modular monolith plus worker | Simple initial operation with enforceable module boundaries | Proposed |
| T02 | Next.js and strict TypeScript | Shared application stack; authorization must stay close to data | Proposed; TypeScript version set by T17 |
| T03 | PostgreSQL, Drizzle, JSONB documents | Flexible content plus relational integrity; JSON references need explicit validation | Proposed; local database set by T18 |
| T04 | Clerk for authentication; Cerebro-owned authorization | Hosted identity convenience with an application-owned policy model | Production web identity per D08; local development and tests use the dev identity adapter |
| T05 | PostgreSQL row-level security | Defense in depth requiring correct runtime roles and transaction context | Proposed |
| T06 | AI SDK behind task interfaces | Provider portability without pretending all models behave identically | Amended by T19 |
| T07 | Cerebro-owned PostgreSQL `jobs` table queue and a Node.js worker | Transactional enqueue within domain transactions; retries and capacity management are Cerebro's responsibility | Amended 2026-10-22; replaces pg-boss (see below) |
| T08 | PostgreSQL full-text and vector retrieval | One data platform; measure retrieval quality and filtered-query performance | Amended by T20 |
| T09 | Immutable publication snapshots | Reproducibility with explicit storage, schema compatibility, and retention obligations | Proposed |
| T10 | Docker and managed data services | Portable deployment; actual host, region, and providers remain unselected | Proposed |
| T11 | Shared reader and preview renderer | Consistent output; editor controls must not leak into reader rendering | Proposed |
| T12 | Remote MCP adapter over shared domain services | Portable tool interface with per-host capability testing; no separate permission/publication path | Proposed; transport set by T21 |
| T13 | Established MCP-compatible OAuth authorization server | Verify delegated-flow support alongside web authentication | Production path per D08. The resource-server side is implemented (T24); the authorization server itself is unselected, and Clerk OAuth/MCP remains the first candidate, verification pending. Local development and tests use connection tokens |
| T14 | Optional MCP Apps preview UI | Inline preview where supported, structured results and authenticated links elsewhere | Implemented 2026-10-23 against the MCP Apps spec 2026-01-26 (amends T21's deferral); not yet verified in a real host |
| T15 | Server-bound previews and integration operation records | Bind release to reviewed content/audience and recover safely from retries without treating a preview reference as human consent | Proposed |

### Implementation selections

Each entry below was adopted 2026-10-22 to unblock implementation, at the user's direction to proceed on the planned defaults; revisit at architecture review.

| ID | Adopted selection | Reason |
| --- | --- | --- |
| T07 amendment | Replace pg-boss with a Cerebro-owned PostgreSQL `jobs` table claimed with `FOR UPDATE SKIP LOCKED` | Supports transactional enqueue within domain transactions and works identically on PGlite and PostgreSQL. pg-boss can be revisited |
| T16 | npm workspaces for the monorepo. Internal TypeScript-source packages are consumed without a build step | pnpm is not installed in the working environment; avoids a per-package build pipeline |
| T17 | TypeScript 6.0.x (amends T02) | TypeScript 7 is the native port; its API compatibility with Next.js tooling is unverified |
| T18 | PGlite (embedded PostgreSQL in WASM, with pgvector) for local development and tests when `DATABASE_URL` is unset; node-postgres against real PostgreSQL otherwise. A `docker-compose.yml` provides real PostgreSQL (amends T03) | Repeatable local and test setup without external services, while keeping a real-PostgreSQL path for RLS and runtime-role verification |
| T19 | AI task interfaces with a deterministic local provider as the default: extractive, retrieval-based answers and structure-preserving composition. An AI SDK adapter accepts an injected model; no vendor is selected (amends T06) | Reading, publishing, and tests never need a live model. Consistent with leaving AI providers unset until agreed |
| T20 | Full-text search first. The vector column is optional and populated only when an embedding provider is configured (amends T08) | No embedding provider is selected; retrieval must work without one |
| T21 | `@modelcontextprotocol/sdk` over Streamable HTTP, served from a Next.js route at `/api/mcp`. No MCP Apps embedded UI yet (T14 deferred). Text-only fallback returns a structured summary and an authenticated preview link (amends T12) | Uses the protocol's reference implementation inside the existing deployment; embedded UI waits for host validation |
| T22 | Tiptap deferred. The minimal manual editor uses structured block forms (Phase 2 scope). Tiptap remains the plan for the deeper studio. **Amended 2026-10-23:** prose fields now use Tiptap v3, limited to the existing `RichText` syntax (paragraphs, line breaks, bold, italic, http(s) links); the stored format is unchanged | Block forms are enough for minimal manual editing and keep the schema the source of truth |

#### Second implementation pass — 2026-10-23

Adopted 2026-10-23 while working through `REMAINING_WORK.md`, at the user's direction to finish the remaining work items; revisit at architecture review. None of these selects a hosting vendor, AI provider, storage vendor or OAuth authorization server, and none sets a limit, retention period or target.

| ID | Adopted selection | Reason |
| --- | --- | --- |
| T23 | Clerk web identity behind `AUTH_MODE=clerk` (D08). External identities map to users only through an explicit `user_identities` link (issuer + subject, migration 0006). First sign-in creates a user only for a pending invitation to the verified email, or claims an unlinked pre-provisioned user once; no domain auto-join. `AUTH_MODE=dev` is refused when `NODE_ENV=production` | Cerebro keeps authorization; Clerk only authenticates |
| T24 | MCP is an OAuth 2.1 protected resource: RFC 9728 metadata, JWT access tokens verified against the configured issuer's JWKS with the audience bound to `APP_URL/api/mcp`, scopes `cerebro:read`, `cerebro:draft` and `cerebro:publish` enforced per tool, and grants stored as revocable `integration_connections` rows. Off until `CEREBRO_OAUTH_ISSUER` is set | Vendor-neutral; works with any compliant authorization server that issues resource-bound JWTs with `auth_time` |
| T25 | S3-compatible source store using the AWS SDK v3 client, selected by `CEREBRO_OBJECT_STORE=s3`; endpoint, region and bucket are required, with no defaults. Immutable puts (`If-None-Match: *`), hash-verified reads, organization-scoped get and delete | Works with any S3-compatible service; the vendor stays unselected (T10) |
| T26 | Local OCR with `tesseract.js` and bundled English language data, run only in the extraction job, for scanned PDF pages and PNG/JPEG/WebP uploads. Page, pixel and time limits are provisional implementation settings | No cloud OCR vendor; nothing is downloaded at runtime (P09 amended: OCR no longer deferred, layout and chart reconstruction still are) |
| T27 | AI provider wiring by environment: deterministic by default, or `CEREBRO_AI_PROVIDER=ai-sdk` with a runtime-named AI SDK module and model. A local hashed embedding exists for development and tests; hybrid retrieval exists behind `CEREBRO_RETRIEVAL_MODE` but full-text stays the default (amends T19, T20) | Connecting a provider becomes configuration; the default retrieval mode waits for measurements with a real embedding model |
| T28 | Operational mechanisms with no values set: Postgres-backed rate limits, per-organization AI usage limits, retention policies with deletion propagation, `/api/health` and `/api/ready`, an allowlisted structured logger, and `db:backup` / `db:restore`. Every limit is off and every retention category keeps data until configured | P11 and P12 are unset; the mechanisms can be tested before the values are agreed |
| T29 | CI on GitHub Actions (the repository host): typecheck, Vitest on PGlite and on PostgreSQL with pgvector, the database CLI, and Playwright on both databases. Tests run against a server when `TEST_DATABASE_URL` is set | Covers the server database path, which had been untested |

Hosting providers, AI models, embedding configuration, extraction libraries, and telemetry vendors remain unselected. Exact dependency versions are pinned in the implementation, and their current capabilities and constraints must be verified when selected.

## Risk register

| Risk | Consequence | Planned response and evidence |
| --- | --- | --- |
| Cross-tenant leakage | Confidential content reaches an unauthorized user | Central policies, composite constraints, runtime-role RLS tests, retrieval and asset-access tests |
| Private-source leakage | Reader answers reveal unpublished thinking | Separate approved revision evidence from authoring sources; adversarial citation and retrieval tests |
| Unsupported AI answers | Readers act on invented or misrepresented claims | Evidence-scoped generation, support evaluation, abstention, explicit uncertainty |
| Meaning lost during import | The briefing omits or distorts material context | Extraction preview, locators, reported gaps, representative import fixtures |
| Perspective contradiction | Different audiences receive incompatible positions | Author-reviewed perspectives in the same revision |
| Generic page-builder drift | The product loses its communication focus | Small semantic block vocabulary, realistic briefing design reviews |
| Stale answers after publication | Questions appear grounded in the wrong release | Revision-bound threads, citations, projections, and indexing states |
| Publication or edit races | Lost work or inconsistent releases | Optimistic concurrency, transactional publication, idempotency tests |
| Managed-Postgres privileges | Migrations or seeding fail on a host that withholds superuser rights | pgvector is not a trusted extension, so a superuser must create it first; the owner role needs `CREATEROLE` and `BYPASSRLS` (forced RLS). Verified on PostgreSQL 17.6 with a non-superuser owner; confirm on the chosen host |
| Untested production integrations | Clerk sign-in, the OAuth authorization server, the S3 vendor, a real AI provider and real MCP hosts behave differently from local stand-ins | Vendor-neutral adapters with local tests (MinIO, a local JWKS, mocked Clerk, an AppBridge test host); repeat the same tests against each selected vendor before pilot |
| Analytics overclaiming | Activity is mistaken for comprehension or agreement | Clear labels, explicit feedback, baseline-based outcome measures |
| Reader surveillance | Private questions are exposed or inferred | Disclosure, transcript restrictions, cohort suppression (D07), retention controls |
| Provider outage or cost growth | Unavailable features or unpredictable expense | Manual paths, deterministic local provider (T19), approved fallback, budgets, bounded context, observable usage |
| Schema evolution breaks history | Prior briefings cannot render correctly | Versioned schemas, compatible readers, historical fixtures |
| Job retries duplicate effects | Duplicate publication or processing results | Idempotency keys, transactional enqueueing, persisted work state |
| Cerebro-owned queue defects | Lost, stuck, or double-claimed jobs | Tests for concurrent claiming, recovery of abandoned claims, bounded retries, and failure states on PGlite and PostgreSQL |
| Embedded database hides production behavior | RLS or runtime-role bypass passes locally but fails in production | Run isolation tests against real PostgreSQL with the runtime role in CI |
| Dev identity reaches production | Anyone can sign in as a seeded user | Dev sign-in disabled unless `AUTH_MODE=dev`; tests confirm it is unavailable otherwise; connection tokens are not accepted in place of production delegated authorization |
| Tenant deletion conflicts with snapshots | Data persists contrary to retention commitments | Explicit privileged erasure and backup-retention policy before pilot |
| Host capability or distribution mismatch | The advertised in-conversation workflow is unavailable | Validate first-host account, policy, OAuth, write, UI, and attachment behavior in Phase 0; provide explicit fallbacks |
| Host sends incomplete or unsupported evidence | Polished briefs misrepresent discussion or claim support that was never transferred | Selected-content handoff, provenance, candidate approval, visible gaps and zero-evidence state, source validation |
| Stale preview or guessed audience | Different content or recipients are released from those reviewed | Bind preview to draft/evidence/home/audience; resolve authorized destinations; reject stale release requests |
| Connected client exposes private feedback | Authors retrieve private reader conversations through their LLM | Purpose-specific feedback endpoint, current authorization, and transcript privacy tests |
| Admin self-adds to a team (accepted under D09, D10) | An admin gains a team's or department's audience access through a structural change | Audited membership change; break-glass remains deferred; revisit at architecture review |
| Older revision readable after withdrawal (open, D10) | Content the author meant to retract stays available through a pinned link to an earlier revision | Current behavior recorded for review; revisit at architecture review |

## Review process

For an approved or changed decision, record the decision ID, date, selected behavior, rationale, and affected documents. Approval of one proposal does not automatically approve every open item. Decisions adopted to unblock implementation are reviewed at architecture review and may be changed there.

Before real customer data is used, resolve hosting and provider policy, retention, analytics disclosure, production delegated authorization, and any enterprise requirements.

## Current implementation state

Implementation is proceeding on the defaults above. This register does not record any phase or feature as complete; progress is recorded in [MVP_PLAN.md](MVP_PLAN.md) only when acceptance evidence exists.
