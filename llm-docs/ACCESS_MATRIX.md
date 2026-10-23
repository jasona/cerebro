# Access matrix

**Status:** Phase 0 access matrix. Adopted 2026-10-22 to unblock implementation, at the user's direction to proceed on the planned defaults; revisit at architecture review. It applies D03–D05, D07, D09, and D10 in [RISKS_AND_DECISIONS.md](RISKS_AND_DECISIONS.md) and the proposed visibility defaults P13–P16.

The matrix describes intended policy. It is not evidence that any capability is implemented. Domain services enforce it on every query, mutation, job, asset, citation, retrieval, and cache; UI and route middleware are not the security boundary.

## How roles combine

- **Company roles** (`owner`, `admin`, `member`) come from an active company membership. They control administration and membership-derived reading.
- **Briefing roles** (`owner`, `editor`, `publisher`, `reader` grant) are held per briefing. A person's capabilities on a briefing are the union of their company role and any briefing role.
- Editor and publisher roles require active company membership. An external user can hold only a reader grant.
- Every capability requires current status: removed memberships, revoked grants, and revoked connections take effect on the next protected operation.
- Removing a company membership revokes all of that user's briefing grants in the company (D10). A re-invited member starts with no editor, publisher, or reader grants.
- A connected LLM acts as the authenticated user. Connection scope can narrow, never widen, these capabilities.

## Capabilities

Legend: **Yes** — permitted. **No** — not permitted. **Audience** — only when the derived audience rules below include the person. **Grant** — only the granted briefing, or the granted revision for a revision-scoped grant. **Own** — only the person's own records.

### Content capabilities

| Role | View library | Read published | View approved evidence | View draft | Edit draft | Publish | Manage access | Withdraw |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Company owner | Yes, filtered | Audience | With read | No | No | No | No | No |
| Company admin | Yes, filtered | Audience | With read | No | No | No | No | No |
| Company member | Yes, filtered | Audience | With read | No | No | No | No | No |
| External reader | No | Grant | With read | No | No | No | No | No |
| Briefing owner | Yes, filtered | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Briefing editor | Yes, filtered | Yes | Yes | Yes | Yes | No | No | No |
| Briefing publisher | Yes, filtered | Yes | Yes | Yes | No | Yes | No | Yes |
| Briefing reader grant | As company role | Grant | With read | No | No | No | No | No |

### Engagement and administration capabilities

| Role | View author engagement | View submitted feedback | View private Q&A | Manage departments/teams | Manage memberships | Create connection token |
| --- | --- | --- | --- | --- | --- | --- |
| Company owner | No | Own | Own | Yes | Yes | Yes |
| Company admin | No | Own | Own | Yes | Yes | Yes |
| Company member | No | Own | Own | No | No | Yes |
| External reader | No | Own | Own | No | No | No |
| Briefing owner | Yes | Yes | Own | — | — | — |
| Briefing editor | Yes | Yes | Own | — | — | — |
| Briefing publisher | Yes | Yes | Own | — | — | — |
| Briefing reader grant | No | Own | Own | — | — | — |

A dash means the briefing role adds nothing; the person's company role applies.

### Notes

- **Filtered library.** Lists, counts, search results, and snippets include only briefings the person can read, plus drafts in My drafts for briefings where they hold owner, editor, or publisher. External readers have no company library or directory access.
- **Company owner and admin.** Per D09, these roles manage structure, memberships, invitations, and policy. They read only what their own audience membership or grants allow. They have no implicit access to drafts, restricted briefs, sources, or private Q&A. An owner can additionally assign and remove owner and admin roles. An audited break-glass access path is deferred. An admin who adds themselves to a team or department gains that unit's audience access; this is an audited structural action and an accepted risk (D10).
- **Briefing home.** Per D10, owners and admins may home a briefing anywhere in the company. Other members may home a briefing, on creation or by a move, only in the company home, a department they belong to explicitly or through one of its teams, or a team they belong to. These are the same destinations the connected LLM offers.
- **Publish.** Per D05, the briefing owner or a designated publisher publishes; self-publication is allowed and no second approver is required. Publication releases the exact reviewed draft, evidence, home, and audience.
- **Manage access.** Covers audience changes, grants, invitations, designating editors and publishers, and share-link creation and revocation. Only the briefing owner holds it in the MVP. Named readers given by user id must be active company members or existing grantees of that briefing; external readers are added by email through grants or invitations (D10). Invitation acceptance rechecks that the inviter still holds the authority the invitation needs.
- **Approved evidence.** Readers see only approved excerpts in the revision's evidence package. Original sources require separate authorization and are not available through reader access.
- **Author engagement.** Aggregate activity and recurring topics with cohort suppression (D07). Per-revision counts (opens, section views, evidence opens, questions asked) and topics are withheld when fewer than 3 distinct readers contributed; topic reader counts are computed by Cerebro, never taken from the AI provider. It never exposes raw private Q&A. Phase 5.
- **Submitted feedback.** Questions and feedback a reader explicitly submitted with attribution. Readers see their own submissions. Phase 4.
- **Private Q&A.** Only the asker can view their own threads (D07). No company or briefing role grants access to another person's private Q&A. Phase 4.
- **Connection token.** A dev/test stand-in for delegated MCP authorization (D08). An active company member creates one for their own account in Settings and can revoke it. Production uses OAuth account linking instead.

## Derived audience rules

A briefing's visibility is one of `company`, `department`, `team`, or `restricted`. Membership-derived reading applies only to published content and its approved evidence. All membership-derived access requires active company membership.

| Visibility | Who can read the published briefing |
| --- | --- |
| `company` | Every active company member |
| `department` | Explicit members of the audience department and active members of that department's teams |
| `team` | Active members of the audience team; parent department membership alone is insufficient |
| `restricted` | Only people holding a reader grant or a briefing role |

In every case, briefing owners, editors, and publishers can read the briefing, and reader grants add named readers. A reader grant can be scoped to one revision. Organizational home is independent of audience; moving a briefing never changes who can read it. Perspectives never change access (D06).

## Share links

Per D04, sharing requires authentication.

- A link is a locator, not authorization. Opening a link requires a signed-in user who already qualifies through the audience rules or a grant. Possessing the URL alone grants nothing.
- **Stable links** resolve to the briefing's current publication. If the current publication is withdrawn, the link shows a withdrawn state without revealing content.
- **Pinned links** resolve to one revision and never grant access to later revisions. If the viewer's grant is revision-scoped, only that revision is available. Withdrawing the current publication withdraws the brief: every earlier revision is withdrawn too, so pinned links show the withdrawn state (D16). Withdrawing an older, non-current publication affects only that revision.
- External readers reach briefings only through explicit grants or invitations. They never receive company membership.
- Link tokens are high entropy, stored as hashes, and support expiry and revocation. Revoking a link does not remove unrelated direct grants.
- Denied, revoked, expired, and withdrawn states do not disclose protected titles, excerpts, or assets.

## Required tests

Each cell of the capability tables needs at least one allowed or denied test through the domain services under the runtime database role. Also test the admin denial cases from D09, external-reader library denial, team-versus-department audience rules, revision-scoped grants, and private Q&A isolation between readers and authors.
