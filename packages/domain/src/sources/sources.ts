import { newId } from "@cerebro/briefing-schema";
import { SOURCE_KINDS as CAPTURE_KINDS, imageFormat, validateUpload, type SourceKind as CaptureKind } from "@cerebro/capture";
import {
  auditEvents,
  briefingSources,
  enqueueJob,
  sourceChunks,
  sources,
  withAuthContext,
  type Database,
  type Executor,
  type Tx,
} from "@cerebro/database";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { assertBriefingCapability, getBriefingCapabilities, getMembership } from "../access/index";
import { recordAudit } from "../audit";
import { loadDraftRow, parseStoredDraft, updateDraftInTx } from "../briefings/drafts";
import { RequestContext } from "../context";
import { DomainError } from "../errors";
import { dedupeKeys } from "../jobs/kinds";
import { enforceRateLimit } from "../ops/rate-limit";
import { getSourceStore, sha256Hex, sourceKeyFor } from "./store";

// ---------------------------------------------------------------------------
// Capture kind <-> stored mime type
// ---------------------------------------------------------------------------

/**
 * `sources.kind` records provenance (upload / text / llm_handoff); the capture
 * format is recorded in `mime_type` so the extractor knows how to parse it.
 */
export const CAPTURE_MIME: Record<CaptureKind, string> = {
  text: "text/plain",
  markdown: "text/markdown",
  conversation: "text/x-cerebro-conversation",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  /** Images are stored with their actual type (see `mimeForCapture`); read by OCR. */
  image: "image/png",
};

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Stored mime type for a validated source: images keep their real format (from magic bytes). */
export function mimeForCapture(kind: CaptureKind, bytes?: Uint8Array): string {
  if (kind === "image" && bytes) {
    const format = imageFormat(bytes);
    if (format) return `image/${format}`;
  }
  return CAPTURE_MIME[kind];
}

export function captureKindFromMime(mime: string | null): CaptureKind | null {
  if (mime && IMAGE_MIMES.has(mime)) return "image";
  for (const [kind, m] of Object.entries(CAPTURE_MIME) as [CaptureKind, string][]) if (m === mime) return kind;
  return null;
}

const ORIGIN_TO_SOURCE_KIND = { upload: "upload", llm_handoff: "llm_handoff", manual: "text" } as const;
export const SOURCE_KIND_TO_ORIGIN: Record<string, "upload" | "llm_handoff" | "manual"> = {
  upload: "upload",
  llm_handoff: "llm_handoff",
  text: "manual",
};

const parseCtx = (ctx: RequestContext) => RequestContext.parse(ctx);

// ---------------------------------------------------------------------------
// addSource
// ---------------------------------------------------------------------------

export const AddSourceInput = z
  .object({
    briefingId: z.string().uuid().optional(),
    kind: z.enum(CAPTURE_KINDS),
    title: z.string().trim().min(1).max(300).optional(),
    filename: z.string().trim().min(1).max(255).optional(),
    text: z.string().optional(),
    bytes: z.custom<Uint8Array>((v) => v instanceof Uint8Array, "Expected bytes.").optional(),
    origin: z.enum(["upload", "llm_handoff", "manual"]),
    /** Host- or author-provided attribution label; not verification. */
    attribution: z.string().trim().max(300).optional(),
    /**
     * With `briefingId`: once extraction succeeds, compose the draft from this
     * source if the draft is still the untouched blank template (never
     * overwrites content; see composeDraftFromSource).
     */
    composeDraft: z.boolean().optional(),
  })
  .refine((v) => (v.text === undefined) !== (v.bytes === undefined), { message: "Provide either text or bytes." });
export type AddSourceInput = z.input<typeof AddSourceInput>;

export interface AddSourceResult {
  sourceId: string;
  extractionStatus: "pending";
  /** `sha256:<hex>` of the stored original. */
  checksum: string;
  linkedBriefingId: string | null;
}

/**
 * Serialize work on one content-addressed object within the transaction:
 * storing it for a new source (addSource) and deleting it once no source
 * references it (source deletion and retention). Without this, an upload of
 * the same bytes that commits between the deletion's reference check and the
 * object removal would be left pointing at a deleted object.
 */
export async function lockSourceObject(tx: Tx, objectKey: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`cerebro:source-object:${objectKey}`}, 0))`);
}

/**
 * Store a private source and enqueue extraction. Requires `edit` on the
 * briefing when attached to one; otherwise an active company membership.
 * Bytes go to the private SourceStore (content-addressed, immutable); text is
 * stored inline. Extraction runs in the `extract_source` job.
 */
export async function addSource(db: Database, ctx: RequestContext, raw: AddSourceInput): Promise<AddSourceResult> {
  const c = parseCtx(ctx);
  const parsed = AddSourceInput.safeParse(raw);
  if (!parsed.success) throw new DomainError("validation", "Invalid source.", { issues: parsed.error.issues.map((i) => i.message) });
  const input = parsed.data;

  const valid = validateUpload({
    kind: input.kind,
    ...(input.text !== undefined ? { text: input.text } : {}),
    ...(input.bytes !== undefined ? { bytes: input.bytes } : {}),
    ...(input.filename ? { filename: input.filename } : {}),
  });
  if (!valid.ok) throw new DomainError("validation", valid.error.message, { code: valid.error.code });
  await enforceRateLimit(db, c, "upload");

  return withAuthContext(db, { userId: c.userId, organizationId: c.organizationId, connectionId: c.connectionId }, async (tx) => {
    if (input.briefingId) await assertBriefingCapability(tx, c, input.briefingId, "edit");
    else if (!(await getMembership(tx, c))) throw new DomainError("forbidden", "Adding sources requires company membership.");

    let objectKey: string | null = null;
    let textContent: string | null = null;
    let digest: string;
    let byteSize: number;
    if (input.bytes !== undefined) {
      // Held until commit, so a concurrent deletion of the same object waits for this row.
      await lockSourceObject(tx, sourceKeyFor(c.organizationId, input.bytes).key);
      const stored = await getSourceStore().put(c.organizationId, input.bytes);
      objectKey = stored.key;
      digest = stored.sha256;
      byteSize = input.bytes.byteLength;
    } else {
      textContent = input.text!;
      digest = sha256Hex(textContent);
      byteSize = Buffer.byteLength(textContent, "utf8");
    }
    const checksum = `sha256:${digest}`;

    const [row] = await tx
      .insert(sources)
      .values({
        organizationId: c.organizationId,
        createdBy: c.userId,
        kind: ORIGIN_TO_SOURCE_KIND[input.origin],
        title: input.title ?? input.filename ?? "Untitled source",
        objectKey,
        textContent,
        mimeType: mimeForCapture(input.kind, input.bytes),
        byteSize,
        checksum,
        extractionStatus: "pending",
        connectionId: c.connectionId ?? null,
        attribution: input.attribution || null,
      })
      .returning({ id: sources.id });
    const sourceId = row!.id;

    if (input.briefingId) {
      await tx.insert(briefingSources).values({
        organizationId: c.organizationId,
        briefingId: input.briefingId,
        sourceId,
        usage: { origin: input.origin, ...(input.composeDraft ? { composeDraft: true } : {}) },
      });
    }
    await enqueueJob(tx, {
      organizationId: c.organizationId,
      kind: "extract_source",
      payload: { sourceId, requestedBy: c.userId },
      dedupeKey: dedupeKeys.extractSource(c.organizationId, sourceId, digest),
    });
    await recordAudit(tx, c, {
      action: "source.added",
      targetType: "source",
      targetId: sourceId,
      metadata: { kind: input.kind, origin: input.origin, byteSize, briefingId: input.briefingId ?? null },
    });
    return { sourceId, extractionStatus: "pending", checksum, linkedBriefingId: input.briefingId ?? null };
  });
}

// ---------------------------------------------------------------------------
// Source access
// ---------------------------------------------------------------------------

/**
 * Whether the user may work with a private source: its creator (while an
 * active member), or an editor of a briefing the source is linked to. Company
 * roles and reader access grant nothing (D09, P07).
 */
export async function canAccessSource(tx: Executor, ctx: RequestContext, sourceId: string): Promise<boolean> {
  const c = parseCtx(ctx);
  if (!z.string().uuid().safeParse(sourceId).success) return false;
  const [src] = await tx
    .select({ createdBy: sources.createdBy })
    .from(sources)
    .where(and(eq(sources.organizationId, c.organizationId), eq(sources.id, sourceId)));
  if (!src) return false;
  if (src.createdBy === c.userId && (await getMembership(tx, c))) return true;
  const links = await tx
    .select({ briefingId: briefingSources.briefingId })
    .from(briefingSources)
    .where(and(eq(briefingSources.organizationId, c.organizationId), eq(briefingSources.sourceId, sourceId)));
  for (const l of links) if ((await getBriefingCapabilities(tx, c, l.briefingId)).has("edit")) return true;
  return false;
}

// ---------------------------------------------------------------------------
// getSourceExtraction
// ---------------------------------------------------------------------------

export interface ExtractionGapDto {
  code: string;
  message: string;
  locator: string | null;
  affectsCompleteness: boolean;
}

export interface SourceExtractionDto {
  sourceId: string;
  title: string;
  captureKind: CaptureKind | null;
  origin: "upload" | "llm_handoff" | "manual";
  attribution: string | null;
  checksum: string;
  status: "pending" | "running" | "succeeded" | "failed";
  /** "partial" when any gap may have lost content. Null until extraction finishes. */
  completeness: "complete" | "partial" | null;
  errorCategory: string | null;
  gaps: ExtractionGapDto[];
  chunkCount: number;
  /** Author-only previews of private chunks (first 280 characters). */
  chunks: { id: string; ordinal: number; locator: string | null; preview: string }[];
}

/**
 * Completeness and gaps recorded by the extractor on the latest
 * `source.extracted` audit event (codes and messages, never extracted text).
 */
export async function latestExtractionMeta(
  tx: Executor,
  organizationId: string,
  sourceId: string,
): Promise<{ completeness?: "complete" | "partial"; gaps?: ExtractionGapDto[] }> {
  const [event] = await tx
    .select({ metadata: auditEvents.metadata })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.organizationId, organizationId),
        eq(auditEvents.targetType, "source"),
        eq(auditEvents.targetId, sourceId),
        eq(auditEvents.action, "source.extracted"),
      ),
    )
    .orderBy(desc(auditEvents.occurredAt))
    .limit(1);
  return (event?.metadata ?? {}) as { completeness?: "complete" | "partial"; gaps?: ExtractionGapDto[] };
}

const PREVIEW_CHARS = 280;
const MAX_PREVIEWS = 200;

/**
 * Extraction status, gaps and chunk previews for a private source. Only the
 * source's creator or an editor of a linked briefing; everyone else gets
 * `not_found`.
 *
 * The schema has no gaps column: the extractor records gaps (codes and
 * author-facing messages, never extracted text) on the immutable
 * `source.extracted` audit event, and the latest one is read here.
 */
export async function getSourceExtraction(db: Database, ctx: RequestContext, sourceId: string): Promise<SourceExtractionDto> {
  const c = parseCtx(ctx);
  return withAuthContext(db, { userId: c.userId, organizationId: c.organizationId, connectionId: c.connectionId }, async (tx) => {
    if (!(await canAccessSource(tx, c, sourceId))) throw new DomainError("not_found", "Source not found.");
    const [src] = await tx
      .select()
      .from(sources)
      .where(and(eq(sources.organizationId, c.organizationId), eq(sources.id, sourceId)));
    if (!src) throw new DomainError("not_found", "Source not found.");

    const chunks = await tx
      .select({ id: sourceChunks.id, ordinal: sourceChunks.ordinal, locator: sourceChunks.locator, text: sourceChunks.text })
      .from(sourceChunks)
      .where(and(eq(sourceChunks.organizationId, c.organizationId), eq(sourceChunks.sourceId, sourceId)))
      .orderBy(asc(sourceChunks.ordinal));

    const meta = await latestExtractionMeta(tx, c.organizationId, sourceId);
    const finished = src.extractionStatus === "succeeded" || src.extractionStatus === "failed";

    return {
      sourceId,
      title: src.title,
      captureKind: captureKindFromMime(src.mimeType),
      origin: SOURCE_KIND_TO_ORIGIN[src.kind] ?? "manual",
      attribution: src.attribution,
      checksum: src.checksum,
      status: src.extractionStatus as SourceExtractionDto["status"],
      completeness: finished && src.extractionStatus === "succeeded" ? (meta.completeness ?? "complete") : null,
      errorCategory: src.extractionErrorCategory,
      gaps: finished ? (meta.gaps ?? []) : [],
      chunkCount: chunks.length,
      chunks: chunks.slice(0, MAX_PREVIEWS).map((ch) => ({
        id: ch.id,
        ordinal: ch.ordinal,
        locator: ch.locator,
        preview: ch.text.length > PREVIEW_CHARS ? `${ch.text.slice(0, PREVIEW_CHARS - 1)}…` : ch.text,
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// listBriefingSources
// ---------------------------------------------------------------------------

export interface BriefingSourceDto {
  sourceId: string;
  title: string;
  captureKind: CaptureKind | null;
  origin: "upload" | "llm_handoff" | "manual";
  attribution: string | null;
  status: SourceExtractionDto["status"];
  /** "partial" when any gap may have lost content. Null until extraction succeeds. */
  completeness: "complete" | "partial" | null;
  errorCategory: string | null;
  gapCount: number;
  /** Gaps that may have lost content. */
  completenessGapCount: number;
  chunkCount: number;
  linkedAt: Date;
}

/**
 * Private sources linked to a briefing via briefing_sources, newest link
 * first, with extraction status and gap counts (no extracted text). Requires
 * `edit` or `view_draft`; users who cannot see the briefing get `not_found`.
 */
export async function listBriefingSources(db: Database, ctx: RequestContext, briefingId: string): Promise<BriefingSourceDto[]> {
  const c = parseCtx(ctx);
  if (!z.string().uuid().safeParse(briefingId).success) throw new DomainError("not_found", "Briefing not found.");
  return withAuthContext(db, { userId: c.userId, organizationId: c.organizationId, connectionId: c.connectionId }, async (tx) => {
    const caps = await getBriefingCapabilities(tx, c, briefingId);
    if (!caps.has("edit") && !caps.has("view_draft")) {
      if (!caps.has("read")) throw new DomainError("not_found", "Briefing not found.");
      throw new DomainError("forbidden", "Only collaborators can see a briefing's sources.");
    }
    const rows = await tx
      .select({
        id: sources.id,
        title: sources.title,
        kind: sources.kind,
        mimeType: sources.mimeType,
        attribution: sources.attribution,
        status: sources.extractionStatus,
        errorCategory: sources.extractionErrorCategory,
        linkedAt: briefingSources.createdAt,
        chunkCount: sql<number>`(select count(*)::int from source_chunks sc
          where sc.organization_id = ${sources.organizationId} and sc.source_id = ${sources.id})`,
      })
      .from(briefingSources)
      .innerJoin(sources, and(eq(sources.organizationId, briefingSources.organizationId), eq(sources.id, briefingSources.sourceId)))
      .where(and(eq(briefingSources.organizationId, c.organizationId), eq(briefingSources.briefingId, briefingId)))
      .orderBy(desc(briefingSources.createdAt), asc(sources.id));

    const out: BriefingSourceDto[] = [];
    for (const r of rows) {
      const status = r.status as SourceExtractionDto["status"];
      const finished = status === "succeeded" || status === "failed";
      const meta = finished ? await latestExtractionMeta(tx, c.organizationId, r.id) : {};
      const gaps = meta.gaps ?? [];
      out.push({
        sourceId: r.id,
        title: r.title,
        captureKind: captureKindFromMime(r.mimeType),
        origin: SOURCE_KIND_TO_ORIGIN[r.kind] ?? "manual",
        attribution: r.attribution,
        status,
        completeness: status === "succeeded" ? (meta.completeness ?? "complete") : null,
        errorCategory: r.errorCategory,
        gapCount: gaps.length,
        completenessGapCount: gaps.filter((g) => g.affectsCompleteness).length,
        chunkCount: Number(r.chunkCount),
        linkedAt: r.linkedAt,
      });
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// createEvidenceFromChunk
// ---------------------------------------------------------------------------

export const CreateEvidenceFromChunkInput = z.object({
  briefingId: z.string().uuid(),
  /** Draft `lock_version` the author is looking at. */
  expectedVersion: z.number().int().positive(),
  chunkId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  attribution: z.string().trim().max(300).optional(),
});
export type CreateEvidenceFromChunkInput = z.input<typeof CreateEvidenceFromChunkInput>;

export interface CreateEvidenceFromChunkResult {
  evidenceId: string;
  /** New draft lock version. */
  lockVersion: number;
  status: "candidate";
}

const MAX_EXCERPT = 5000;

/**
 * Add a private source chunk to the draft as a *candidate* EvidenceItem with
 * `sourceRef`. It is not reader evidence until the author approves it and
 * publishes (only approved excerpts reach revision_evidence).
 *
 * Optimistic concurrency: delegates the write to the briefings module's
 * `updateDraftInTx` (compare-and-increment on `lock_version`); a stale
 * `expectedVersion` raises `conflict` with `{ currentVersion }`.
 */
export async function createEvidenceFromChunk(
  db: Database,
  ctx: RequestContext,
  raw: CreateEvidenceFromChunkInput,
): Promise<CreateEvidenceFromChunkResult> {
  const c = parseCtx(ctx);
  const parsed = CreateEvidenceFromChunkInput.safeParse(raw);
  if (!parsed.success) throw new DomainError("validation", "Invalid evidence request.");
  const input = parsed.data;

  return withAuthContext(db, { userId: c.userId, organizationId: c.organizationId, connectionId: c.connectionId }, async (tx) => {
    await assertBriefingCapability(tx, c, input.briefingId, "edit");

    const [chunk] = await tx
      .select({
        id: sourceChunks.id,
        sourceId: sourceChunks.sourceId,
        text: sourceChunks.text,
        locator: sourceChunks.locator,
        sourceKind: sources.kind,
      })
      .from(sourceChunks)
      .innerJoin(sources, and(eq(sources.organizationId, sourceChunks.organizationId), eq(sources.id, sourceChunks.sourceId)))
      .innerJoin(
        briefingSources,
        and(
          eq(briefingSources.organizationId, sourceChunks.organizationId),
          eq(briefingSources.sourceId, sourceChunks.sourceId),
          eq(briefingSources.briefingId, input.briefingId),
        ),
      )
      .where(and(eq(sourceChunks.organizationId, c.organizationId), eq(sourceChunks.id, input.chunkId)));
    // Chunks of sources not linked to this briefing are indistinguishable from missing ones.
    if (!chunk) throw new DomainError("not_found", "Source excerpt not found.");

    const row = await loadDraftRow(tx, c, input.briefingId, { forUpdate: true });
    if (row.lockVersion !== input.expectedVersion) {
      throw new DomainError("conflict", "The draft has changed since you loaded it.", { currentVersion: row.lockVersion });
    }
    const current = parseStoredDraft(row.documentJson);

    const evidenceId = newId("ev");
    const excerpt = chunk.text.length > MAX_EXCERPT ? `${chunk.text.slice(0, MAX_EXCERPT - 1)}…` : chunk.text;
    const next = {
      ...current,
      evidence: [
        ...current.evidence,
        {
          id: evidenceId,
          title: input.title,
          excerpt,
          ...(input.attribution ? { attribution: input.attribution } : {}),
          ...(chunk.locator ? { locator: chunk.locator.slice(0, 200) } : {}),
          origin: SOURCE_KIND_TO_ORIGIN[chunk.sourceKind] ?? "manual",
          status: "candidate" as const,
          sourceRef: { sourceId: chunk.sourceId, chunkId: chunk.id },
        },
      ],
    };
    // Same compare-and-increment write as every other draft edit (manual or AI).
    const updated = await updateDraftInTx(tx, c, {
      briefingId: input.briefingId,
      expectedVersion: input.expectedVersion,
      document: next,
    });

    await recordAudit(tx, c, {
      action: "evidence.candidate_added",
      targetType: "briefing",
      targetId: input.briefingId,
      metadata: { evidenceKey: evidenceId, sourceId: chunk.sourceId, chunkId: chunk.id },
    });
    return { evidenceId, lockVersion: updated.draftVersion, status: "candidate" };
  });
}
