# Goals and MVP scope

**Status:** Proposed scope and measurement plan, pending review.

## Primary goal

Enable an executive to turn existing thinking into a trustworthy interactive briefing that colleagues can understand, question, and revisit.

The first end-to-end proof begins in an executive's connected LLM: create a structured draft from selected thinking, review it, publish it to an authorized company/department/team home, and let colleagues discover it immediately. The complete feedback loop adds a reader understanding the requested decision and inspecting evidence, followed by the author using submitted feedback to publish a clearer revision from the same LLM workflow.

## Desired outcomes

| Outcome | Evidence to collect |
| --- | --- |
| Authors communicate more efficiently | Time from source material to an author-approved publishable briefing |
| Authors publish without transferring work manually | Completion of the connected LLM-to-publication journey; clarification steps and application switches required |
| Readers understand the intended message | Reader ability to identify the position, decision, and relevant implications |
| Readers can investigate claims | Successful navigation from a claim or answer to supporting evidence |
| Questions receive trustworthy answers | Supported-answer rate, citation quality, appropriate abstention, reader feedback |
| Authors learn what needs clarification | Recurring topics and explicitly unresolved feedback that lead to useful revisions |
| Readers can follow evolution | Ability to identify material changes between authorized revisions |

Numerical targets and measurement methods must be agreed before a pilot. Establish baselines with representative executive communication tasks rather than inventing targets during implementation.

## MVP capabilities

- Authentication, companies, departments, teams, memberships, and briefing permissions.
- A shared company briefing library with department/team views and filters for author and recency.
- Easy discovery of colleagues' published briefs, with company-visible publication proposed as the default.
- LLM-native creation, conversational revision, preview, and explicit publication through an authenticated integration.
- One-time account linking with reauthentication when necessary, remembered authorized destination preferences, and supported-host fallbacks.
- Minimal manual editing and publication as a reliable fallback, followed by deeper studio editing and AI-assisted composition.
- Capture through pasted text or Markdown and text extraction from PDF, DOCX, and PPTX.
- A polished responsive reader with progressive disclosure.
- Author-approved audience perspectives: author-written first, AI-suggested later.
- Minimal evidence approval in the connected and first-party preview, with an explicit state when no evidence is attached.
- Grounded Q&A with inspectable references to approved evidence.
- Authenticated sharing, invitations, expiration, and revocation.
- An author engagement view with recurring topics and unresolved feedback.
- Immutable published revisions, change summaries, and basic comparison.

## Proposed scope limits

- Perspectives change emphasis and implications; they do not introduce section-level confidentiality (D06).
- Import extracts meaning and provenance; it does not promise faithful reconstruction of slide layouts or complex charts.
- Multiple editors use conflict detection; simultaneous live editing is deferred.
- Publication is deliberate and human-controlled; a multi-stage approval engine is deferred.
- LLM integration precedes advanced studio composition. Host-specific capability and distribution validation is required; universal inline support is not assumed.
- Q&A is scoped to one published revision and its approved evidence.
- Ordinary authorized company-wide briefing search and browsing are included; organization-wide generative Q&A remains deferred.
- Basic history compares structured content using stable block IDs; it is not a general-purpose branching system.

## Non-goals for the initial MVP

- A general chatbot or unrestricted organization-wide AI search.
- A freeform slide or website builder.
- Autonomous publication or external communication.
- Native mobile applications.
- Real-time collaborative editing.
- OCR and complex visual reconstruction across all imported formats.
- Automatic access to private AI conversation links.
- Automatic capture of all chat history or hidden model reasoning.
- A full enterprise compliance, SSO, provisioning, or records-management suite. Any such requirement must be assessed before committing to a customer pilot.

## Quality goals

- Strong authorization and tenant isolation across web requests, jobs, assets, retrieval, and caches.
- Reading, manual editing, and publication remain usable during model-provider outages.
- Accessibility targets WCAG 2.2 AA, including keyboard use and chart alternatives.
- Published content and citations remain reproducible for their revision.
- Failed imports and AI runs have visible, recoverable states.
- AI cost, latency, errors, and retrieval quality can be measured without logging sensitive payloads by default.

## Pilot readiness

Pilot readiness requires evidence of tenant isolation, representative end-to-end journeys, recoverable failures, backup restoration, accessibility review, and grounded-answer quality. It also requires decisions on hosting region, permitted AI providers, retention, and reader analytics disclosure.

Reading time and scroll depth are supporting engagement signals. They must not be labeled as comprehension, agreement, or approval.
