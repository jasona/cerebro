import { z } from "zod";
import { BriefingDocument, SCHEMA_VERSION, type BriefingDocumentInput } from "./document";
import { GAP_PLACEHOLDERS } from "./gaps";
import { NO_EVIDENCE_GAP, addGap, createContext, type ComposeContext, type ComposeOptions } from "./compose-util";
import { markdownToDocument, type ComposedDocument } from "./markdown";
import { collectIssues, zodIssuesToDocumentIssues, type DocumentIssue } from "./validate";

/**
 * Versioned structured handoff from an executive's connected LLM host
 * (LLM_INTEGRATION.md, "Structured handoff"). Version 1.
 *
 * Trust rules carried by this contract:
 * - Only content the author selected is transferred; Cerebro never assumes the
 *   full conversation, hidden reasoning, or attachments.
 * - Evidence excerpts are *candidates*; none is approved on arrival.
 * - `sourceUrl`, `origin` and attribution are host-provided metadata, not
 *   verification. Cerebro never fetches a conversation URL.
 * - `destination` and `audience` are proposals; the domain layer resolves them
 *   to authorized ids (or asks) before any mutation.
 * - Owners and dates are included only where actually supplied.
 */
export const HANDOFF_VERSION = 1 as const;

const Text = (max: number) => z.string().trim().min(1).max(max);
const IsoDate = z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, "expected YYYY-MM or YYYY-MM-DD");
const Uuid = z.string().uuid();

/** Section keys the composer produces; perspectives and evidence may target them. */
export const HANDOFF_SECTION_KEYS = ["recommendation", "why_now", "rationale", "risks", "next_steps"] as const;
export type HandoffSectionKey = (typeof HANDOFF_SECTION_KEYS)[number];

export const HANDOFF_SECTION_TITLES: Record<HandoffSectionKey, string> = {
  recommendation: "The recommendation",
  why_now: "Why now",
  rationale: "Rationale & alternatives",
  risks: "Risks & assumptions",
  next_steps: "Next steps",
};

export const HandoffEvidence = z.object({
  title: Text(500),
  /** Verbatim excerpt the host is permitted to transfer. */
  excerpt: Text(5000),
  /** Reader-safe attribution, e.g. "Customer cohort analysis, Q3 2026". */
  attribution: Text(300).optional(),
  /** Where in the source, e.g. "p. 8" or "slide 4". */
  locator: Text(200).optional(),
  /** Host-supplied link. Attribution only: never fetched, never treated as verification. */
  sourceUrl: z.string().url().max(2000).optional(),
  /** Which composed section's lead claim this excerpt supports, if the host knows. */
  supports: z.array(z.enum(["recommendation", "why_now", "rationale"])).max(3).optional(),
});

export const HandoffPerspective = z.object({
  label: Text(60),
  audience: Text(200).optional(),
  summary: Text(2000),
  /** Section keys (see HANDOFF_SECTION_KEYS), section titles, or — with `document` — section ids. */
  emphasis: z.array(Text(200)).max(30).optional(),
  implications: z.array(Text(1000)).max(20).default([]),
});

export const HandoffPackage = z.object({
  handoffVersion: z.literal(HANDOFF_VERSION),
  title: Text(200).optional(),
  kind: z.enum(["strategy", "decision", "plan", "update"]).optional(),
  /**
   * Free text / Markdown the author selected. Stored as a private authoring
   * source. Used for composition only when no structured fields are supplied.
   */
  selectedContent: z.string().max(200_000).optional(),
  position: z.object({ headline: Text(500).optional(), summary: Text(20_000).optional() }).optional(),
  context: z.object({ stakes: Text(20_000).optional(), background: Text(20_000).optional() }).optional(),
  request: z
    .object({
      type: z.enum(["decision", "approval", "input", "awareness"]),
      statement: Text(500),
      detail: Text(20_000).optional(),
      dueDate: IsoDate.optional(),
    })
    .optional(),
  rationale: Text(20_000).optional(),
  alternatives: z
    .array(
      z.object({
        label: Text(500),
        description: Text(1000).optional(),
        pros: Text(1000).optional(),
        cons: Text(1000).optional(),
        /** True for the recommended option, when the author said so. */
        chosen: z.boolean().optional(),
      }),
    )
    .max(8)
    .default([]),
  assumptions: z.array(Text(500)).max(15).default([]),
  risks: z
    .array(
      z.object({
        statement: Text(500),
        likelihood: z.enum(["low", "medium", "high"]).optional(),
        impact: z.enum(["low", "medium", "high"]).optional(),
        mitigation: Text(1000).optional(),
      }),
    )
    .max(20)
    .default([]),
  uncertainties: z.array(Text(500)).max(15).default([]),
  tradeoffs: z.array(Text(500)).max(10).default([]),
  openQuestions: z.array(Text(1000)).max(30).default([]),
  actions: z
    .array(z.object({ statement: Text(500), owner: Text(120).optional(), dueDate: IsoDate.optional() }))
    .max(60)
    .default([]),
  perspectives: z.array(HandoffPerspective).max(8).default([]),
  evidence: z.array(HandoffEvidence).max(200).default([]),
  /** Proposed organizational home, e.g. "Platform team". Resolved server-side. */
  destination: z
    .object({ label: Text(200).optional(), departmentId: Uuid.optional(), teamId: Uuid.optional() })
    .optional(),
  /** Proposed audience. Always shown to the author before release. */
  audience: z
    .object({
      visibility: z.enum(["company", "department", "team", "restricted"]),
      departmentId: Uuid.optional(),
      teamId: Uuid.optional(),
      userIds: z.array(Uuid).max(200).optional(),
      emails: z.array(z.string().email().max(320)).max(200).optional(),
    })
    .optional(),
  /** A fully structured document, if the host already has one. Used without rewrite. */
  document: BriefingDocument.optional(),
  origin: z.object({ host: Text(100).optional(), conversationLabel: Text(200).optional() }).optional(),
  /** Present for updates to an existing briefing. */
  target: z.object({ briefingId: Uuid, expectedDraftVersion: z.number().int().min(0) }).optional(),
});

export type HandoffPackage = z.infer<typeof HandoffPackage>;
export type HandoffPackageInput = z.input<typeof HandoffPackage>;

export type HandoffParseResult = { ok: true; handoff: HandoffPackage } | { ok: false; issues: DocumentIssue[] };

/** Structural validation of an untrusted handoff, with JSON-path issues. */
export function parseHandoff(input: unknown): HandoffParseResult {
  const result = HandoffPackage.safeParse(input);
  if (result.success) return { ok: true, handoff: result.data };
  return { ok: false, issues: zodIssuesToDocumentIssues(result.error, input) };
}

function hasStructuredContent(pkg: HandoffPackage): boolean {
  return Boolean(
    pkg.position?.headline ||
      pkg.position?.summary ||
      pkg.context?.stakes ||
      pkg.context?.background ||
      pkg.request ||
      pkg.rationale ||
      pkg.alternatives.length ||
      pkg.assumptions.length ||
      pkg.risks.length ||
      pkg.uncertainties.length ||
      pkg.tradeoffs.length ||
      pkg.actions.length,
  );
}

type BlockInput = BriefingDocumentInput["sections"][number]["blocks"][number];
type EvidenceInput = NonNullable<BriefingDocumentInput["evidence"]>[number];

/**
 * Deterministic, structure-preserving composer: handoff → draft document.
 *
 * - With `pkg.document`: uses it as-is (no rewrite of content). Evidence is
 *   normalized to the handoff trust rules — every item becomes a `candidate`
 *   with origin `llm_handoff`, and host-supplied `sourceRef`s are dropped.
 * - Otherwise maps fields to sections: The recommendation, Why now, Rationale
 *   & alternatives, Risks & assumptions, Next steps; plus perspectives,
 *   candidate evidence and open questions. Sections with nothing supplied are
 *   omitted rather than padded.
 * - With only `selectedContent`, composes it via `markdownToDocument`.
 *
 * Never invents numbers, evidence, owners or dates. Missing required fields
 * get `GAP_PLACEHOLDERS` text and every gap is listed in `gaps`.
 *
 * Throws a ZodError if `pkg` is not a valid HandoffPackage; call
 * `parseHandoff` first to get structured issues.
 */
export function handoffToDocument(input: HandoffPackageInput, opts: ComposeOptions = {}): ComposedDocument {
  const pkg = HandoffPackage.parse(input);
  if (pkg.document) return fromSuppliedDocument(pkg, pkg.document);

  const ctx = createContext(opts);

  if (!hasStructuredContent(pkg) && pkg.selectedContent?.trim()) {
    const mdOpts: Parameters<typeof markdownToDocument>[1] = { ids: ctx.ids };
    if (pkg.title) mdOpts.title = pkg.title;
    const composed = markdownToDocument(pkg.selectedContent, mdOpts);
    ctx.gaps.push("No structured fields were supplied; the brief was composed from the selected content as Markdown.");
    ctx.gaps.push(...composed.gaps.filter((g) => !(pkg.evidence.length && g === NO_EVIDENCE_GAP)));
    const doc = composed.document;
    const evidence = buildEvidence(ctx, pkg);
    const perspectives = buildPerspectives(ctx, pkg, new Map(doc.sections.map((s) => [s.title.toLowerCase(), s.id])));
    const openQuestions = pkg.openQuestions.map((text) => ({ id: ctx.ids("itm"), text }));
    const merged = BriefingDocument.parse({
      ...doc,
      ...(pkg.kind ? { kind: pkg.kind } : {}),
      evidence: evidence.items,
      perspectives,
      openQuestions,
    });
    for (const key of evidence.unresolvedSupports) {
      addGap(ctx, `Evidence was marked as supporting "${key}", but that section is not part of a Markdown-composed brief; link it manually.`);
    }
    return { document: merged, gaps: ctx.gaps };
  }

  // ── top-level fields ─────────────────────────────────────────────────────
  let title = pkg.title;
  if (!title && pkg.position?.headline && pkg.position.headline.length <= 200) title = pkg.position.headline;
  if (!title) {
    title = GAP_PLACEHOLDERS.title;
    addGap(ctx, "No title was supplied.");
  }
  const headline = pkg.position?.headline ?? (pkg.title && pkg.title.length <= 500 ? pkg.title : undefined);
  if (!pkg.position?.headline) {
    addGap(ctx, headline ? "No position headline was supplied; the title is used as the headline." : "No position headline was supplied.");
  }
  const summary = pkg.position?.summary;
  if (!summary) addGap(ctx, "No position summary was supplied.");
  const stakes = pkg.context?.stakes;
  if (!stakes) addGap(ctx, "Why this matters now (stakes) was not supplied.");
  if (!pkg.request) addGap(ctx, "No request was supplied (what readers are asked to decide, approve or provide); it defaults to awareness.");
  if (!pkg.rationale) addGap(ctx, "No rationale was supplied.");
  if (pkg.request?.type === "decision" && pkg.alternatives.length === 0) {
    addGap(ctx, "A decision is requested but no alternatives considered were supplied.");
  }

  // ── sections ─────────────────────────────────────────────────────────────
  const sections: BriefingDocumentInput["sections"] = [];
  const sectionIdByKey = new Map<string, string>();
  const leadBlockByKey = new Map<HandoffSectionKey, BlockInput>();
  const pushSection = (key: HandoffSectionKey, blocks: BlockInput[]) => {
    if (!blocks.length) return;
    const id = ctx.ids("sec");
    sections.push({ id, title: HANDOFF_SECTION_TITLES[key], blocks });
    sectionIdByKey.set(key, id);
    sectionIdByKey.set(HANDOFF_SECTION_TITLES[key].toLowerCase(), id);
    leadBlockByKey.set(key, blocks[0]!);
  };

  {
    const blocks: BlockInput[] = [];
    if (pkg.request && (pkg.request.type === "decision" || pkg.request.type === "approval")) {
      blocks.push({
        id: ctx.ids("blk"),
        type: "decision",
        statement: pkg.request.statement,
        options: pkg.alternatives.map((alt) => ({
          id: ctx.ids("itm"),
          label: alt.label,
          ...(alt.description ? { description: alt.description } : {}),
          chosen: alt.chosen ?? false,
        })),
      });
    }
    if (pkg.request?.detail) blocks.push({ id: ctx.ids("blk"), type: "narrative", role: "general", text: pkg.request.detail });
    pushSection("recommendation", blocks);
  }
  {
    const blocks: BlockInput[] = [];
    if (stakes) blocks.push({ id: ctx.ids("blk"), type: "narrative", role: "context", text: stakes });
    if (pkg.context?.background) {
      blocks.push({ id: ctx.ids("blk"), type: "narrative", role: "context", text: pkg.context.background });
    }
    pushSection("why_now", blocks);
  }
  {
    const blocks: BlockInput[] = [];
    if (pkg.rationale) blocks.push({ id: ctx.ids("blk"), type: "narrative", role: "rationale", text: pkg.rationale });
    if (pkg.alternatives.length) {
      type Alt = HandoffPackage["alternatives"][number];
      const allColumns: { name: string; get: (a: Alt) => string | undefined }[] = [
        { name: "Description", get: (a) => a.description },
        { name: "Pros", get: (a) => a.pros },
        { name: "Cons", get: (a) => a.cons },
      ];
      const columns = allColumns.filter((c) => pkg.alternatives.some((a) => c.get(a)));
      if (columns.length) {
        blocks.push({
          id: ctx.ids("blk"),
          type: "comparison",
          title: "Alternatives considered",
          columns: columns.map((c) => c.name),
          rows: pkg.alternatives.map((a) => ({ label: a.label, cells: columns.map((c) => c.get(a) ?? "") })),
        });
      } else {
        blocks.push({
          id: ctx.ids("blk"),
          type: "narrative",
          role: "alternative",
          text: `Alternatives considered:\n${pkg.alternatives.map((a) => `- ${a.label}`).join("\n")}`,
        });
      }
    }
    pushSection("rationale", blocks);
  }
  {
    const blocks: BlockInput[] = [
      ...pkg.risks.map(
        (r): BlockInput => ({
          id: ctx.ids("blk"),
          type: "risk",
          kind: "risk",
          statement: r.statement,
          ...(r.likelihood ? { likelihood: r.likelihood } : {}),
          ...(r.impact ? { impact: r.impact } : {}),
          ...(r.mitigation ? { mitigation: r.mitigation } : {}),
        }),
      ),
      ...pkg.assumptions.map((s): BlockInput => ({ id: ctx.ids("blk"), type: "risk", kind: "assumption", statement: s })),
      ...pkg.uncertainties.map((s): BlockInput => ({ id: ctx.ids("blk"), type: "risk", kind: "uncertainty", statement: s })),
      ...pkg.tradeoffs.map((s): BlockInput => ({ id: ctx.ids("blk"), type: "risk", kind: "tradeoff", statement: s })),
    ];
    pushSection("risks", blocks);
  }
  {
    const blocks = pkg.actions.map(
      (a): BlockInput => ({
        id: ctx.ids("blk"),
        type: "action",
        statement: a.statement,
        ...(a.owner ? { owner: a.owner } : {}),
        ...(a.dueDate ? { dueDate: a.dueDate } : {}),
      }),
    );
    if (pkg.actions.length && pkg.actions.some((a) => !a.owner)) {
      addGap(ctx, "Some actions have no owner; owners were not inferred.");
    }
    pushSection("next_steps", blocks);
  }

  // ── evidence, perspectives, questions ────────────────────────────────────
  const evidence = buildEvidence(ctx, pkg);
  for (const [key, evidenceIds] of evidence.supportsByKey) {
    const lead = leadBlockByKey.get(key as HandoffSectionKey);
    if (!lead) {
      addGap(ctx, `Evidence was marked as supporting "${key}", but nothing was supplied for that section.`);
      continue;
    }
    lead.evidenceRefs = [...(lead.evidenceRefs ?? []), ...evidenceIds.map((evidenceId) => ({ evidenceId }))];
  }
  const perspectives = buildPerspectives(ctx, pkg, sectionIdByKey);
  const openQuestions = pkg.openQuestions.map((text) => ({ id: ctx.ids("itm"), text }));

  if (!sections.length) addGap(ctx, "No content was supplied for any section.");

  const doc: BriefingDocumentInput = {
    schemaVersion: SCHEMA_VERSION,
    title,
    ...(pkg.kind ? { kind: pkg.kind } : {}),
    position: { headline: headline ?? GAP_PLACEHOLDERS.headline, summary: summary ?? GAP_PLACEHOLDERS.summary },
    context: {
      stakes: stakes ?? GAP_PLACEHOLDERS.stakes,
      ...(pkg.context?.background ? { background: pkg.context.background } : {}),
    },
    request: pkg.request
      ? {
          type: pkg.request.type,
          statement: pkg.request.statement,
          ...(pkg.request.detail ? { detail: pkg.request.detail } : {}),
          ...(pkg.request.dueDate ? { dueDate: pkg.request.dueDate } : {}),
        }
      : { type: "awareness", statement: GAP_PLACEHOLDERS.request },
    sections,
    perspectives,
    evidence: evidence.items,
    openQuestions,
  };
  return { document: BriefingDocument.parse(doc), gaps: ctx.gaps };
}

function buildEvidence(ctx: ComposeContext, pkg: HandoffPackage) {
  const supportsByKey = new Map<string, string[]>();
  const items: EvidenceInput[] = pkg.evidence.map((ev) => {
    const id = ctx.ids("ev");
    const item: EvidenceInput = { id, title: ev.title, excerpt: ev.excerpt, origin: "llm_handoff", status: "candidate" };
    let attribution = ev.attribution;
    let locator = ev.locator;
    // sourceUrl is attribution metadata only: shown to the author for review, never fetched.
    if (ev.sourceUrl) {
      if (!locator && ev.sourceUrl.length <= 200) locator = ev.sourceUrl;
      else if (`${attribution ?? ""} · ${ev.sourceUrl}`.length <= 300) {
        attribution = attribution ? `${attribution} · ${ev.sourceUrl}` : ev.sourceUrl;
      }
    }
    if (attribution) item.attribution = attribution;
    else addGap(ctx, `Evidence "${ev.title}" has no attribution.`);
    if (locator) item.locator = locator;
    for (const key of ev.supports ?? []) {
      supportsByKey.set(key, [...(supportsByKey.get(key) ?? []), id]);
    }
    return item;
  });
  if (!items.length) addGap(ctx, NO_EVIDENCE_GAP);
  else addGap(ctx, `${items.length} evidence excerpt(s) arrived as candidates; each must be approved before it can publish.`);
  return { items, supportsByKey, unresolvedSupports: [...supportsByKey.keys()] };
}

function buildPerspectives(ctx: ComposeContext, pkg: HandoffPackage, sectionIds: Map<string, string>) {
  return pkg.perspectives.map((p) => {
    const emphasis: string[] = [];
    for (const ref of p.emphasis ?? []) {
      const id = sectionIds.get(ref) ?? sectionIds.get(ref.toLowerCase());
      if (id) {
        if (!emphasis.includes(id)) emphasis.push(id);
      } else {
        addGap(ctx, `The ${p.label} perspective emphasises "${ref}", which is not a section of this brief.`);
      }
    }
    if (!p.implications.length) addGap(ctx, `The ${p.label} perspective has no implications.`);
    return {
      id: ctx.ids("psp"),
      label: p.label,
      ...(p.audience ? { audience: p.audience } : {}),
      summary: p.summary,
      emphasis,
      implications: p.implications.map((text) => ({ id: ctx.ids("itm"), text, blockIds: [] })),
    };
  });
}

function fromSuppliedDocument(pkg: HandoffPackage, supplied: BriefingDocument): ComposedDocument {
  const gaps: string[] = [];
  let resetApproved = 0;
  const evidence = supplied.evidence.map((ev) => {
    if (ev.status === "approved") resetApproved++;
    const { sourceRef: _sourceRef, ...rest } = ev;
    return { ...rest, origin: "llm_handoff" as const, status: "candidate" as const };
  });
  const document = BriefingDocument.parse({ ...supplied, evidence });

  if (resetApproved) {
    gaps.push(`${resetApproved} evidence item(s) arrived marked approved and were reset to candidate; the author approves evidence in Cerebro.`);
  }
  if (!evidence.length) gaps.push(NO_EVIDENCE_GAP);
  else gaps.push(`${evidence.length} evidence excerpt(s) arrived as candidates; each must be approved before it can publish.`);
  const ignored = hasStructuredContent(pkg) || pkg.perspectives.length || pkg.evidence.length || pkg.openQuestions.length;
  if (ignored) gaps.push("A structured document was supplied; the other content fields in the handoff were ignored.");
  for (const issue of collectIssues(document, { mode: "draft" })) {
    if (issue.code === "no_approved_evidence" || issue.code === "evidence_ref_unapproved") continue;
    const line = issue.severity === "error" ? `Error at ${issue.path}: ${issue.message}` : issue.message;
    if (!gaps.includes(line)) gaps.push(line);
  }
  return { document, gaps };
}
