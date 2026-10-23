import { z } from "zod";
import {
  BlockId,
  Block,
  BriefingDocument,
  EvidenceId,
  Perspective,
  PerspectiveId,
  SectionId,
} from "@cerebro/briefing-schema";

/**
 * Task contracts. Every task has an input schema, an output schema and a prompt
 * version. Provider-specific APIs and model identifiers stay behind
 * {@link AiProvider}; domain code only depends on these contracts.
 *
 * Inputs are assumed to be already authorised and scoped by the domain layer.
 * This package performs no data access.
 */

export const TASK_NAMES = ["compose", "propose_revision", "answer", "summarize_topics"] as const;
export type AiTaskName = (typeof TASK_NAMES)[number];

export interface AiTask<
  N extends AiTaskName = AiTaskName,
  I extends z.ZodType = z.ZodType,
  O extends z.ZodType = z.ZodType,
> {
  readonly name: N;
  /** Bumped whenever prompt templates or deterministic behaviour change. */
  readonly promptVersion: string;
  readonly input: I;
  readonly output: O;
}

export type TaskInput<T extends AiTask> = z.input<T["input"]>;
export type TaskOutput<T extends AiTask> = z.infer<T["output"]>;

function defineTask<N extends AiTaskName, I extends z.ZodType, O extends z.ZodType>(task: AiTask<N, I, O>) {
  return Object.freeze(task);
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

export const Gap = z.object({
  kind: z.enum([
    "missing_position",
    "missing_stakes",
    "missing_request",
    "unsupported_claim",
    "missing_evidence",
    "empty_perspective",
    "unverified_attribution",
    "other",
  ]),
  message: z.string().min(1).max(1000),
  /** Dotted document path, e.g. "position.headline" or "sections.0.blocks.2". */
  path: z.string().max(200).optional(),
  blockId: BlockId.optional(),
});
export type Gap = z.infer<typeof Gap>;

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------

export const ComposeSource = z.object({
  /** Domain identifier of the selected source (UUID or handoff-local id). */
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(500),
  text: z.string().min(1).max(200_000),
  /** Reader-safe attribution, if the author or host supplied one. */
  attribution: z.string().max(300).optional(),
  origin: z.enum(["llm_handoff", "upload", "manual"]).default("manual"),
});
export type ComposeSource = z.infer<typeof ComposeSource>;

export const ComposeInput = z.object({
  /** Explicitly selected sources only. */
  sources: z.array(ComposeSource).max(50).default([]),
  /** A versioned handoff package from the connected LLM (briefing-schema `HandoffPackage`). */
  handoff: z.unknown().optional(),
  /** Selected thinking from the connected LLM, as Markdown or plain text. */
  handoffText: z.string().max(200_000).optional(),
  /** A structured draft the host already validated; preserved, not rewritten. */
  structuredDraft: z.unknown().optional(),
  audience: z.string().max(200).optional(),
  desiredOutcome: z.string().max(1000).optional(),
  /** The current draft when composing into an existing briefing. */
  existingDocument: BriefingDocument.optional(),
});
export type ComposeInput = z.infer<typeof ComposeInput>;

export const SourceRef = z.object({
  sourceId: z.string().min(1).max(100),
  /** Where in the proposal the source was used. */
  target: z.enum(["evidence", "block", "position", "context", "request"]),
  evidenceId: EvidenceId.optional(),
  blockId: BlockId.optional(),
  locator: z.string().max(200).optional(),
});
export type SourceRef = z.infer<typeof SourceRef>;

export const ComposeOutput = z.object({
  /** A proposal. The author reviews and applies it; nothing here is published. */
  document: BriefingDocument,
  gaps: z.array(Gap).max(200),
  sourceRefs: z.array(SourceRef).max(500),
  /** Short explanation of what was done, shown to the author. */
  notes: z.string().max(2000).optional(),
});
export type ComposeOutput = z.infer<typeof ComposeOutput>;

export const ComposeTask = defineTask({
  name: "compose",
  promptVersion: "compose.v1",
  input: ComposeInput,
  output: ComposeOutput,
});

// ---------------------------------------------------------------------------
// Propose revision
// ---------------------------------------------------------------------------

export const FeedbackItem = z.object({
  id: z.string().min(1).max(100),
  text: z.string().min(1).max(5000),
  blockId: BlockId.optional(),
});
export type FeedbackItem = z.infer<typeof FeedbackItem>;

export const RevisionOperation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_perspective"), perspective: Perspective }),
  z.object({ op: z.literal("update_perspective"), perspective: Perspective }),
  z.object({ op: z.literal("add_block"), sectionId: SectionId, afterBlockId: BlockId.optional(), block: Block }),
  z.object({ op: z.literal("replace_block"), block: Block }),
  z.object({ op: z.literal("remove_block"), blockId: BlockId }),
  z.object({
    op: z.literal("set_text"),
    path: z.enum([
      "title",
      "position.headline",
      "position.summary",
      "context.stakes",
      "context.background",
      "request.statement",
      "request.detail",
    ]),
    value: z.string().min(1).max(20_000),
  }),
]);
export type RevisionOperation = z.infer<typeof RevisionOperation>;

export const ProposeRevisionInput = z.object({
  document: BriefingDocument,
  /** Draft lock version the proposal is based on; echoed so apply can reject stale proposals. */
  baseVersion: z.number().int().nonnegative().optional(),
  instruction: z.string().min(1).max(5000),
  feedback: z.array(FeedbackItem).max(100).default([]),
});
export type ProposeRevisionInput = z.infer<typeof ProposeRevisionInput>;

export const ProposeRevisionOutput = z.object({
  status: z.enum(["proposed", "no_change", "unsupported"]),
  /** What the proposal touches, in plain language. */
  scope: z.string().min(1).max(1000),
  explanation: z.string().max(2000).optional(),
  operations: z.array(RevisionOperation).max(100).optional(),
  replacementDocument: BriefingDocument.optional(),
  gaps: z.array(Gap).max(200).default([]),
  /** Echo of the input baseVersion. Apply with the normal draft concurrency check. */
  baseVersion: z.number().int().nonnegative().optional(),
});
export type ProposeRevisionOutput = z.infer<typeof ProposeRevisionOutput>;

export const ProposeRevisionTask = defineTask({
  name: "propose_revision",
  promptVersion: "propose_revision.v1",
  input: ProposeRevisionInput,
  output: ProposeRevisionOutput,
});

// ---------------------------------------------------------------------------
// Answer
// ---------------------------------------------------------------------------

/**
 * A unit of reader-retrievable content: a published block or an approved
 * evidence excerpt from one revision. Never a private source chunk.
 */
export const RetrievedPassage = z
  .object({
    id: z.string().min(1).max(200),
    kind: z.enum(["block", "evidence"]),
    blockId: BlockId.optional(),
    evidenceId: EvidenceId.optional(),
    revisionId: z.string().min(1).max(100),
    text: z.string().min(1).max(20_000),
    title: z.string().max(500),
  })
  .refine((p) => p.kind !== "evidence" || p.evidenceId !== undefined, {
    message: "evidence passages require evidenceId",
    path: ["evidenceId"],
  });
export type RetrievedPassage = z.infer<typeof RetrievedPassage>;

export const AnswerInput = z.object({
  question: z.string().min(1).max(2000),
  /** The authorised revision. Passages from any other revision are discarded. */
  revisionId: z.string().min(1).max(100),
  focusBlockId: BlockId.optional(),
  perspective: z.object({ id: PerspectiveId, label: z.string().min(1).max(60) }).optional(),
  passages: z.array(RetrievedPassage).max(100),
});
export type AnswerInput = z.infer<typeof AnswerInput>;

export const AnswerPart = z.object({
  text: z.string().min(1).max(4000),
  /** "stated": the briefing says this. "inferred": an implication drawn from it. */
  kind: z.enum(["stated", "inferred"]),
  citations: z.array(z.string().min(1).max(200)).max(20),
});
export type AnswerPart = z.infer<typeof AnswerPart>;

export const ANSWER_STATUSES = ["answered", "insufficient", "refused"] as const;
export type AnswerStatus = (typeof ANSWER_STATUSES)[number];

export const AnswerOutput = z.object({
  status: z.enum(ANSWER_STATUSES),
  answer: z.array(AnswerPart).max(20),
  citations: z.array(z.object({ passageId: z.string().min(1).max(200) })).max(50),
  /** What the material does not cover, when status is not "answered". */
  missing: z.string().max(1000).optional(),
});
export type AnswerOutput = z.infer<typeof AnswerOutput>;

export const AnswerTask = defineTask({
  name: "answer",
  promptVersion: "answer.v1",
  input: AnswerInput,
  output: AnswerOutput,
});

// ---------------------------------------------------------------------------
// Summarize topics
// ---------------------------------------------------------------------------

export const TopicQuestion = z.object({
  id: z.string().min(1).max(100),
  text: z.string().min(1).max(2000),
  /** One-way hash of the reader id; used only for distinct counts. */
  readerHash: z.string().min(1).max(200),
});

export const SummarizeTopicsInput = z.object({
  /** Already permission-filtered by the domain layer. */
  questions: z.array(TopicQuestion).max(5000),
  maxTopics: z.number().int().min(1).max(50).default(10),
  /**
   * Topics with fewer distinct readers are suppressed. The domain layer owns
   * the policy value (pending review); the task applies whatever it is given.
   */
  minDistinctReaders: z.number().int().min(1).default(1),
});
export type SummarizeTopicsInput = z.infer<typeof SummarizeTopicsInput>;

export const Topic = z.object({
  label: z.string().min(1).max(120),
  count: z.number().int().nonnegative(),
  distinctReaders: z.number().int().nonnegative(),
  exampleQuestionIds: z.array(z.string().min(1).max(100)).max(5),
  /**
   * Every input question id assigned to this topic. Optional for providers
   * that cannot return it; the domain layer recomputes distinct readers from
   * these ids (or, if absent, from the examples) and never trusts
   * `distinctReaders` or `count` as given.
   */
  questionIds: z.array(z.string().min(1).max(100)).max(5000).optional(),
});
export type Topic = z.infer<typeof Topic>;

export const SummarizeTopicsOutput = z.object({
  topics: z.array(Topic).max(50),
  /** Number of questions in topics suppressed for small cohorts. */
  suppressedQuestions: z.number().int().nonnegative().default(0),
});
export type SummarizeTopicsOutput = z.infer<typeof SummarizeTopicsOutput>;

export const SummarizeTopicsTask = defineTask({
  name: "summarize_topics",
  promptVersion: "summarize_topics.v2",
  input: SummarizeTopicsInput,
  output: SummarizeTopicsOutput,
});

export const TASKS = {
  compose: ComposeTask,
  propose_revision: ProposeRevisionTask,
  answer: AnswerTask,
  summarize_topics: SummarizeTopicsTask,
} as const;

export type AnyAiTask = (typeof TASKS)[AiTaskName];
