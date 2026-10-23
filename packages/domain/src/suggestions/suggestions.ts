/**
 * AI-assisted composition proposals (W3.3, principle 2, D06).
 *
 * Two kinds of proposal are stored in `briefing_suggestions`:
 *
 * - `perspective`: an AI-suggested audience perspective (Phase 3). It is
 *   validated with `validateSuggestedPerspective`: emphasis and implication
 *   links may reference only existing sections and blocks, text may not name
 *   unknown ids or state numbers the draft does not, and labels may not
 *   duplicate existing perspectives.
 * - `revision`: operations proposed by the revision task for an author
 *   instruction. Operations are applied to a copy and re-validated before
 *   they are stored; evidence is never touched (approval stays an explicit
 *   author action).
 *
 * Nothing here changes the draft or any publication. A suggestion reaches the
 * draft only when the author accepts it, through `updateDraftInTx` with the
 * author's `expectedVersion` (the same optimistic-concurrency check as manual
 * edits). Dismissed and accepted suggestions are final. Model calls run
 * outside transactions; provider failure returns `unavailable` and leaves the
 * draft untouched (principle 6). Prompts, payloads and draft text are never
 * logged; ai_runs records ids, labels, counts and categories only.
 */
import {
  applyRevisionOperations,
  RevisionOperation,
  runTask,
  SuggestPerspectivesTask,
  ProposeRevisionTask,
  validateSuggestedPerspective,
  collectIds,
  type AiErrorCategory,
  type AiRunRecord,
  type AiTask,
  type OrgAiPolicy,
  type PerspectiveIssue,
  type RunTaskResult,
  type TaskInput,
  type TaskOutput,
} from "@cerebro/ai";
import { collectIssues, newId, Perspective, type BriefingDocument, type DocumentIssue } from "@cerebro/briefing-schema";
import { briefingSuggestions, type Database, type SuggestionKind, type SuggestionStatus, type Tx } from "@cerebro/database";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { assertBriefingCapability } from "../access/index";
import { recordAudit } from "../audit";
import { loadDraftRow, parseStoredDraft, updateDraftInTx } from "../briefings/drafts";
import { inAuthTx, parseInput } from "../briefings/shared";
import type { RequestContext } from "../context";
import { AI_SETTINGS, getAiRuntimeOrNull, resolveOrgAiPolicy } from "../engagement/ai-runtime";
import { DomainError } from "../errors";
import { checkAiUsage, recordAiRun } from "../ops/ai-usage";

// ---------------------------------------------------------------------------
// DTOs and inputs
// ---------------------------------------------------------------------------

export interface SuggestionDto {
  id: string;
  kind: SuggestionKind;
  status: SuggestionStatus;
  /** Draft version the proposal was generated against. */
  baseVersion: number;
  /** Provider id and model label that produced it, e.g. "deterministic" / "deterministic-v1". */
  provider: string;
  model: string;
  createdAt: string;
  /** `perspective` suggestions. */
  perspective?: Perspective;
  /** Why this was suggested; shown to the author only. */
  rationale?: string;
  /** `revision` suggestions. */
  scope?: string;
  explanation?: string;
  operations?: RevisionOperation[];
}

export type SuggestOutcomeStatus = "suggested" | "none" | "unavailable";

export interface SuggestPerspectivesResult {
  status: SuggestOutcomeStatus;
  suggestions: SuggestionDto[];
  /** Proposals dropped because they broke the D06 checks (never stored). */
  rejected: number;
  /** Plain-language note for the author (why there are none, or why some were dropped). */
  notes?: string;
}

export interface RevisionProposalResult {
  status: "suggested" | "no_change" | "unsupported" | "rejected" | "unavailable";
  suggestion?: SuggestionDto;
  explanation?: string;
}

export interface AcceptSuggestionResult {
  briefingId: string;
  draftVersion: number;
  issues: DocumentIssue[];
}

export const RequestPerspectiveSuggestionsInput = z
  .object({ briefingId: z.string().uuid(), maxSuggestions: z.number().int().min(1).max(8).optional() })
  .strict();
export type RequestPerspectiveSuggestionsInput = z.input<typeof RequestPerspectiveSuggestionsInput>;

export const RequestRevisionProposalInput = z
  .object({ briefingId: z.string().uuid(), instruction: z.string().trim().min(1).max(5000) })
  .strict();
export type RequestRevisionProposalInput = z.input<typeof RequestRevisionProposalInput>;

export const DecideSuggestionInput = z
  .object({
    briefingId: z.string().uuid(),
    suggestionId: z.string().uuid(),
    /** Draft version the author is looking at (accept only). */
    expectedVersion: z.number().int().min(1).optional(),
  })
  .strict();
export type DecideSuggestionInput = z.input<typeof DecideSuggestionInput>;

const StoredPerspective = z.object({ perspective: Perspective, rationale: z.string() });
const StoredRevision = z.object({
  scope: z.string(),
  explanation: z.string().optional(),
  operations: z.array(RevisionOperation).min(1),
});

const DEFAULT_SUGGESTIONS = 3;

/** Failures after which the next approved provider (ultimately the local one) is tried. */
const FALLBACK_ON: ReadonlySet<AiErrorCategory> = new Set(["unavailable", "timeout", "provider_error", "invalid_output", "unsupported"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Row = typeof briefingSuggestions.$inferSelect;

function toDto(row: Row): SuggestionDto {
  const base = {
    id: row.id,
    kind: row.kind,
    status: row.status,
    baseVersion: row.baseVersion,
    provider: row.provider,
    model: row.model,
    createdAt: row.createdAt.toISOString(),
  };
  if (row.kind === "perspective") {
    const p = StoredPerspective.safeParse(row.payload);
    return p.success ? { ...base, perspective: p.data.perspective, rationale: p.data.rationale } : base;
  }
  const r = StoredRevision.safeParse(row.payload);
  return r.success
    ? { ...base, scope: r.data.scope, operations: r.data.operations, ...(r.data.explanation ? { explanation: r.data.explanation } : {}) }
    : base;
}

/**
 * Run a task with policy-bounded fallback across the registry's approved
 * candidates. Returns every run record (for ai_runs) and the first success.
 */
async function runWithFallback<T extends AiTask>(
  task: T,
  input: TaskInput<T>,
  policy: OrgAiPolicy,
  usageLimited: boolean,
): Promise<{ result: Extract<RunTaskResult<TaskOutput<T>>, { ok: true }> | null; records: AiRunRecord[] }> {
  const runtime = await getAiRuntimeOrNull();
  // Over the organization's AI usage limit, behave as during an outage: no provider call.
  const candidates = runtime && !usageLimited ? runtime.registry.candidates(task.name, policy) : [];
  const records: AiRunRecord[] = [];
  for (const provider of candidates) {
    const res = await runTask(provider, task, input, { timeoutMs: AI_SETTINGS.proposalTimeoutMs });
    records.push(res.record);
    if (res.ok) return { result: res, records };
    if (!FALLBACK_ON.has(res.error.category)) break;
  }
  if (records.length === 0) {
    records.push({
      task: task.name,
      provider: "none",
      model: "none",
      promptVersion: task.promptVersion,
      status: "failed",
      latencyMs: 0,
      usage: {},
      errorCategory: "unavailable",
    });
  }
  return { result: null, records };
}

async function insertRuns(tx: Tx, ctx: RequestContext, records: AiRunRecord[]): Promise<string | null> {
  let id: string | null = null;
  for (const r of records) id = await recordAiRun(tx, ctx.organizationId, ctx.userId, r);
  return id;
}

async function pendingRows(tx: Tx, ctx: RequestContext, briefingId: string): Promise<Row[]> {
  return tx
    .select()
    .from(briefingSuggestions)
    .where(
      and(
        eq(briefingSuggestions.organizationId, ctx.organizationId),
        eq(briefingSuggestions.briefingId, briefingId),
        eq(briefingSuggestions.status, "pending"),
      ),
    )
    .orderBy(asc(briefingSuggestions.createdAt), asc(briefingSuggestions.id));
}

function pendingLabels(rows: Row[]): string[] {
  return rows.flatMap((r) => {
    const p = r.kind === "perspective" ? StoredPerspective.safeParse(r.payload) : null;
    return p?.success ? [p.data.perspective.label] : [];
  });
}

const errorCount = (doc: BriefingDocument) => collectIssues(doc, { mode: "draft" }).filter((i) => i.severity === "error").length;

/**
 * Validate proposed revision operations against a draft: they must apply
 * cleanly, keep the document valid, add no new errors, leave evidence
 * untouched, and any perspective they add or change must pass the D06 checks.
 */
function checkOperations(doc: BriefingDocument, ops: readonly RevisionOperation[]): { ok: true; next: BriefingDocument } | { ok: false; reason: string } {
  let next: BriefingDocument;
  try {
    next = applyRevisionOperations(doc, ops);
  } catch {
    return { ok: false, reason: "The proposed changes do not apply to the current draft." };
  }
  if (JSON.stringify(next.evidence) !== JSON.stringify(doc.evidence)) return { ok: false, reason: "Proposals cannot change evidence." };
  if (errorCount(next) > errorCount(doc)) return { ok: false, reason: "The proposed changes would add validation errors." };
  for (const op of ops) {
    if (op.op !== "add_perspective" && op.op !== "update_perspective") continue;
    const others = { ...doc, perspectives: doc.perspectives.filter((p) => p.id !== op.perspective.id) };
    const v = validateSuggestedPerspective(others, op.perspective, { checkCapacity: false });
    // An empty scaffold (the local provider's "add perspective" proposal) is allowed: the author fills it in.
    const blocking = v.ok ? [] : v.issues.filter((i) => i.code !== "empty");
    if (blocking.length) return { ok: false, reason: blocking.map((i) => i.message).join(" ") };
  }
  return { ok: true, next };
}

/** Give an accepted perspective fresh ids if any collide with the current draft. */
function withFreshIds(doc: BriefingDocument, p: Perspective): Perspective {
  const taken = collectIds(doc);
  return {
    ...p,
    id: taken.has(p.id) ? newId("psp") : p.id,
    implications: p.implications.map((i) => (taken.has(i.id) ? { ...i, id: newId("itm") } : i)),
  };
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * Ask the configured provider for perspective suggestions on the draft.
 * Requires `edit`. Stores valid suggestions as pending; never changes the draft.
 */
export async function requestPerspectiveSuggestions(
  db: Database,
  ctx: RequestContext,
  raw: RequestPerspectiveSuggestionsInput,
): Promise<SuggestPerspectivesResult> {
  const input = parseInput(RequestPerspectiveSuggestionsInput, raw);
  const prep = await inAuthTx(db, ctx, async (tx, c) => {
    await assertBriefingCapability(tx, c, input.briefingId, "edit");
    const row = await loadDraftRow(tx, c, input.briefingId);
    return {
      doc: parseStoredDraft(row.documentJson),
      version: row.lockVersion,
      policy: await resolveOrgAiPolicy(tx, c.organizationId),
      usageLimited: !(await checkAiUsage(tx, c.organizationId)).allowed,
      pending: pendingLabels(await pendingRows(tx, c, input.briefingId)),
    };
  });

  // Ask for enough to make up for suggestions that duplicate pending ones.
  const wanted = input.maxSuggestions ?? DEFAULT_SUGGESTIONS;
  const { result, records } = await runWithFallback(
    SuggestPerspectivesTask,
    { document: prep.doc, baseVersion: prep.version, maxSuggestions: Math.min(8, wanted + prep.pending.length) },
    prep.policy,
    prep.usageLimited,
  );

  const valid: { perspective: Perspective; rationale: string }[] = [];
  let rejected = 0;
  const issues: PerspectiveIssue[] = [];
  if (result) {
    const labels = [...prep.pending];
    for (const s of result.output.suggestions) {
      const v = validateSuggestedPerspective(prep.doc, s.perspective, { pendingLabels: labels });
      if (v.ok) {
        if (valid.length >= wanted) continue;
        valid.push({ perspective: v.perspective, rationale: s.rationale });
        labels.push(v.perspective.label);
      } else if (!v.issues.every((i) => i.code === "duplicate_label")) {
        rejected++;
        issues.push(...v.issues);
      }
    }
  }

  return inAuthTx(db, ctx, async (tx, c) => {
    await assertBriefingCapability(tx, c, input.briefingId, "edit");
    const aiRunId = await insertRuns(tx, c, records);
    if (!result) return { status: "unavailable" as const, suggestions: [], rejected: 0, notes: "Suggestions are unavailable right now. Your draft is unchanged and you can keep editing." };
    const provider = result.record.provider;
    const model = result.record.model;
    const rows = valid.length
      ? await tx
          .insert(briefingSuggestions)
          .values(
            valid.map((v, i) => ({
              organizationId: c.organizationId,
              briefingId: input.briefingId,
              kind: "perspective" as const,
              baseVersion: prep.version,
              payload: v,
              provider,
              model,
              aiRunId,
              createdBy: c.userId,
              // Listing orders by created_at; rows of one insert can share a clock
              // reading, so offset each by its position to keep the provider's order.
              createdAt: sql`clock_timestamp() + make_interval(secs => ${i / 1_000_000})`,
            })),
          )
          .returning()
      : [];
    await recordAudit(tx, c, {
      action: "suggestion.requested",
      targetType: "briefing",
      targetId: input.briefingId,
      metadata: { kind: "perspective", provider, model, stored: rows.length, rejected, issueCodes: [...new Set(issues.map((i) => i.code))] },
    });
    const notes =
      rejected > 0
        ? `${rejected} suggestion${rejected === 1 ? " was" : "s were"} dropped because ${rejected === 1 ? "it" : "they"} referenced content that is not in the draft or stated new figures.`
        : rows.length === 0
          ? (result.output.notes ?? "No new perspectives to suggest.")
          : undefined;
    return { status: rows.length ? ("suggested" as const) : ("none" as const), suggestions: rows.map(toDto), rejected, ...(notes ? { notes } : {}) };
  });
}

/**
 * Ask the configured provider for a revision proposal for an author
 * instruction. Requires `edit`. A valid proposal is stored as a pending
 * `revision` suggestion; nothing is applied.
 */
export async function requestRevisionProposal(
  db: Database,
  ctx: RequestContext,
  raw: RequestRevisionProposalInput,
): Promise<RevisionProposalResult> {
  const input = parseInput(RequestRevisionProposalInput, raw);
  const prep = await inAuthTx(db, ctx, async (tx, c) => {
    await assertBriefingCapability(tx, c, input.briefingId, "edit");
    const row = await loadDraftRow(tx, c, input.briefingId);
    return {
      doc: parseStoredDraft(row.documentJson),
      version: row.lockVersion,
      policy: await resolveOrgAiPolicy(tx, c.organizationId),
      usageLimited: !(await checkAiUsage(tx, c.organizationId)).allowed,
    };
  });

  const { result, records } = await runWithFallback(
    ProposeRevisionTask,
    { document: prep.doc, baseVersion: prep.version, instruction: input.instruction, feedback: [] },
    prep.policy,
    prep.usageLimited,
  );

  let outcome: RevisionProposalResult;
  let payload: z.infer<typeof StoredRevision> | null = null;
  if (!result) {
    outcome = { status: "unavailable", explanation: "Proposals are unavailable right now. Your draft is unchanged and you can keep editing." };
  } else {
    const out = result.output;
    const ops = out.operations ?? [];
    if (out.status !== "proposed") {
      outcome = { status: out.status, explanation: out.explanation ?? out.scope };
    } else if (ops.length === 0) {
      outcome = { status: "rejected", explanation: "The proposal did not contain specific changes. Replacement documents are not accepted; ask for a smaller change." };
    } else {
      const checked = checkOperations(prep.doc, ops);
      if (!checked.ok) outcome = { status: "rejected", explanation: checked.reason };
      else {
        payload = { scope: out.scope, operations: ops, ...(out.explanation ? { explanation: out.explanation } : {}) };
        outcome = { status: "suggested" };
      }
    }
  }

  return inAuthTx(db, ctx, async (tx, c) => {
    await assertBriefingCapability(tx, c, input.briefingId, "edit");
    const aiRunId = await insertRuns(tx, c, records);
    if (payload && result) {
      const [row] = await tx
        .insert(briefingSuggestions)
        .values({
          organizationId: c.organizationId,
          briefingId: input.briefingId,
          kind: "revision",
          baseVersion: prep.version,
          payload,
          provider: result.record.provider,
          model: result.record.model,
          aiRunId,
          createdBy: c.userId,
        })
        .returning();
      outcome = { status: "suggested", suggestion: toDto(row!) };
    }
    await recordAudit(tx, c, {
      action: "suggestion.requested",
      targetType: "briefing",
      targetId: input.briefingId,
      metadata: { kind: "revision", outcome: outcome.status, provider: result?.record.provider ?? "none" },
    });
    return outcome;
  });
}

// ---------------------------------------------------------------------------
// List, accept, dismiss
// ---------------------------------------------------------------------------

/** Pending suggestions for a draft. Requires `view_draft` (they contain proposed draft content). */
export async function listSuggestions(db: Database, ctx: RequestContext, briefingId: string): Promise<SuggestionDto[]> {
  const id = parseInput(z.string().uuid(), briefingId);
  return inAuthTx(db, ctx, async (tx, c) => {
    await assertBriefingCapability(tx, c, id, "view_draft");
    return (await pendingRows(tx, c, id)).map(toDto);
  });
}

async function lockPending(tx: Tx, ctx: RequestContext, briefingId: string, suggestionId: string): Promise<Row> {
  const [row] = await tx
    .select()
    .from(briefingSuggestions)
    .where(
      and(
        eq(briefingSuggestions.organizationId, ctx.organizationId),
        eq(briefingSuggestions.briefingId, briefingId),
        eq(briefingSuggestions.id, suggestionId),
      ),
    )
    .for("update");
  if (!row) throw new DomainError("not_found", "Suggestion not found.");
  if (row.status !== "pending") throw new DomainError("conflict", "This suggestion was already decided.", { reason: "suggestion_decided", status: row.status });
  return row;
}

async function decide(tx: Tx, ctx: RequestContext, row: Row, status: "accepted" | "dismissed", appliedVersion: number | null) {
  await tx
    .update(briefingSuggestions)
    .set({ status, decidedBy: ctx.userId, decidedAt: sql`now()`, appliedVersion })
    .where(and(eq(briefingSuggestions.organizationId, ctx.organizationId), eq(briefingSuggestions.id, row.id)));
  await recordAudit(tx, ctx, {
    action: `suggestion.${status}`,
    targetType: "briefing",
    targetId: row.briefingId,
    metadata: { suggestionId: row.id, kind: row.kind, provider: row.provider, model: row.model, ...(appliedVersion ? { draftVersion: appliedVersion } : {}) },
  });
}

/**
 * Apply a pending suggestion to the draft as an explicit author action.
 *
 * Requires `edit` and the author's `expectedVersion`; a stale version is a
 * `conflict` with `{ currentVersion }` exactly like a manual save, and the
 * write goes through `updateDraftInTx`. The suggestion is re-validated
 * against the current draft (sections may have been removed since). Revision
 * operations additionally require the draft to be unchanged since the
 * proposal was generated (`reason: "suggestion_stale"`).
 */
export async function acceptSuggestion(db: Database, ctx: RequestContext, raw: DecideSuggestionInput): Promise<AcceptSuggestionResult> {
  const input = parseInput(DecideSuggestionInput, raw);
  if (input.expectedVersion === undefined) throw new DomainError("validation", "expectedVersion is required to accept a suggestion.");
  const expectedVersion = input.expectedVersion;
  return inAuthTx(db, ctx, async (tx, c) => {
    await assertBriefingCapability(tx, c, input.briefingId, "edit");
    const row = await lockPending(tx, c, input.briefingId, input.suggestionId);
    const draft = await loadDraftRow(tx, c, input.briefingId, { forUpdate: true });
    if (draft.lockVersion !== expectedVersion) {
      throw new DomainError("conflict", "The draft has changed since you loaded it.", { currentVersion: draft.lockVersion });
    }
    const doc = parseStoredDraft(draft.documentJson);

    let next: BriefingDocument;
    if (row.kind === "perspective") {
      const stored = StoredPerspective.safeParse(row.payload);
      if (!stored.success) throw new DomainError("validation", "This suggestion can no longer be applied.", { reasons: ["invalid_payload"] });
      const v = validateSuggestedPerspective(doc, withFreshIds(doc, stored.data.perspective));
      if (!v.ok) {
        throw new DomainError("validation", "This suggestion no longer fits the draft.", {
          reasons: v.issues.map((i) => i.code),
          messages: v.issues.map((i) => i.message),
        });
      }
      next = { ...doc, perspectives: [...doc.perspectives, v.perspective] };
    } else {
      if (row.baseVersion !== draft.lockVersion) {
        throw new DomainError("conflict", "The draft changed after this proposal was made. Request a new proposal.", {
          reason: "suggestion_stale",
          currentVersion: draft.lockVersion,
        });
      }
      const stored = StoredRevision.safeParse(row.payload);
      if (!stored.success) throw new DomainError("validation", "This suggestion can no longer be applied.", { reasons: ["invalid_payload"] });
      const checked = checkOperations(doc, stored.data.operations);
      if (!checked.ok) throw new DomainError("validation", checked.reason, { reasons: ["invalid_operations"] });
      next = checked.next;
    }

    const res = await updateDraftInTx(tx, c, { briefingId: input.briefingId, expectedVersion, document: next });
    await decide(tx, c, row, "accepted", res.draftVersion);
    return { briefingId: input.briefingId, draftVersion: res.draftVersion, issues: res.issues };
  });
}

/** Dismiss a pending suggestion. Requires `edit`; the draft is not touched. */
export async function dismissSuggestion(db: Database, ctx: RequestContext, raw: DecideSuggestionInput): Promise<void> {
  const input = parseInput(DecideSuggestionInput, raw);
  await inAuthTx(db, ctx, async (tx, c) => {
    await assertBriefingCapability(tx, c, input.briefingId, "edit");
    const row = await lockPending(tx, c, input.briefingId, input.suggestionId);
    await decide(tx, c, row, "dismissed", null);
  });
}
