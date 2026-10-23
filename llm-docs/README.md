# Cerebro planning documentation

**Status:** Product brief recorded. Defaults D03–D09 and implementation selections T07 and T16–T22 adopted 2026-10-22 to unblock implementation, at the user's direction to proceed on the planned defaults; revisit at architecture review. **Approved by the user on 2026-10-23 (D19).**
**Created:** 2026-10-22

Cerebro is an AI-native executive communication platform. Its purpose is to turn executive thinking into shared understanding through interactive, evidence-backed briefings.

These documents preserve the project vision, goals, and technical plan. They are planning artifacts, not evidence that features have been implemented. Implementation proceeds on the adopted defaults; architecture review may revisit any of them.

Established product direction now includes Company → Department → Team discovery and LLM-native authoring: executives should be able to create, review, publish, and update briefs from their existing LLM conversations. Detailed technical contracts remain proposals.

## Document map

| Document | Purpose |
| --- | --- |
| [VISION.md](VISION.md) | Product thesis, audience, differentiation, and principles |
| [GOALS.md](GOALS.md) | Product outcomes, MVP scope, non-goals, and success measures |
| [TEAM_WORKSPACES.md](TEAM_WORKSPACES.md) | Company → Department → Team hierarchy, shared discovery, and proposed visibility defaults |
| [LLM_INTEGRATION.md](LLM_INTEGRATION.md) | Primary LLM-native authoring journey, MCP tool contracts, account linking, preview, and publication |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Proposed stack, runtime architecture, modules, and deployment |
| [DOMAIN_MODEL.md](DOMAIN_MODEL.md) | Canonical briefing model, logical database schema, and invariants |
| [USER_JOURNEYS.md](USER_JOURNEYS.md) | Author, reader, and administrator workflows |
| [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) | Visual direction, interaction principles, and interface architecture |
| [AI_AND_EVIDENCE.md](AI_AND_EVIDENCE.md) | Composition, source handling, grounded Q&A, and provider boundaries |
| [SECURITY_AND_PUBLICATION.md](SECURITY_AND_PUBLICATION.md) | Tenant isolation, permissions, publication, sharing, and privacy |
| [ACCESS_MATRIX.md](ACCESS_MATRIX.md) | Phase 0 capability table by company and briefing role, derived audience rules, and share-link behavior |
| [MVP_PLAN.md](MVP_PLAN.md) | Implementation phases, dependencies, acceptance gates, and testing |
| [RISKS_AND_DECISIONS.md](RISKS_AND_DECISIONS.md) | Technical risks and decisions requiring review |
| [REMAINING_WORK.md](REMAINING_WORK.md) | What is left after the first implementation pass: decisions, production foundations, feature depth, pilot readiness |

## Suggested reading order

Team workspace reference: [Company library concept](assets/cerebro-company-workspace-concept.png) shows the requested Company → Department → Team structure and shared discovery. Its [generation prompt](assets/cerebro-company-workspace-concept-prompt.txt) is saved alongside it. The image is an exploratory concept, not an implemented interface.

Visual reference: [Briefing reader concept](assets/cerebro-reader-concept.png), generated with the built-in image generation tool. This is an exploratory visual with fictional sample content, not an implemented interface or an approved final design. The [generation prompt](assets/cerebro-reader-concept-prompt.txt) is saved alongside it.

The reader concept mixes phases: Evidence and perspectives are Phase 2, and Ask/Q&A is Phase 4. The Phase 0 prototype must label phase-gated surfaces.

1. Vision and goals.
2. LLM integration, team workspaces, user journeys, and design system.
3. Architecture and domain model.
4. Security, access matrix, publication, AI, and evidence.
5. MVP plan and decision register.

## Planning conventions

- The user-provided product brief establishes the product direction.
- Technology choices and MVP defaults remain recommendations until reviewed, except those adopted to unblock implementation in `RISKS_AND_DECISIONS.md`. Adopted entries are not a record of user approval of specific details.
- Open decisions are tracked in `RISKS_AND_DECISIONS.md`; assumptions elsewhere must agree with that register.
- Feature completion requires implementation and acceptance evidence. Documentation alone does not establish completion.
- Dates, numerical targets, hosting details, and vendor commitments remain unset unless explicitly agreed.
- Update related documents together when a decision changes. In particular, permission changes affect the schema, reader, retrieval, sharing, and tests.

## Review boundary

The first review covers the initial audience, authenticated sharing, perspective behavior, reader privacy, and publication authority. Defaults for these were adopted as D03–D07 so implementation can proceed; the review may revisit them. A technical review should then confirm the stack, document schema, deployment constraints, production delegated authorization (D08), and Phase 0 acceptance criteria.

These documents do not record implementation progress; see [MVP_PLAN.md](MVP_PLAN.md) for completion evidence.
