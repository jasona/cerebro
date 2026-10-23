/**
 * Briefing creation and draft editing (optimistic concurrency), evidence
 * approval, and the separate home-move / audience-change operations.
 */
import {
  briefingDrafts,
  briefingRevisions,
  briefings,
  sources,
  type Database,
  type Tx,
} from "@cerebro/database";
import {
  BriefingDocument,
  collectIssues,
  handoffToDocument,
  markdownToDocument,
  parseDocument,
  parseHandoff,
  SCHEMA_VERSION,
  type DocumentIssue,
  type EvidenceStatus,
} from "@cerebro/briefing-schema";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { assertBriefingCapability, getMembership } from "../access/index";
import { recordAudit } from "../audit";
import type { RequestContext } from "../context";
import { DomainError } from "../errors";
import {
  AudienceSpec,
  activeReaderIds,
  audienceOf,
  describePlacement,
  assertHomeAuthorized,
  assertNamedReadersEligible,
  ensureReaderGrants,
  homeOf,
  HomeSpec,
  inAuthTx,
  loadBriefingRow,
  parseInput,
  resolveAudience,
  resolveHome,
  slugify,
  type AudienceDTO,
  type HomeDTO,
  type ServiceOptions,
} from "./shared";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const CreateBriefingInput = z
  .object({
    document: z.unknown().optional(),
    handoff: z.unknown().optional(),
    markdown: z.string().min(1).max(200_000).optional(),
    home: HomeSpec.default({}),
    audience: AudienceSpec,
    title: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine((v) => [v.document, v.handoff, v.markdown].filter((x) => x !== undefined).length === 1, {
    message: "Provide exactly one of document, handoff or markdown.",
  });
export type CreateBriefingInput = z.input<typeof CreateBriefingInput>;

export const EvidenceStatusValue = z.enum(["approved", "excluded", "candidate"]);

export const DraftPatchOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("replace_document"), document: z.unknown() }).strict(),
  z
    .object({ op: z.literal("set_evidence_status"), evidenceId: z.string().min(1).max(80), status: EvidenceStatusValue })
    .strict(),
]);
export type DraftPatchOp = z.infer<typeof DraftPatchOp>;

export const UpdateDraftInput = z
  .object({
    briefingId: z.string().uuid(),
    expectedVersion: z.number().int().min(1),
    document: z.unknown().optional(),
    patch: z.array(DraftPatchOp).min(1).max(200).optional(),
  })
  .strict()
  .refine((v) => (v.document !== undefined) !== (v.patch !== undefined), {
    message: "Provide exactly one of document or patch.",
  });
export type UpdateDraftInput = z.input<typeof UpdateDraftInput>;

export const SetEvidenceStatusInput = z
  .object({
    briefingId: z.string().uuid(),
    expectedVersion: z.number().int().min(1),
    evidenceId: z.string().min(1).max(80),
    status: EvidenceStatusValue,
  })
  .strict();
export type SetEvidenceStatusInput = z.input<typeof SetEvidenceStatusInput>;

export const MoveBriefingHomeInput = z.object({ briefingId: z.string().uuid(), home: HomeSpec }).strict();
export type MoveBriefingHomeInput = z.input<typeof MoveBriefingHomeInput>;

export const ChangeAudienceInput = z.object({ briefingId: z.string().uuid(), audience: AudienceSpec }).strict();
export type ChangeAudienceInput = z.input<typeof ChangeAudienceInput>;

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface CreateBriefingResult {
  briefingId: string;
  slug: string;
  draftVersion: number;
  /** collectIssues in draft mode. */
  issues: DocumentIssue[];
  /** Content gaps reported by the composer (handoff/markdown); empty for a supplied document. */
  gaps: string[];
}

export interface DraftEvidenceDTO {
  id: string;
  title: string;
  excerpt: string;
  attribution: string | null;
  origin: "llm_handoff" | "upload" | "manual";
  status: EvidenceStatus;
}

export interface DraftDTO {
  briefingId: string;
  slug: string;
  /** Full draft document, including draft-only evidence fields. Collaborators only. */
  document: BriefingDocument;
  lockVersion: number;
  issues: DocumentIssue[];
  evidence: DraftEvidenceDTO[];
  updatedAt: Date;
  updatedBy: string;
}

export interface UpdateDraftResult {
  briefingId: string;
  draftVersion: number;
  issues: DocumentIssue[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function invalidDocument(issues: DocumentIssue[]): never {
  throw new DomainError("validation", "The briefing document is invalid.", { issues });
}

function parseDocOrThrow(input: unknown): BriefingDocument {
  const parsed = parseDocument(input);
  if (!parsed.ok) invalidDocument(parsed.issues);
  return parsed.document;
}

/** Private source references must point at sources in this company. */
async function assertSourceRefs(tx: Tx, ctx: RequestContext, doc: BriefingDocument) {
  const ids = [...new Set(doc.evidence.flatMap((e) => (e.sourceRef ? [e.sourceRef.sourceId] : [])))];
  if (!ids.length) return;
  const rows = await tx
    .select({ id: sources.id })
    .from(sources)
    .where(
      and(
        eq(sources.organizationId, ctx.organizationId),
        sql`${sources.id} in (${sql.join(ids.map((x) => sql`${x}::uuid`), sql`, `)})`,
      ),
    );
  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw new DomainError("validation", "Evidence references an unknown source.", { sourceIds: missing });
}

function composeDraft(input: z.infer<typeof CreateBriefingInput>): { document: BriefingDocument; gaps: string[] } {
  let document: BriefingDocument;
  let gaps: string[] = [];
  if (input.handoff !== undefined) {
    const parsed = parseHandoff(input.handoff);
    if (!parsed.ok) throw new DomainError("validation", "The handoff package is invalid.", { issues: parsed.issues });
    ({ document, gaps } = handoffToDocument(parsed.handoff));
  } else if (input.markdown !== undefined) {
    ({ document, gaps } = markdownToDocument(input.markdown, input.title ? { title: input.title } : {}));
  } else {
    document = parseDocOrThrow(input.document);
  }
  if (input.title) document = { ...document, title: input.title };
  // No evidence is approved on arrival (LLM_INTEGRATION.md "Evidence approval"):
  // approval is always a separate, explicit author action on the draft.
  document = { ...document, evidence: document.evidence.map((e) => ({ ...e, status: "candidate" as const })) };
  return { document: parseDocOrThrow(document), gaps };
}

function draftEvidence(doc: BriefingDocument): DraftEvidenceDTO[] {
  return doc.evidence.map((e) => ({
    id: e.id,
    title: e.title,
    excerpt: e.excerpt,
    attribution: e.attribution ?? null,
    origin: e.origin,
    status: e.status ?? "candidate",
  }));
}

/** Pick an org-unique slug and insert the briefing row (ON CONFLICT DO NOTHING never aborts the transaction). */
async function insertBriefingWithSlug(tx: Tx, values: Omit<typeof briefings.$inferInsert, "slug">, title: string) {
  const base = slugify(title);
  const taken = new Set(
    (
      await tx
        .select({ slug: briefings.slug })
        .from(briefings)
        .where(and(eq(briefings.organizationId, values.organizationId), sql`${briefings.slug} like ${`${base}%`}`))
    ).map((r) => r.slug),
  );
  for (let n = 1; n < 1000; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if (taken.has(slug)) continue;
    const rows = await tx
      .insert(briefings)
      .values({ ...values, slug })
      .onConflictDoNothing({ target: [briefings.organizationId, briefings.slug] })
      .returning();
    if (rows[0]) return rows[0];
  }
  throw new DomainError("conflict", "Could not allocate a unique slug.");
}

export async function loadDraftRow(tx: Tx, ctx: RequestContext, briefingId: string, opts: { forUpdate?: boolean } = {}) {
  const q = tx
    .select()
    .from(briefingDrafts)
    .where(and(eq(briefingDrafts.organizationId, ctx.organizationId), eq(briefingDrafts.briefingId, briefingId)));
  const rows = opts.forUpdate ? await q.for("update") : await q;
  if (!rows[0]) throw new DomainError("not_found", "Draft not found.");
  return rows[0];
}

/** Parse stored draft JSON. Drafts are stored parsed, so `status` is always present. */
export function parseStoredDraft(json: unknown): BriefingDocument {
  return BriefingDocument.parse(json);
}

// ---------------------------------------------------------------------------
// createBriefing
// ---------------------------------------------------------------------------

export async function createBriefingInTx(
  tx: Tx,
  ctx: RequestContext,
  rawInput: CreateBriefingInput,
  opts: ServiceOptions<CreateBriefingResult> = {},
): Promise<CreateBriefingResult> {
  const input = parseInput(CreateBriefingInput, rawInput);
  // Any active company member may create (ACCESS_MATRIX.md); the owner FK also requires a membership row.
  const membership = await getMembership(tx, ctx);
  if (!membership) throw new DomainError("forbidden", "Only active company members can create briefings.");

  const { document, gaps } = composeDraft(input);
  await assertSourceRefs(tx, ctx, document);
  const home = await resolveHome(tx, ctx, input.home);
  await assertHomeAuthorized(tx, ctx, home);
  const audience = await resolveAudience(tx, ctx, input.audience);
  await assertNamedReadersEligible(tx, ctx, null, input.audience.readerUserIds ?? []);

  const b = await insertBriefingWithSlug(
    tx,
    {
      organizationId: ctx.organizationId,
      ownerId: ctx.userId,
      title: document.title,
      homeDepartmentId: home.departmentId,
      homeTeamId: home.teamId,
      visibility: audience.visibility,
      audienceDepartmentId: audience.departmentId,
      audienceTeamId: audience.teamId,
    },
    document.title,
  );
  await tx.insert(briefingDrafts).values({
    organizationId: ctx.organizationId,
    briefingId: b.id,
    documentJson: document,
    schemaVersion: SCHEMA_VERSION,
    lockVersion: 1,
    updatedBy: ctx.userId,
  });
  // Named readers become reader grants immediately; grants authorize only
  // published content, so nothing is readable until publication.
  const readers = await ensureReaderGrants(tx, ctx, b.id, input.audience.readerUserIds ?? []);

  await recordAudit(tx, ctx, {
    action: "briefing.created",
    targetType: "briefing",
    targetId: b.id,
    metadata: {
      via: ctx.via,
      source: input.handoff !== undefined ? "handoff" : input.markdown !== undefined ? "markdown" : "document",
      visibility: audience.visibility,
      homeDepartmentId: home.departmentId,
      homeTeamId: home.teamId,
      namedReaders: readers.length,
    },
  });
  const result: CreateBriefingResult = {
    briefingId: b.id,
    slug: b.slug,
    draftVersion: 1,
    issues: collectIssues(document, { mode: "draft" }),
    gaps,
  };
  if (opts.operation) await opts.operation(tx, result);
  return result;
}

export function createBriefing(
  db: Database,
  ctx: RequestContext,
  input: CreateBriefingInput,
  opts?: ServiceOptions<CreateBriefingResult>,
): Promise<CreateBriefingResult> {
  return inAuthTx(db, ctx, (tx, c) => createBriefingInTx(tx, c, input, opts));
}

// ---------------------------------------------------------------------------
// getDraft
// ---------------------------------------------------------------------------

export async function getDraftInTx(tx: Tx, ctx: RequestContext, briefingId: string): Promise<DraftDTO> {
  const id = parseInput(z.string().uuid(), briefingId);
  await assertBriefingCapability(tx, ctx, id, "view_draft");
  const b = await loadBriefingRow(tx, ctx, id);
  if (!b) throw new DomainError("not_found", "Briefing not found.");
  const row = await loadDraftRow(tx, ctx, id);
  const document = parseStoredDraft(row.documentJson);
  return {
    briefingId: id,
    slug: b.slug,
    document,
    lockVersion: row.lockVersion,
    issues: collectIssues(document, { mode: "draft" }),
    evidence: draftEvidence(document),
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

export function getDraft(db: Database, ctx: RequestContext, briefingId: string): Promise<DraftDTO> {
  return inAuthTx(db, ctx, (tx, c) => getDraftInTx(tx, c, briefingId));
}

// ---------------------------------------------------------------------------
// updateDraft / setEvidenceStatus
// ---------------------------------------------------------------------------

function applyPatch(doc: BriefingDocument, ops: readonly DraftPatchOp[]): BriefingDocument {
  let next = doc;
  for (const op of ops) {
    if (op.op === "replace_document") {
      next = parseDocOrThrow(op.document);
    } else {
      if (!next.evidence.some((e) => e.id === op.evidenceId)) {
        throw new DomainError("validation", "Unknown evidence item.", { evidenceId: op.evidenceId });
      }
      next = { ...next, evidence: next.evidence.map((e) => (e.id === op.evidenceId ? { ...e, status: op.status } : e)) };
    }
  }
  return parseDocOrThrow(next);
}

/**
 * Compare-and-increment write of the draft. A stale `expectedVersion` throws
 * `conflict` with `{ currentVersion }` and never overwrites newer work. AI
 * edits (via "mcp") go through exactly the same check.
 */
export async function updateDraftInTx(
  tx: Tx,
  ctx: RequestContext,
  rawInput: UpdateDraftInput,
  opts: ServiceOptions<UpdateDraftResult> = {},
): Promise<UpdateDraftResult> {
  const input = parseInput(UpdateDraftInput, rawInput);
  await assertBriefingCapability(tx, ctx, input.briefingId, "edit");
  const row = await loadDraftRow(tx, ctx, input.briefingId, { forUpdate: true });
  if (row.lockVersion !== input.expectedVersion) {
    throw new DomainError("conflict", "The draft has changed since you loaded it.", { currentVersion: row.lockVersion });
  }
  const current = parseStoredDraft(row.documentJson);
  const next =
    input.document !== undefined ? parseDocOrThrow(input.document) : applyPatch(current, input.patch ?? []);
  await assertSourceRefs(tx, ctx, next);

  const updated = await tx
    .update(briefingDrafts)
    .set({
      documentJson: next,
      schemaVersion: SCHEMA_VERSION,
      lockVersion: sql`${briefingDrafts.lockVersion} + 1`,
      updatedBy: ctx.userId,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(briefingDrafts.organizationId, ctx.organizationId),
        eq(briefingDrafts.briefingId, input.briefingId),
        eq(briefingDrafts.lockVersion, input.expectedVersion),
      ),
    )
    .returning({ lockVersion: briefingDrafts.lockVersion });
  if (!updated[0]) {
    const [cur] = await tx
      .select({ lockVersion: briefingDrafts.lockVersion })
      .from(briefingDrafts)
      .where(eq(briefingDrafts.briefingId, input.briefingId));
    throw new DomainError("conflict", "The draft has changed since you loaded it.", { currentVersion: cur?.lockVersion });
  }

  // Before first publication the library title follows the draft (only
  // collaborators can see the briefing then). Afterwards the title is the
  // published one and changes only at publication, so drafts never leak.
  const [{ n } = { n: 0 }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(briefingRevisions)
    .where(and(eq(briefingRevisions.organizationId, ctx.organizationId), eq(briefingRevisions.briefingId, input.briefingId)));
  if (n === 0) {
    await tx
      .update(briefings)
      .set({ title: next.title, updatedAt: sql`now()` })
      .where(and(eq(briefings.organizationId, ctx.organizationId), eq(briefings.id, input.briefingId)));
  }

  const result: UpdateDraftResult = {
    briefingId: input.briefingId,
    draftVersion: updated[0].lockVersion,
    issues: collectIssues(next, { mode: "draft" }),
  };
  if (opts.operation) await opts.operation(tx, result);
  return result;
}

export function updateDraft(
  db: Database,
  ctx: RequestContext,
  input: UpdateDraftInput,
  opts?: ServiceOptions<UpdateDraftResult>,
): Promise<UpdateDraftResult> {
  return inAuthTx(db, ctx, (tx, c) => updateDraftInTx(tx, c, input, opts));
}

export function setEvidenceStatusInTx(
  tx: Tx,
  ctx: RequestContext,
  rawInput: SetEvidenceStatusInput,
  opts?: ServiceOptions<UpdateDraftResult>,
): Promise<UpdateDraftResult> {
  const input = parseInput(SetEvidenceStatusInput, rawInput);
  return updateDraftInTx(
    tx,
    ctx,
    {
      briefingId: input.briefingId,
      expectedVersion: input.expectedVersion,
      patch: [{ op: "set_evidence_status", evidenceId: input.evidenceId, status: input.status }],
    },
    opts,
  );
}

export function setEvidenceStatus(
  db: Database,
  ctx: RequestContext,
  input: SetEvidenceStatusInput,
  opts?: ServiceOptions<UpdateDraftResult>,
): Promise<UpdateDraftResult> {
  return inAuthTx(db, ctx, (tx, c) => setEvidenceStatusInTx(tx, c, input, opts));
}

// ---------------------------------------------------------------------------
// Home move and audience change (separate audited operations)
// ---------------------------------------------------------------------------

export interface MoveBriefingHomeResult {
  briefingId: string;
  home: HomeDTO;
}

/** Changes placement only. Never touches visibility, audience ids or grants. */
export async function moveBriefingHomeInTx(
  tx: Tx,
  ctx: RequestContext,
  rawInput: MoveBriefingHomeInput,
): Promise<MoveBriefingHomeResult> {
  const input = parseInput(MoveBriefingHomeInput, rawInput);
  await assertBriefingCapability(tx, ctx, input.briefingId, "edit");
  const b = await loadBriefingRow(tx, ctx, input.briefingId, { forUpdate: true });
  if (!b) throw new DomainError("not_found", "Briefing not found.");
  const home = await resolveHome(tx, ctx, input.home);
  await assertHomeAuthorized(tx, ctx, home);
  await tx
    .update(briefings)
    .set({ homeDepartmentId: home.departmentId, homeTeamId: home.teamId, updatedAt: sql`now()` })
    .where(and(eq(briefings.organizationId, ctx.organizationId), eq(briefings.id, b.id)));
  await recordAudit(tx, ctx, {
    action: "briefing.home_moved",
    targetType: "briefing",
    targetId: b.id,
    metadata: {
      from: { departmentId: b.homeDepartmentId, teamId: b.homeTeamId },
      to: { departmentId: home.departmentId, teamId: home.teamId },
    },
  });
  const { home: dto } = await describePlacement(tx, ctx, home, audienceOf(b));
  return { briefingId: b.id, home: dto };
}

export function moveBriefingHome(db: Database, ctx: RequestContext, input: MoveBriefingHomeInput): Promise<MoveBriefingHomeResult> {
  return inAuthTx(db, ctx, (tx, c) => moveBriefingHomeInTx(tx, c, input));
}

export interface ChangeAudienceResult {
  briefingId: string;
  audience: AudienceDTO;
}

/**
 * Change visibility / audience ids. `readerUserIds` are added as reader
 * grants (additive; removing a named reader is an explicit `revokeGrant`).
 * Takes effect immediately for the current publication; open previews become
 * stale. Never changes the home.
 */
export async function changeAudienceInTx(tx: Tx, ctx: RequestContext, rawInput: ChangeAudienceInput): Promise<ChangeAudienceResult> {
  const input = parseInput(ChangeAudienceInput, rawInput);
  await assertBriefingCapability(tx, ctx, input.briefingId, "manage_access");
  const b = await loadBriefingRow(tx, ctx, input.briefingId, { forUpdate: true });
  if (!b) throw new DomainError("not_found", "Briefing not found.");
  const audience = await resolveAudience(tx, ctx, input.audience);
  await assertNamedReadersEligible(tx, ctx, b.id, input.audience.readerUserIds ?? []);
  await tx
    .update(briefings)
    .set({
      visibility: audience.visibility,
      audienceDepartmentId: audience.departmentId,
      audienceTeamId: audience.teamId,
      updatedAt: sql`now()`,
    })
    .where(and(eq(briefings.organizationId, ctx.organizationId), eq(briefings.id, b.id)));
  const added = await ensureReaderGrants(tx, ctx, b.id, input.audience.readerUserIds ?? []);
  await recordAudit(tx, ctx, {
    action: "briefing.audience_changed",
    targetType: "briefing",
    targetId: b.id,
    metadata: {
      from: { visibility: b.visibility, departmentId: b.audienceDepartmentId, teamId: b.audienceTeamId },
      to: { visibility: audience.visibility, departmentId: audience.departmentId, teamId: audience.teamId },
      namedReadersAdded: added.length,
    },
  });
  const { audience: dto } = await describePlacement(tx, ctx, homeOf(b), audience, await activeReaderIds(tx, ctx, b.id));
  return { briefingId: b.id, audience: dto };
}

export function changeAudience(db: Database, ctx: RequestContext, input: ChangeAudienceInput): Promise<ChangeAudienceResult> {
  return inAuthTx(db, ctx, (tx, c) => changeAudienceInTx(tx, c, input));
}
