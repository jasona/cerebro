# Security, publication, and sharing

**Status:** Policy and implementation boundaries. D04, D05, D07, D08, D09, and D10 were adopted 2026-10-22 to unblock implementation, at the user's direction to proceed on the planned defaults; revisit at architecture review. Other items remain proposals.

## Authorization model

In production, Clerk supplies identity and sessions. Local development and tests use a dev identity adapter with seeded users and a signed session cookie; its sign-in page is explicitly dev-only and disabled unless `AUTH_MODE=dev` (D08). Both resolve to the same Cerebro user record. Cerebro stores organizations, memberships, briefing grants, and product policy.

Company is the user-facing organization tenant. Departments and teams organize work inside it. The proposed default is that published briefs are readable by active company members; drafts remain collaborator-only. Optional department, team, and named-reader audiences restrict sensitive publications. Organizational home is independent of audience, and moving a brief does not silently change its permissions.

Department audiences include explicit department members and members of that department's teams. Team audiences require membership in that team; parent department membership alone is insufficient. Derived access always requires active company membership. Company-visible reading does not grant editing, publication, original-source access, private Q&A access, or author-only analytics. See [TEAM_WORKSPACES.md](TEAM_WORKSPACES.md).

Organization roles (owner, admin, member) control administration. Briefing roles (owner, editor, publisher, reader grant) control content capabilities. [ACCESS_MATRIX.md](ACCESS_MATRIX.md) defines each role's capabilities and how they combine.

The briefing owner or a designated publisher may publish; self-publication is allowed (D05). Company admins manage structure, memberships, invitations, and policy, but read only what their own audience membership or grants allow. Administrative status gives no implicit access to drafts, restricted briefs, sources, or private Q&A. An audited break-glass access path is deferred (D09).

An external user can receive an explicit briefing or revision grant without gaining organization membership (D04). Reader grants never authorize draft access. A perspective changes relevance, not permission (D06).

Per D10, owners and admins may home a briefing anywhere in the company; other members only where they could publish (company home, their departments, their teams). Named readers given by user id must be active members or existing grantees of that briefing, with one uniform error otherwise, so the check reveals nothing about global user ids. Removing a membership revokes the user's briefing grants in that company. An admin adding themselves to a team is an audited structural action that does grant audience access, accepted as a risk under D09.

## Tenant isolation

The same controls apply to the incoming MCP adapter and first-party application. OAuth client scopes limit delegated capabilities but never substitute for current company membership and briefing permissions. Company or user identifiers supplied by an LLM are untrusted until resolved against authenticated context.

- Resolve identity and organization context on the server.
- Authorize every protected query and mutation close to data access.
- Include organization identity in relational constraints to prevent cross-tenant links.
- Apply PostgreSQL row-level security as an additional layer.
- Use a runtime database role without table ownership or `BYPASSRLS`; separate migration credentials.
- Use transaction-local authorization context to avoid connection-pool context leakage.
- Apply equivalent checks to workers, file access, exports, citations, and retrieval.
- Scope caches to authorization context and invalidate them when permissions change; do not publicly cache private responses.
- Filter company, department, team, and author lists, search snippets, and counts by current permission. External invitees do not gain company directory access.
- Recheck current grants rather than trusting stale UI state or previously queued work.

PostgreSQL documents that owners and bypass roles can evade ordinary row policies. This affects runtime-role design and isolation testing. [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)

## Publication transaction

Both first-party and integrated publication use this transaction. An integrated request includes a server-issued preview reference bound to the actor, draft version, content/evidence digest, home, audience, and expiry. Revalidate these bindings before release; a prepared reference alone is not evidence that the author approved publication.

1. Confirm current publish permission, the expected draft version, and that the briefing's current publication is still the one the preview was bound to. A changed publication pointer makes the preview stale with reason `publication` (D10).
2. Validate the document schema, block IDs, perspectives, and evidence references.
3. Create an immutable revision and approved evidence snapshot. Only candidates the author approved enter `revision_evidence`; excluded and pending candidates stay private. Zero approved evidence is valid and renders an explicit "no supporting evidence attached" state.
4. Record publisher, time, and change summary in a publication record.
5. Move the briefing's current-publication pointer to that record.
6. Record the audit event and enqueue indexing work in the transaction.

Use idempotency protection so retries do not publish duplicate releases. A failed transaction leaves the previous publication intact. Readers see a complete snapshot, never a partially assembled publication.

Record the authenticated actor, integration client/connection when applicable, and operation reference in the audit trail without credential or prompt payloads. Reusing an idempotency key with changed input is an error. Operation-status and cached-result reads require current access checks.

Q&A can remain unavailable while indexing completes. Reading the stored revision does not require successful embedding generation or model availability.

## Revision and withdrawal behavior

Edits from a connected LLM follow the same revision and withdrawal rules as first-party edits.

Edits after publication modify the draft and produce a new revision when released. Existing citations, answers, and feedback retain their original revision context.

Withdrawal removes reader availability without rewriting the content snapshot. Withdrawing the current publication should clear its current pointer and require a deliberate decision before promoting another revision. A withdrawn revision is removed from Q&A, retrieval, and indexing. Earlier, non-withdrawn revisions stay readable by pinned link for their audience; this is current behavior, open for review (D10). Retention or erasure obligations require a separately defined privileged workflow.

## Connected account lifecycle

Per D08, production uses an established OAuth authorization server compatible with the chosen MCP hosts. Clerk's OAuth/MCP support is the first candidate; verification is pending. Web login and MCP authorization are distinct integration concerns.

Local development and tests use connection tokens instead. They are high entropy, stored only as hashes, tied to an `integration_connections` row, created by the user in Settings, and revocable. They are a dev/test stand-in only, not the production delegated-authorization design, and production must not accept them in its place. Revoking the connection invalidates the token on the next request. The MCP adapter enforces this by authenticating every request; the domain records the connection for audit but does not recheck it (D10).

Remember explicitly chosen destinations and styles, then reauthorize them before use. Support reauthentication and connection revocation. Never place credentials in tool arguments or source documents. Host approval dialogs and workspace restrictions remain applicable; integration convenience cannot bypass them.

Transfer selected source material only. The author-feedback endpoint returns submitted questions and permitted aggregate topics, never raw private reader Q&A. A supported host must provide a verified review/action flow; otherwise publication falls back to the first-party surface.

## Sharing

Per D04, sharing requires authentication and an applicable grant or explicitly permitted organization visibility. A link is a locator and policy context, not sufficient authorization by itself. See [ACCESS_MATRIX.md](ACCESS_MATRIX.md) for derived audience rules.

- Stable links resolve to the latest authorized published revision.
- Pinned links resolve to a specific revision and do not grant access to future revisions.
- Invitations bind access to an intended verified identity or email according to the agreed identity policy. Acceptance rechecks the inviter's current authority (D10).
- Tokens are high entropy, stored as hashes, and support expiry and revocation.
- Link revocation and grant revocation are distinct operations and must be communicated clearly. Revoking a link does not silently remove unrelated direct grants.
- Original source files require separate authorization. Evidence citations expose only approved excerpts by default.
- Assets use private storage and short-lived signed access where appropriate.

Authorization cannot retract information already downloaded by a reader. Expiration and revocation govern subsequent system access.

## Privacy and analytics

Per D07, reader Q&A transcripts are private to the asker, while disclosed aggregate topic analysis is allowed. Attributed questions or feedback reach the author only when the reader explicitly submits them. No company or briefing role grants access to another person's private Q&A.

`briefing_reads` is a private per-user reading-state record (last opened revision and time per briefing) used only for the reader's own "Unread" / "New version" library badges. Row-level security limits every row to its own user within the organization, so authors, publishers and admins cannot read it; no engagement summary, insight or author view uses it, and it does not weaken the pseudonymous session keying of `engagement_events`.

Telemetry should use minimal payloads and pseudonymous session identifiers where feasible. Topic summaries and per-revision activity counts use cohort suppression: each is withheld unless it draws on at least 3 distinct readers, a provisional implementation setting. Cerebro computes distinct readers itself and never trusts a provider's count. Identifying content needs careful handling even above that threshold. Product reporting must distinguish observations from inferred interpretations.

Set retention for originals, approved evidence, Q&A, feedback, telemetry, audit records, and backups before handling pilot data. Published immutability describes normal editing behavior; it does not override the agreed retention policy.

## Audit scope

Record publication, withdrawal, membership changes, grant changes, invitations, link lifecycle changes, and privileged retention operations. Include actor, organization, target, revision where relevant, and timestamp.

Also record department/team membership changes, team reparenting, briefing home moves, and audience changes. Reparenting a team may change derived department access and requires an impact preview and cache invalidation.

Audit payloads should avoid unnecessary source content. Application credentials should not support routine alteration of historical audit records. This MVP audit log is not a claim of regulatory certification or tamper-proof archival storage.

## Required security verification

Test cross-tenant resource identifiers, revoked membership, unauthorized drafts, admin denial cases, revision-scoped grants, original-file access, stale caches, retrieval boundaries, background jobs, publication races, guessed citation IDs, revoked connection tokens, and the dev sign-in page being unavailable unless `AUTH_MODE=dev`. Exercise the actual runtime database role so row-policy bypass is not hidden by test credentials.
