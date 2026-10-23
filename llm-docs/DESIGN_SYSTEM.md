# Design system and interface architecture

**Status:** Proposed design direction. Exact visual tokens and reference screens will be approved in Phase 0.

## Experience principle

The briefing is the primary interface. Its opening should answer: what is the position, why does it matter, and what is needed from the reader?

Build an executive publication with depth: a clear narrative, progressively disclosed reasoning, inspectable evidence, and contextual assistance. The same briefing should support a quick reading and a thorough investigation.

## Visual foundations

| Area | Direction |
| --- | --- |
| Color | Warm paper, deep ink, muted surfaces, restrained indigo accent |
| Typography | Editorial serif for major statements; readable sans serif for body and controls |
| Layout | Generous whitespace, strong hierarchy, narrow reading measure, wider evidence panels |
| Density | Calm reading surfaces; compact controls only where authoring needs them |
| Borders and elevation | Subtle separation with elevation reserved for temporary layers |
| Motion | Brief transitions that preserve context; reduced-motion support |
| Data presentation | Clear units, source context, labels, accessible alternatives |

Define semantic tokens for background, foreground, accent, muted content, status, focus, spacing, typography, radius, borders, elevation, and motion. Choose exact values through contrast checks and representative screens. Components should consume tokens rather than embed unrelated style values.

## Application surfaces

### Connected LLM preview

The primary authoring entry point includes a compact preview inside a supported LLM conversation. It shows the briefing title, organizational home, explicit audience, included sections, evidence status, and actions to preview, save as draft, or publish.

Use the canonical briefing renderer and design tokens where host constraints permit. The host component is a focused review surface, not the full studio. Show save/composition state and change summaries for revisions. A text-only host receives a structured result and authenticated preview link.

One explicit publication action should release the reviewed content and audience, subject to host policy. A stale draft or changed audience requires an updated preview; avoid redundant confirmations when nothing has changed. Missing evidence must remain visible rather than being hidden by a polished layout.

Preview lists each evidence candidate with its attribution and an approve/exclude toggle in the first-party preview. Only approved excerpts publish. Embedded MCP Apps UI is deferred (T14); until then the connected host shows a structured summary and links to the first-party preview.

### Library

The workspace is a shared company library with an expandable Company → Department → Team navigation tree. All briefs aggregates accessible publications; department views include their teams; team views focus on local briefs. My drafts is separate from shared published work.

The main pane uses readable briefing rows showing title, short summary, author, department/team path, version, and update time. Search and filters for department, team, author, and recency make colleagues' work easy to find. Company, department, and team landing views use the same vocabulary and list components. New brief inherits the current home, with audience shown separately before publication.

Avoid making generic metric cards the initial product experience. Information shown here should help the executive continue work or identify a communication requiring attention.

### Studio

The desktop studio has an outline, a briefing canvas, and a contextual inspector. Selecting a block exposes its editing controls, evidence, and relevant AI actions.

The studio is the deeper-editing surface and manual fallback. A sophisticated studio is not a prerequisite for the first LLM-to-publication milestone. The manual editor uses structured block forms. Prose fields (position summary, stakes, background, request detail, perspective summaries, and the narrative, key finding detail and decision rationale blocks) use a Tiptap field limited to what the RichText syntax holds: paragraphs, line breaks, bold, italic and http(s) links. Each field has a labelled formatting toolbar (one tab stop, arrow keys between buttons, `aria-pressed` state) and the shortcuts Ctrl/⌘+B, I and K. Other text fields stay plain inputs (T22, W3.4).

The canvas uses the same content components as the reader. The inspector offers actions with clear scope, such as refining the selected paragraph, identifying unsupported claims, or proposing an alternative structure.

On smaller screens, outline and inspector become focused views rather than permanently compressed columns.

### Reader

The reader leads with the executive position, stakes, and requested outcome. A lightweight section outline, reading progress, and version identity provide orientation.

A breadcrumb connects the briefing to its company/department/team home. The full workspace tree can collapse while reading so the argument retains visual priority.

Evidence opens beside the related claim on desktop and in a focused sheet on mobile. When no evidence is approved, the reader shows an explicit "no supporting evidence attached" state. Contextual Q&A preserves the originating passage and provides a direct return path.

**Phase note for the [reader concept](assets/cerebro-reader-concept.png):** the concept shows surfaces from several phases. Evidence and perspectives are Phase 2; Ask/Q&A is Phase 4. The Phase 0 prototype must label phase-gated surfaces so reviewers do not read them as available in the first release.

### Engagement and history

Engagement and version history are author views within the briefing. They help improve this communication through unresolved feedback, recurring topics, material changes, and clear version comparison.

## Semantic components

- Executive statement and summary.
- Decision or request panel.
- Narrative and rationale blocks.
- Evidence annotation and source excerpt viewer.
- Metric with units, date context, and source.
- Comparison, chart, and timeline.
- Risk, assumption, and uncertainty annotation.
- Action with optional owner and date.
- Perspective selector and implications panel (Phase 2).
- Contextual question entry and cited answer (Phase 4).
- Publication status, version identity, and change summary.

A new component should map to a useful communication purpose and a defined schema. Do not introduce arbitrary layout primitives simply to reproduce slides.

## Interaction and state requirements

- Preview and published reading share a renderer.
- Edit mode makes selection clear without overwhelming the narrative.
- AI proposals show scope and require an explicit author action before adoption.
- Save, extraction, composition, publication, indexing, and answer-generation states are visible.
- Loading and failure states preserve the user's work and explain the available recovery action.
- Empty states help users begin the relevant task.
- Version changes are explicit, particularly when a question or link references older content.
- Questions are available contextually; a permanent chat pane is not required to read a briefing.

## Accessibility and responsive behavior

Target WCAG 2.2 AA. Verify keyboard navigation, semantic headings, visible focus, screen-reader labels, text contrast, reduced motion, and focus restoration after panels close.

Charts need meaningful text or tabular alternatives. Important information cannot depend only on color, hover, or animation. Reading layouts must reflow for narrow screens and zoom without losing content or controls.

## Phase 0 design outputs

Approve a representative strategy briefing rendered on desktop and mobile, the key tokens, core block vocabulary, an evidence interaction, a contextual question interaction, and the connected LLM preview-to-publication transition. Define the minimal manual editing fallback before expanding the studio.
