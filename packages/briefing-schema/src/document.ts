import { z } from "zod";

/**
 * Canonical briefing document, schema version 1.
 *
 * The same shape is stored in drafts (`briefing_drafts.document_json`) and in
 * sealed revisions (`briefing_revisions.document_json`). Draft-only fields are
 * removed by `toPublishedDocument` before a revision is created; readers never
 * receive them.
 */
export const SCHEMA_VERSION = 1 as const;

const id = (prefix: string) =>
  z
    .string()
    .regex(new RegExp(`^${prefix}_[A-Za-z0-9_-]{4,64}$`), `expected a ${prefix}_ identifier`);

export const BlockId = id("blk");
export const SectionId = id("sec");
export const EvidenceId = id("ev");
export const PerspectiveId = id("psp");
export const ItemId = id("itm");

/**
 * Plain text with paragraphs separated by blank lines. Inline marks are limited
 * to **bold**, _italic_ and [label](https://url). Renderers must escape all
 * other content; no HTML, scripts or arbitrary embeds are permitted.
 */
export const RichText = z.string().max(20_000);
const Short = z.string().min(1).max(500);
const IsoDate = z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, "expected YYYY-MM or YYYY-MM-DD");

/** A claim's link to approved (or, in drafts, candidate) evidence. */
export const EvidenceRef = z.object({
  evidenceId: EvidenceId,
  /** Optional note on what the evidence supports, written by the author. */
  note: z.string().max(500).optional(),
});

const blockBase = {
  id: BlockId,
  evidenceRefs: z.array(EvidenceRef).max(20).default([]),
};

export const NarrativeBlock = z.object({
  ...blockBase,
  type: z.literal("narrative"),
  role: z.enum(["context", "rationale", "alternative", "general"]).default("general"),
  text: RichText.min(1),
});

export const KeyFindingBlock = z.object({
  ...blockBase,
  type: z.literal("key_finding"),
  statement: Short,
  detail: RichText.optional(),
});

export const MetricBlock = z.object({
  ...blockBase,
  type: z.literal("metric"),
  label: Short,
  value: z.number().finite(),
  unit: z.string().max(40),
  asOf: IsoDate.optional(),
  comparison: z.object({ label: Short, value: z.number().finite() }).optional(),
  context: z.string().max(1000).optional(),
});

export const ComparisonBlock = z.object({
  ...blockBase,
  type: z.literal("comparison"),
  title: z.string().max(200).optional(),
  columns: z.array(z.string().min(1).max(120)).min(1).max(8),
  rows: z
    .array(z.object({ label: Short, cells: z.array(z.string().max(1000)) }))
    .min(1)
    .max(30),
});

export const ChartBlock = z.object({
  ...blockBase,
  type: z.literal("chart"),
  title: Short,
  kind: z.enum(["bar", "line"]),
  unit: z.string().max(40).optional(),
  series: z
    .array(
      z.object({
        label: Short,
        points: z.array(z.object({ x: z.string().min(1).max(80), y: z.number().finite() })).min(1).max(100),
      }),
    )
    .min(1)
    .max(8),
  /** Required text alternative (WCAG). Renderers also derive a data table. */
  altText: z.string().min(1).max(2000),
  caption: z.string().max(500).optional(),
});

export const TimelineBlock = z.object({
  ...blockBase,
  type: z.literal("timeline"),
  title: z.string().max(200).optional(),
  items: z
    .array(z.object({ id: ItemId, label: Short, date: IsoDate.optional(), detail: z.string().max(1000).optional() }))
    .min(1)
    .max(30),
});

export const DecisionBlock = z.object({
  ...blockBase,
  type: z.literal("decision"),
  statement: Short,
  options: z
    .array(z.object({ id: ItemId, label: Short, description: z.string().max(1000).optional(), chosen: z.boolean().default(false) }))
    .max(8)
    .default([]),
  rationale: RichText.optional(),
});

export const RiskBlock = z.object({
  ...blockBase,
  type: z.literal("risk"),
  kind: z.enum(["risk", "assumption", "uncertainty", "tradeoff"]),
  statement: Short,
  likelihood: z.enum(["low", "medium", "high"]).optional(),
  impact: z.enum(["low", "medium", "high"]).optional(),
  mitigation: z.string().max(1000).optional(),
});

export const ActionBlock = z.object({
  ...blockBase,
  type: z.literal("action"),
  statement: Short,
  owner: z.string().max(120).optional(),
  dueDate: IsoDate.optional(),
});

export const Block = z.discriminatedUnion("type", [
  NarrativeBlock,
  KeyFindingBlock,
  MetricBlock,
  ComparisonBlock,
  ChartBlock,
  TimelineBlock,
  DecisionBlock,
  RiskBlock,
  ActionBlock,
]);
export const BLOCK_TYPES = [
  "narrative",
  "key_finding",
  "metric",
  "comparison",
  "chart",
  "timeline",
  "decision",
  "risk",
  "action",
] as const;

export const Section = z.object({
  id: SectionId,
  title: Short,
  blocks: z.array(Block).max(60),
});

export const Perspective = z.object({
  id: PerspectiveId,
  label: z.string().min(1).max(60),
  /** Who this perspective is written for, e.g. "Finance leadership". */
  audience: z.string().max(200).optional(),
  summary: z.string().max(2000),
  /** Sections to emphasise, in reading order. Never hides content. */
  emphasis: z.array(SectionId).max(30).default([]),
  implications: z
    .array(z.object({ id: ItemId, text: z.string().min(1).max(1000), blockIds: z.array(BlockId).max(10).default([]) }))
    .max(20)
    .default([]),
});

/**
 * Evidence item. In a draft, `status` tracks author approval and `sourceRef`
 * points at private authoring material. Published documents contain only
 * approved items with draft-only fields stripped.
 */
export const EvidenceItem = z.object({
  id: EvidenceId,
  title: Short,
  excerpt: z.string().min(1).max(5000),
  /** Safe, reader-visible attribution, e.g. "Q3 customer cohort analysis, p. 8". */
  attribution: z.string().max(300).optional(),
  locator: z.string().max(200).optional(),
  /** Host-provided origin label; attribution metadata, not verification. */
  origin: z.enum(["llm_handoff", "upload", "manual"]).default("manual"),
  // Draft-only fields:
  status: z.enum(["candidate", "approved", "excluded"]).default("candidate").optional(),
  sourceRef: z
    .object({ sourceId: z.string().uuid(), chunkId: z.string().uuid().optional() })
    .optional(),
});

export const BriefingDocument = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  title: z.string().min(1).max(200),
  kind: z.enum(["strategy", "decision", "plan", "update"]).default("strategy"),
  /** The executive position, shown first. */
  position: z.object({ headline: Short, summary: RichText.min(1) }),
  /** Why it matters now. */
  context: z.object({ stakes: RichText.min(1), background: RichText.optional() }),
  /** What the reader is asked to do. */
  request: z.object({
    type: z.enum(["decision", "approval", "input", "awareness"]),
    statement: Short,
    detail: RichText.optional(),
    dueDate: IsoDate.optional(),
  }),
  sections: z.array(Section).max(30),
  perspectives: z.array(Perspective).max(8).default([]),
  evidence: z.array(EvidenceItem).max(200).default([]),
  /** Authored open questions the author chooses to communicate. */
  openQuestions: z.array(z.object({ id: ItemId, text: z.string().min(1).max(1000) })).max(30).default([]),
});

/**
 * Reader-facing evidence item: an approved excerpt with draft-only fields
 * (`status`, `sourceRef`) removed. Unknown keys are stripped on parse, so
 * parsing a published document with this schema never reintroduces them.
 */
export const PublishedEvidenceItem = EvidenceItem.omit({ status: true, sourceRef: true });

/**
 * Shape of a sealed revision document (output of `toPublishedDocument`). Use
 * this, not `BriefingDocument`, to parse revision JSON: `BriefingDocument`
 * defaults a missing evidence `status` to "candidate".
 */
export const PublishedBriefingDocument = BriefingDocument.extend({
  evidence: z.array(PublishedEvidenceItem).max(200).default([]),
});

export type BriefingDocument = z.infer<typeof BriefingDocument>;
export type PublishedBriefingDocument = z.infer<typeof PublishedBriefingDocument>;
export type PublishedEvidenceItem = z.infer<typeof PublishedEvidenceItem>;
export type EvidenceStatus = NonNullable<EvidenceItem["status"]>;
export type BriefingDocumentInput = z.input<typeof BriefingDocument>;
export type Block = z.infer<typeof Block>;
export type BlockType = Block["type"];
export type Section = z.infer<typeof Section>;
export type Perspective = z.infer<typeof Perspective>;
export type EvidenceItem = z.infer<typeof EvidenceItem>;
export type EvidenceRef = z.infer<typeof EvidenceRef>;
