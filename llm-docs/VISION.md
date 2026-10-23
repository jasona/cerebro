# Project vision

**Status:** Product direction from the project brief. The initial audience (D03) was adopted 2026-10-22 to unblock implementation, at the user's direction to proceed on the planned defaults; revisit at architecture review.

## Purpose

**Turn executive thinking into shared understanding.**

Cerebro replaces traditional executive presentations with interactive, AI-native briefings that preserve an author's argument, supporting evidence, assumptions, tradeoffs, and intended outcome.

## The problem

Executives increasingly use LLMs to develop strategies and then translate that thinking into presentation slides. Recipients often feed the presentation into another LLM to recover its meaning. This translation cycle loses context, obscures reasoning, duplicates effort, and makes follow-up fragmented.

The challenge is larger than generating a polished artifact. An executive needs colleagues to understand a position, inspect its basis, identify implications for their responsibilities, and resolve unanswered questions.

## The product

The primary authoring entry point is the executive's existing LLM conversation: **Send this to Cerebro.** Executives should be able to turn selected thinking into a structured draft, review and refine it, publish to an explicit audience, and update the same brief conversationally. The company library and reader turn that work into shared understanding. The studio supports deeper editing when needed.

LLM integration is a core MVP workflow and takes priority over sophisticated in-app composition. See [LLM_INTEGRATION.md](LLM_INTEGRATION.md).

A briefing is a persistent communication object with a clear narrative, inspectable evidence, audience perspectives, contextual questions, and version history.

Its lifecycle is:

1. **Capture:** Import AI conversations, documents, presentations, or develop ideas directly.
2. **Compose:** Turn thinking into a structured, visually polished, interactive briefing.
3. **Publish:** Release an intentional version through controlled, shareable access.
4. **Engage:** Let readers explore reasoning, ask grounded questions, and give feedback.
5. **Analyze:** Help authors understand recurring questions, confusion, and unresolved issues.
6. **Evolve:** Update the briefing with explicit changes while preserving prior versions.

## Audience and initial use case

The initial audience (D03) is executives and senior teams communicating strategy and consequential decisions within an organization. Explicitly invited, authenticated external readers extend the same access model without company membership (D04).

A representative briefing might explain a market expansion recommendation, show its evidence and tradeoffs, identify finance and operations implications, and ask leaders to approve a next step.

This initial audience is a planning assumption, not a restriction on the long-term platform.

## Shared company communication

The user has specified a Company → Department → Team structure. Cerebro should make colleagues' briefs easy to discover across that hierarchy, with a shared company library and scoped department and team views. A briefing retains its named author and its organizational home.

The proposed default is company-wide visibility for published briefs, with explicit restricted audiences when needed and private collaborator-only drafts. See [TEAM_WORKSPACES.md](TEAM_WORKSPACES.md) for the distinction between organizational structure and access.

## Differentiation

Cerebro is a communication medium whose primary interface is the briefing itself. AI assists with composition and exploration in context.

The distinctive experience should come from:

- A strong executive narrative that communicates the point before asking the reader to interact.
- Reasoning and evidence that remain attached to claims.
- Audience perspectives that make implications relevant without changing the underlying facts.
- Two-way understanding through questions and explicit feedback.
- Deliberate publication and a clear account of what changed.

## Product principles

- **Lead with meaning.** Show the position, stakes, and requested outcome immediately.
- **Preserve authored reasoning.** Retain assumptions, alternatives, uncertainty, and rationale that the author chooses to communicate.
- **Make evidence inspectable.** Readers should be able to examine support for material claims.
- **Keep the author accountable.** AI suggestions do not become published statements without author review.
- **Respect reader attention.** Support both a quick understanding and a deeper investigation.
- **Make permission explicit.** Private thinking and approved reader evidence are different resources.
- **Measure useful communication.** Activity signals alone do not establish understanding or agreement.
- **Keep the medium coherent.** New blocks and interactions should strengthen the narrative rather than turn the product into an unconstrained page builder.

## Long-term direction

Cerebro can become a durable organizational record of executive communication: what was proposed, why it was proposed, what people asked, and how the position evolved.

The MVP should prove the briefing experience, shared company discovery, and their trust model before expanding into organization-wide generative Q&A, autonomous workflows, or complex collaboration.
