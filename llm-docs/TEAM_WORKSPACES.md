# Company, department, and team workspaces

**Status:** Company → Department → Team structure requested by the user on 2026-10-22. Detailed discovery and permission defaults below are proposed for review.

## Product direction

Cerebro is a shared company communication space. People should be able to find what colleagues and other teams are thinking about without collecting individual share links.

```text
Company
├── Department
│   ├── Team
│   └── Team
└── Department
    ├── Team
    └── Team
```

Company is the user-facing name of the existing organization tenant. Departments and teams are contained within it; they are not separate tenants.

## Briefing placement

A briefing has one home at company, department, or team level. Company briefs can communicate strategy across departments. Department briefs can coordinate multiple teams. Team briefs can communicate plans, decisions, and progress.

The executive can select this home from a connected LLM using natural language such as "Send this to the Platform team." The integration resolves authorized destinations, remembers explicit preferences, and shows home and audience separately before publication. The resulting brief appears in the same library views as a first-party publication. See [LLM_INTEGRATION.md](LLM_INTEGRATION.md).

Every briefing retains a named author or owner as well as its organizational home. A person's profile or author filter provides a view of their accessible briefs, not a second copy of those briefs.

People may belong to multiple teams. Each team belongs to one department; each department belongs to one company. Cross-functional collaboration uses multiple memberships and explicit collaborators rather than multiple parent departments in the MVP.

## Shared discovery

- The company home aggregates authorized published briefs across all departments and teams.
- A department home aggregates its own briefs and the briefs of its teams.
- A team home shows its own briefs and relevant parent announcements in a separately labeled section.
- Filters include department, team, author, and recency. Search initially covers authorized briefing titles, summaries, and metadata.
- Briefing rows show the title, short summary, author, department/team path, published version, and update time.
- My drafts and editing views remain personal or collaborator-scoped.
- Unread and recently updated indicators help readers identify changes; they do not imply understanding.

All lists, counts, previews, and search results apply the same authorization rules as the reader. An inaccessible brief must not leak through an aggregate count or search snippet.

Company-wide browsing and ordinary briefing search are MVP capabilities. Organization-wide generative Q&A remains deferred.

## Proposed visibility defaults

Published briefs are visible to active company members by default. The publisher sees the audience explicitly before release. Drafts remain limited to their authorized collaborators.

Sensitive briefs can instead use a department audience, a team audience, or named-reader grants. External readers always require explicit access and do not receive company directory access (D04). [ACCESS_MATRIX.md](ACCESS_MATRIX.md) applies these defaults.

Organizational home and audience are separate fields. A brief can live under Finance / Planning while being readable company-wide. Moving it into another team must not silently broaden or narrow access.

Department audience membership includes explicit department members and active members of teams in that department. A team audience includes active members of that team; membership in its parent department does not automatically grant access to a team-restricted brief. All such access also requires active company membership.

Company-wide visibility grants reading of released content and approved evidence, not access to drafts, original sources, private questions, or author-only engagement data. Editing and publication remain explicit capabilities.

## Navigation and design

The library has a company switcher and expandable Department → Team navigation, with All briefs and My drafts as convenient views. The main pane presents a curated briefing list rather than a generic analytics dashboard.

Company and department pages offer quick access to their children. Team pages show their name, parent path, member context, and briefs. A New brief action inherits the current home but still displays the audience before publication.

Opening a brief preserves a breadcrumb back to its home. The reader remains focused on the narrative; the full organization tree belongs in the workspace library and can collapse while reading.

## Membership and lifecycle

Company administrators manage departments and teams initially. Delegated department and team administration can be added after an explicit capability decision. Administration does not include content access: admins read only what their own audience membership or grants allow (D09, [ACCESS_MATRIX.md](ACCESS_MATRIX.md)).

Removing company membership invalidates derived department/team access. Removing team membership invalidates team audience access, but a company-visible brief remains readable while company membership remains active.

Changing a team's department changes derived department membership and must be treated as an access-affecting operation: preview consequences, audit the move, and invalidate affected authorization caches. Archived departments and teams retain briefing provenance; reorganization and deletion must not orphan briefs.

## Acceptance scenarios

1. A company member finds another department's company-visible brief without a direct invitation.
2. A department page includes accessible briefs from its teams.
3. An author filter shows a colleague's accessible briefs across multiple teams.
4. Team members cannot discover another team's restricted brief without applicable access.
5. Company discovery never exposes drafts or private Q&A.
6. Moving a briefing changes its organizational placement without changing its audience.
7. An invited external reader can open their briefing but cannot browse the company workspace.
