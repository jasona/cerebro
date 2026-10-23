import type { z } from "zod";
import { BriefingDocument, type Block, type EvidenceItem, type PublishedBriefingDocument } from "./document";
import { GAP_PLACEHOLDERS, isGapPlaceholder } from "./gaps";

export type IssueSeverity = "error" | "warning";

/**
 * Issue codes. `schema.*` codes come from Zod (structural); the rest are
 * semantic checks from `collectIssues`.
 *
 * Severity rule (LLM_INTEGRATION.md): **errors** are structural problems that
 * make the document invalid or unpublishable; **warnings** are content gaps
 * the author may knowingly publish with (missing evidence, missing decision
 * block, unresolved placeholders). Never fabricate content to clear either.
 */
export type IssueCode =
  | `schema.${string}`
  | "duplicate_id"
  | "perspective_emphasis_missing_section"
  | "implication_missing_block"
  | "evidence_ref_missing"
  | "evidence_ref_unapproved"
  | "empty_section"
  | "no_sections"
  | "decision_request_without_decision_block"
  | "chart_series_length_mismatch"
  | "comparison_cells_mismatch"
  | "no_approved_evidence"
  | "unresolved_gap";

export interface DocumentIssue {
  code: IssueCode;
  severity: IssueSeverity;
  /** JSON path into the document, e.g. `$.sections[0].blocks[2].evidenceRefs[0].evidenceId`. */
  path: string;
  message: string;
  /** Stable block id when the issue concerns (or is inside) a block. */
  blockId?: string;
}

export type ValidationMode = "draft" | "publish";

export type ParseResult =
  | { ok: true; document: BriefingDocument }
  | { ok: false; issues: DocumentIssue[] };

/** Formats a path as `$.a[0].b`. */
export function formatPath(segments: readonly PropertyKey[]): string {
  let out = "$";
  for (const seg of segments) {
    if (typeof seg === "number") out += `[${seg}]`;
    else if (typeof seg === "string" && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(seg)) out += `.${seg}`;
    else out += `[${JSON.stringify(String(seg))}]`;
  }
  return out;
}

function blockIdAt(input: unknown, path: readonly PropertyKey[]): string | undefined {
  if (path[0] !== "sections" || typeof path[1] !== "number" || path[2] !== "blocks" || typeof path[3] !== "number") {
    return undefined;
  }
  const sections = (input as { sections?: unknown } | null)?.sections;
  if (!Array.isArray(sections)) return undefined;
  const blocks = (sections[path[1]] as { blocks?: unknown } | undefined)?.blocks;
  if (!Array.isArray(blocks)) return undefined;
  const id = (blocks[path[3]] as { id?: unknown } | undefined)?.id;
  return typeof id === "string" ? id : undefined;
}

/** Converts Zod issues into `DocumentIssue`s (all errors). */
export function zodIssuesToDocumentIssues(error: z.ZodError, input?: unknown): DocumentIssue[] {
  return error.issues.map((issue) => {
    const out: DocumentIssue = {
      code: `schema.${issue.code}`,
      severity: "error",
      path: formatPath(issue.path),
      message: issue.message,
    };
    const blockId = blockIdAt(input, issue.path);
    if (blockId) out.blockId = blockId;
    return out;
  });
}

/** Structural (Zod) validation of untrusted input. Applies schema defaults. */
export function parseDocument(input: unknown): ParseResult {
  const result = BriefingDocument.safeParse(input);
  if (result.success) return { ok: true, document: result.data };
  return { ok: false, issues: zodIssuesToDocumentIssues(result.error, input) };
}

/**
 * Approval state of an evidence item. Items without `status` are treated as
 * approved: that only happens in published projections, because parsing a
 * draft through `BriefingDocument` defaults `status` to "candidate".
 */
export function evidenceStatus(item: { id: string; status?: EvidenceItem["status"] }): "candidate" | "approved" | "excluded" {
  return item.status ?? "approved";
}

type AnyDocument = BriefingDocument | PublishedBriefingDocument;

/**
 * Semantic checks beyond the Zod schema. Expects a parsed document (output of
 * `parseDocument`/`BriefingDocument.parse`, or a published projection).
 *
 * Mode differences: in `publish` mode, empty sections and a document with no
 * sections are errors; in `draft` mode they are warnings.
 */
export function collectIssues(doc: AnyDocument, opts: { mode: ValidationMode } = { mode: "draft" }): DocumentIssue[] {
  const issues: DocumentIssue[] = [];
  const add = (issue: DocumentIssue) => issues.push(issue);
  const publish = opts.mode === "publish";

  // ── duplicate ids anywhere ────────────────────────────────────────────────
  const seen = new Map<string, string>();
  const checkId = (id: string, path: string, blockId?: string) => {
    const first = seen.get(id);
    if (first !== undefined) {
      const issue: DocumentIssue = {
        code: "duplicate_id",
        severity: "error",
        path,
        message: `Duplicate id "${id}" (first used at ${first}).`,
      };
      if (blockId) issue.blockId = blockId;
      add(issue);
    } else {
      seen.set(id, path);
    }
  };

  const sectionIds = new Set<string>();
  const blockIds = new Set<string>();
  const evidenceById = new Map<string, AnyDocument["evidence"][number]>();

  doc.sections.forEach((section, si) => {
    checkId(section.id, `$.sections[${si}].id`);
    sectionIds.add(section.id);
    section.blocks.forEach((block, bi) => {
      const bp = `$.sections[${si}].blocks[${bi}]`;
      checkId(block.id, `${bp}.id`, block.id);
      blockIds.add(block.id);
      if (block.type === "timeline") {
        block.items.forEach((item, ii) => checkId(item.id, `${bp}.items[${ii}].id`, block.id));
      }
      if (block.type === "decision") {
        block.options.forEach((opt, oi) => checkId(opt.id, `${bp}.options[${oi}].id`, block.id));
      }
    });
  });
  doc.perspectives.forEach((p, pi) => {
    checkId(p.id, `$.perspectives[${pi}].id`);
    p.implications.forEach((imp, ii) => checkId(imp.id, `$.perspectives[${pi}].implications[${ii}].id`));
  });
  doc.evidence.forEach((ev, ei) => {
    checkId(ev.id, `$.evidence[${ei}].id`);
    if (!evidenceById.has(ev.id)) evidenceById.set(ev.id, ev);
  });
  doc.openQuestions.forEach((q, qi) => checkId(q.id, `$.openQuestions[${qi}].id`));

  // ── perspectives ─────────────────────────────────────────────────────────
  doc.perspectives.forEach((p, pi) => {
    p.emphasis.forEach((sid, ei) => {
      if (!sectionIds.has(sid)) {
        add({
          code: "perspective_emphasis_missing_section",
          severity: "error",
          path: `$.perspectives[${pi}].emphasis[${ei}]`,
          message: `Perspective "${p.label}" emphasises section "${sid}", which does not exist.`,
        });
      }
    });
    p.implications.forEach((imp, ii) => {
      imp.blockIds.forEach((bid, bi) => {
        if (!blockIds.has(bid)) {
          add({
            code: "implication_missing_block",
            severity: "error",
            path: `$.perspectives[${pi}].implications[${ii}].blockIds[${bi}]`,
            message: `Perspective "${p.label}" implication references block "${bid}", which does not exist.`,
          });
        }
      });
    });
    if (isGapPlaceholder(p.summary)) {
      add({
        code: "unresolved_gap",
        severity: "warning",
        path: `$.perspectives[${pi}].summary`,
        message: `Perspective "${p.label}" summary has not been written yet.`,
      });
    }
  });

  // ── blocks ───────────────────────────────────────────────────────────────
  if (doc.sections.length === 0) {
    add({
      code: "no_sections",
      severity: publish ? "error" : "warning",
      path: "$.sections",
      message: "The brief has no sections.",
    });
  }

  let hasDecisionBlock = false;
  doc.sections.forEach((section, si) => {
    const sp = `$.sections[${si}]`;
    if (section.blocks.length === 0) {
      add({
        code: "empty_section",
        severity: publish ? "error" : "warning",
        path: `${sp}.blocks`,
        message: `Section "${section.title}" has no content.`,
      });
    }
    section.blocks.forEach((block, bi) => {
      const bp = `${sp}.blocks[${bi}]`;
      if (block.type === "decision") hasDecisionBlock = true;

      block.evidenceRefs.forEach((ref, ri) => {
        const path = `${bp}.evidenceRefs[${ri}].evidenceId`;
        const ev = evidenceById.get(ref.evidenceId);
        if (!ev) {
          add({
            code: "evidence_ref_missing",
            severity: "error",
            path,
            blockId: block.id,
            message: `Block references evidence "${ref.evidenceId}", which does not exist.`,
          });
        } else if (evidenceStatus(ev) !== "approved") {
          add({
            code: "evidence_ref_unapproved",
            severity: "warning",
            path,
            blockId: block.id,
            message: `Evidence "${ev.title}" is ${evidenceStatus(ev)}; claim will publish without evidence.`,
          });
        }
      });

      checkBlockShape(block, bp, add);
      for (const [field] of gapFields(block)) {
        add({
          code: "unresolved_gap",
          severity: "warning",
          path: `${bp}.${field}`,
          blockId: block.id,
          message: "Block contains an unresolved placeholder.",
        });
      }
    });
  });

  if (doc.request.type === "decision" && !hasDecisionBlock) {
    add({
      code: "decision_request_without_decision_block",
      severity: "warning",
      path: "$.request",
      message: "The brief requests a decision but has no decision block.",
    });
  }

  if (!doc.evidence.some((ev) => evidenceStatus(ev) === "approved")) {
    add({
      code: "no_approved_evidence",
      severity: "warning",
      path: "$.evidence",
      message: "No supporting evidence attached.",
    });
  }

  // ── placeholder gaps in top-level fields ─────────────────────────────────
  const topLevel: [string, string | undefined, string][] = [
    ["$.title", doc.title === GAP_PLACEHOLDERS.title ? doc.title : undefined, "The brief has no title yet."],
    ["$.position.headline", doc.position.headline, "The position headline has not been stated."],
    ["$.position.summary", doc.position.summary, "The position summary has not been stated."],
    ["$.context.stakes", doc.context.stakes, "Why this matters now has not been stated."],
    ["$.request.statement", doc.request.statement, "The request to readers has not been stated."],
  ];
  for (const [path, value, message] of topLevel) {
    if (isGapPlaceholder(value)) add({ code: "unresolved_gap", severity: "warning", path, message });
  }

  return issues;
}

function checkBlockShape(block: Block, bp: string, add: (issue: DocumentIssue) => void) {
  if (block.type === "chart") {
    const lengths = block.series.map((s) => s.points.length);
    if (new Set(lengths).size > 1) {
      add({
        code: "chart_series_length_mismatch",
        severity: "error",
        path: `${bp}.series`,
        blockId: block.id,
        message: `Chart "${block.title}" series have different point counts (${lengths.join(", ")}).`,
      });
    }
  }
  if (block.type === "comparison") {
    block.rows.forEach((row, ri) => {
      if (row.cells.length !== block.columns.length) {
        add({
          code: "comparison_cells_mismatch",
          severity: "error",
          path: `${bp}.rows[${ri}].cells`,
          blockId: block.id,
          message: `Comparison row "${row.label}" has ${row.cells.length} cells but there are ${block.columns.length} columns.`,
        });
      }
    });
  }
}

function gapFields(block: Block): [string, string][] {
  const out: [string, string][] = [];
  const record = block as unknown as Record<string, unknown>;
  for (const key of ["text", "statement", "detail", "rationale"]) {
    const value = record[key];
    if (typeof value === "string" && isGapPlaceholder(value)) out.push([key, value]);
  }
  return out;
}

export interface ValidationReport {
  ok: boolean;
  document?: BriefingDocument;
  issues: DocumentIssue[];
  errors: DocumentIssue[];
  warnings: DocumentIssue[];
}

/**
 * `parseDocument` + `collectIssues`. `ok` is true when there are no errors
 * (warnings allowed). Convenient for tool responses and preview checks.
 */
export function validateDocument(input: unknown, opts: { mode: ValidationMode } = { mode: "draft" }): ValidationReport {
  const parsed = parseDocument(input);
  const issues = parsed.ok ? collectIssues(parsed.document, opts) : parsed.issues;
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const report: ValidationReport = { ok: parsed.ok && errors.length === 0, issues, errors, warnings };
  if (parsed.ok) report.document = parsed.document;
  return report;
}
