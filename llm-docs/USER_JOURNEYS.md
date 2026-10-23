# Primary user journeys

**Status:** Proposed workflows. D03–D07 and D09 were adopted 2026-10-22 to unblock implementation, at the user's direction to proceed on the planned defaults; revisit at architecture review. **Approved by the user on 2026-10-23 (D19).**

The primary authoring journey starts in the executive's existing LLM. The flows below support both that entry point and Cerebro's first-party studio. See [LLM_INTEGRATION.md](LLM_INTEGRATION.md).

## Primary journey — Send this to Cerebro

The executive connects their account, chooses a default company and optional team, and continues thinking in their LLM. They ask, "Turn this into a Cerebro brief for the Platform team. Make it visible to the company."

The integration resolves an authorized destination and creates a private structured draft from selected content. It presents the title, Company → Department → Team home, intended audience, included sections, evidence status, and reader preview. An unresolved destination triggers a focused clarification rather than a guessed company.

The executive refines the brief conversationally, reviews the result, and explicitly publishes. The integration returns the published revision and canonical link; the brief appears in the authorized company and team views. Where embedded UI is unsupported, provide a structured summary and authenticated preview link.

Later, the executive asks to update that same brief or address submitted reader questions. The integration retrieves the authorized current version, proposes a change, previews the diff, and publishes a new revision when instructed. Private reader Q&A is never exposed through the author-feedback workflow.

## 1. Join an executive workspace

An author signs in, creates a company or accepts an invitation, and enters a shared briefing library organized as Company → Department → Team. The company home surfaces colleagues' accessible published briefs, recent changes, and items needing attention. My drafts is a separate personal or collaborator view.

The reader browses a department, expands its teams, or filters by author to see a colleague's accessible briefs. They do not need a direct share link for every company-visible publication. A new brief inherits its organizational home from the current view, while audience is an independent, explicitly displayed choice.

Organization context is explicit. Changing organizations changes the authorized resource set. An invited external reader receives access only to the granted briefing or revision, without automatically becoming an organization member.

## 2. Capture existing thinking

The preferred entry point transfers selected thinking and available source material from a connected LLM. The author may also paste a conversation or Markdown, upload a PDF, DOCX, or PPTX, or start with an idea in Cerebro. Full conversation history, hidden reasoning, and all host attachments are not assumed available.

The system validates the input, preserves an immutable source, extracts text with locators, and presents extraction results for review. The author can correct interpretation, identify missing context, and exclude material from composition.

The experience reports unsupported or incomplete extraction. An unsuccessful import remains recoverable and does not produce an apparently complete briefing. Imported private thinking does not become reader-accessible merely because it was uploaded.

## 3. Compose a briefing

The author identifies the audience, intended outcome, and central position in their LLM or the studio. The connected host can supply structured blocks; Cerebro validates and renders them without an unnecessary rewrite. Cerebro AI can also propose a narrative structure and draft blocks based on selected sources.

The author reviews the proposal, edits the argument, inspects source references, and marks uncertainty or unsupported claims. AI changes are proposed edits that can be accepted, rejected, or revised.

Autosave communicates its state. Concurrent updates produce a visible conflict with a recovery path instead of silently overwriting work. Manual authoring remains available if AI fails.

## 4. Prepare audience perspectives

The author adds perspectives such as finance or operations, either by asking their connected LLM to write one into the handoff or by editing it manually (Phase 2). Each contains approved implications, emphasis, or navigation guidance connected to the same canonical argument. Cerebro AI can suggest perspectives for the author to adopt from Phase 3.

Preview switches perspectives so the author can inspect the entire experience. Perspectives never conceal confidential sections or change access (D06). A sensitive variant requires a separately permissioned briefing.

## 5. Publish and share

The author or designated publisher reviews the reader preview, evidence candidates, audience access, and change summary; self-publication is allowed (D05). The author approves or excludes each evidence candidate, and only approved excerpts publish. A brief with no approved evidence shows "no supporting evidence attached" to readers. Publication produces an immutable revision and an auditable release record.

The same operation is available from the connected LLM. Publication binds to the reviewed draft version, evidence, home, and audience. Stale previews require renewed review; an idempotent retry does not create an additional release. Host permission controls remain applicable.

The publisher shares an authenticated link or invites named readers. A stable link resolves to the latest authorized publication; a pinned link resolves to one revision. Possession of a URL alone does not satisfy the proposed authenticated-access policy.

If evidence indexing is incomplete, the briefing can be read while Q&A clearly shows a preparation state. The application must not answer using an older revision under the new revision's identity.

## 6. Read and explore

A reader opens the briefing and immediately sees its position, stakes, and intended decision or action. They can choose an available perspective, navigate sections, expand rationale, and inspect approved evidence.

The current revision remains visible. Deep links identify the relevant revision and block. On mobile, evidence and Q&A open in focused sheets without obscuring how to return to the narrative.

Denied, revoked, expired, or withdrawn access produces a clear state without disclosing protected titles, excerpts, or assets.

## 7. Ask and respond

A reader asks about a specific section or the briefing as a whole. The answer draws from the exact published revision and approved evidence, with references that can be inspected.

When the evidence cannot support an answer, the interface says what is missing and offers explicit submission to the author. Submission is a separate reader action; asking privately is not automatically attributed feedback.

Reader privacy and aggregate analysis are disclosed before use. Switching to a new revision starts a new revision-bound question context or explicitly retains the old one; conversations cannot silently change their grounding.

## 8. Understand engagement

The author opens the briefing's engagement view and sees aggregate activity, recurring topics, and explicitly submitted unresolved feedback.

The author can retrieve the same permitted feedback through the connected LLM and use it to draft a clarification. This access does not include private reader transcripts.

The interface distinguishes measured events, generated topic summaries, and actual reader statements. It does not label dwell time as understanding or silence as agreement. Topic summaries drawing on fewer than 3 distinct readers are suppressed, a provisional implementation setting (D07).

## 9. Evolve the communication

The author uses feedback to update the draft, reviews a structured comparison against the previous revision, and writes a material change summary.

Publication creates a new revision. Existing answers, feedback, and pinned links retain their original context subject to current authorization. Stable links move to the new publication. Removed blocks remain inspectable only through authorized prior revisions.

## 10. Administer access

Administrators manage company membership, departments, teams, invitations, and administrative policy. People may belong to multiple teams. Briefing owners manage permitted collaborators and readers according to [ACCESS_MATRIX.md](ACCESS_MATRIX.md).

Membership removal, grant revocation, link expiration, and withdrawal take effect on subsequent protected operations. Administrators read only what their own audience membership or grants allow; they have no implicit access to drafts, restricted briefs, sources, or private Q&A (D09). An audited break-glass path is deferred.
