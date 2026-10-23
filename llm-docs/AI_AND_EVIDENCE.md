# AI, sources, and grounded evidence

**Status:** Proposed AI architecture and trust behavior. D06, D07, T19, and T20 were adopted 2026-10-22 to unblock implementation, at the user's direction to proceed on the planned defaults; revisit at architecture review.

## AI responsibilities

AI assists with source interpretation, structure, drafting, refinement, audience implications, grounded answers, and aggregate topic summaries. The application controls authorization, publication, canonical content, and deterministic validation.

Use task-oriented interfaces such as composition, revision proposal, answer generation, and topic summarization. Provider-specific APIs and model identifiers belong behind these interfaces.

Per T19, the default provider is deterministic and local: answers are extractive and retrieval-based, and composition preserves the supplied structure. It needs no external model, so reading, publishing, and tests never depend on a live model. An AI SDK adapter accepts an injected model; no AI vendor is selected.

## Incoming LLM authoring

The primary creation workflow receives selected content from an executive's connected LLM through the authenticated integration described in [LLM_INTEGRATION.md](LLM_INTEGRATION.md). This incoming host connection is independent of Cerebro's outgoing model-provider calls.

Accept a schema-valid structured draft or selected material for composition. Preserve the author's position, alternatives, assumptions, risks, open questions, and action plan. Do not automatically rewrite a complete structured draft merely to route it through another model.

Capture only material the host can transfer and the author selects. Complete chat history, hidden reasoning, and original attachments are not guaranteed. Host-provided source titles, URLs, and quotations remain unverified attribution until the supporting material can be checked; a conversation summary alone is not independent factual evidence.

Transferred content uses the private source pipeline. Host-supplied excerpts arrive as evidence candidates; the author approves or excludes each one in preview, and only approved excerpts enter `revision_evidence` and the published reader corpus. A brief with no approved evidence publishes with an explicit "no supporting evidence attached" state. See [LLM_INTEGRATION.md](LLM_INTEGRATION.md#evidence-approval). Attachment-transfer failures and missing support remain visible in the preview. A changed draft invalidates earlier publication previews.

## Source pipeline

1. Validate format, size, and access; store the original privately.
2. Extract text using bounded workers and preserve page, slide, or message locators.
3. Record extraction state and gaps for author review.
4. Store immutable source chunks and provenance.
5. Use explicitly selected sources for composition, and offer excerpts as evidence candidates for author approval.
6. At publication, copy approved excerpts and safe attribution into revision evidence.
7. Build reader retrieval projections from the published document and approved evidence only.

Steps 1–4 for uploaded files arrive in Phase 3. Phase 2 handles host-transferred text and candidate excerpts through the same private-source and approval rules. The initial import scope is pasted text/Markdown and text extraction from PDF, DOCX, and PPTX. OCR, complex chart reconstruction, and private conversation-link connectors are deferred.

Imported documents are untrusted input. Processing requires file limits, safe rendering, and appropriate parser isolation. Instructions embedded in sources cannot change permissions or invoke application tools.

## Composition contract

Composition receives the selected source set, document context, intended audience, and desired outcome. It returns a schema-valid proposal with source references and explicit gaps where support is missing.

The author inspects and applies the proposal. Applying an AI edit uses the same draft concurrency checks as manual editing. A result generated against an outdated draft cannot silently overwrite newer work.

Author-written perspectives, supplied in the handoff or edited manually, are part of Phase 2. AI-suggested perspectives follow in Phase 3; they are proposals that the author reviews and adopts before they are stored with the document. Either kind changes emphasis and implications only, never access (D06). The reader does not receive dynamically invented author positions on each visit.

## Reader Q&A pipeline

```mermaid
flowchart LR
    Q[Reader question] --> A[Authorize and resolve revision]
    A --> E[Retrieve approved content and evidence]
    E --> G[Generate answer with evidence references]
    G --> V[Validate references and answer support]
    V --> O[Present answer and inspectable citations]
```

Every retrieval operation is scoped to the authorized organization, briefing, revision, and evidence set before content is supplied to the model. Private source chunks are an authoring resource and are not part of the reader corpus.

Start with full-text retrieval (T20). Add vector retrieval only when an embedding provider is configured, and measure the combination before relying on it. Optimize ranking and indexing from representative evaluations, without weakening authorization predicates. Derived indexes must be invalidated or made unavailable when access or publication state changes.

## Answer behavior

- Identify the revision and selected perspective used for the answer.
- Link claims to approved evidence or published blocks.
- Distinguish what the briefing states from inferred implications.
- State when the material is insufficient or contradictory.
- Offer explicit submission of unresolved questions to the author.
- Do not fabricate evidence IDs, source quotations, or missing numerical values.
- Never substitute an older revision when the requested revision is still indexing.

Reference validation must confirm that cited IDs exist, belong to the authorized revision, and resolve to accessible content. Support evaluation must additionally check that the cited material actually supports the associated claim. Valid IDs alone do not establish factual grounding.

Streaming behavior must distinguish provisional output from a validated completed answer. Failed or interrupted answers retain an honest status and a recoverable retry path.

## Provider policy and observability

Record task, provider, model, prompt version, latency, usage, error category, and relevant resource IDs for each AI run. Do not log full sensitive prompts or source text by default.

Provider routing and fallback must obey organization policy, including permitted vendors and processing regions where applicable. An outage does not authorize sending confidential data to an unapproved provider.

Apply task-specific timeouts, bounded context, rate limits, usage budgets, and retries. Changes to an embedding model require explicit projection versioning and reindexing because vector spaces are not interchangeable.

## Reader privacy and topic analysis

Per D07, Q&A is private to the asker, with disclosed aggregate topic analysis. Authors receive explicitly submitted attributed feedback separately.

Privileged analysis jobs may process permitted transcripts for topic aggregation, but author-facing summaries must not expose raw private transcripts, identifying excerpts, or revealing small-cohort information. A topic is suppressed unless it draws on at least 3 distinct readers, a provisional implementation setting. The threshold, retention, and disclosure text require review before pilot use.

## Evaluation set

Use representative executive briefings and intentionally difficult questions to evaluate:

- Directly supported answers and multi-source synthesis.
- Citation resolution and whether evidence supports the claim.
- Missing or conflicting evidence and appropriate abstention.
- Questions that request another tenant's content or private source material.
- Prompt injection inside uploaded sources and questions.
- Revision mismatch, removed evidence, expired access, and provider failure.
- Unsupported numerical precision and invented implications.

Quality targets are set before pilot launch. Provider changes require rerunning the relevant evaluations.
