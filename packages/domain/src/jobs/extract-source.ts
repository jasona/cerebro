import { extractSource, type OcrOptions } from "@cerebro/capture";
import { briefingDrafts, briefingSources, sourceChunks, sources, withAuthContext, type Database, type Job } from "@cerebro/database";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit";
import { composeDraftFromSource } from "../sources/compose";
import { canAccessSource, captureKindFromMime } from "../sources/sources";
import { getSourceStore, sha256Hex } from "../sources/store";
import { JobError, permanent, requireJobOrg, workerContext } from "./errors";

/**
 * OCR settings for extraction jobs (scanned PDF pages and images), read from the
 * environment. OCR runs locally with bundled English data by default.
 *
 * - `CEREBRO_OCR=off` turns OCR off (pages and images are reported as gaps).
 * - `CEREBRO_OCR_LANGUAGES` is a comma-separated list of Tesseract codes (default `eng`).
 *   Languages other than English need their traineddata in `CEREBRO_OCR_LANG_PATH`.
 * - `CEREBRO_OCR_LANG_PATH` is a local directory of `<lang>.traineddata.gz` files (never a URL).
 */
export function ocrOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): OcrOptions {
  const options: OcrOptions = {};
  if (["off", "false", "0"].includes((env.CEREBRO_OCR ?? "").trim().toLowerCase())) options.enabled = false;
  const languages = env.CEREBRO_OCR_LANGUAGES?.split(",").map((l) => l.trim()).filter(Boolean);
  if (languages?.length) options.languages = languages;
  const langPath = env.CEREBRO_OCR_LANG_PATH?.trim();
  if (langPath) options.langPath = langPath;
  return options;
}

const Payload = z.object({ sourceId: z.string().uuid(), requestedBy: z.string().uuid() });

const setStatus = (status: "running" | "succeeded" | "failed", errorCategory: string | null = null) => ({
  extractionStatus: status,
  extractionErrorCategory: errorCategory,
  updatedAt: sql`now()`,
});

/**
 * Extract a private source into `source_chunks` with locators.
 *
 * Runs as the requesting user in the job's organization and rechecks source
 * access. Extracted text is untrusted, private authoring material: it is
 * stored only in source_chunks and never logged; gaps (codes and messages,
 * which never contain extracted text) go on the `source.extracted` audit event.
 *
 * Scanned PDF pages and images are read by local OCR here, in the job, never in
 * a request handler. OCR is bounded by per-page and per-source time limits and
 * reports failures as gaps, so a bad scan cannot fail or hang the job.
 */
export async function handleExtractSource(db: Database, job: Job): Promise<void> {
  requireJobOrg(job);
  const parsed = Payload.safeParse(job.payload);
  if (!parsed.success) throw permanent("invalid_payload");
  const { sourceId, requestedBy } = parsed.data;
  const ctx = workerContext(job, requestedBy);
  const auth = { userId: ctx.userId, organizationId: ctx.organizationId };

  const src = await withAuthContext(db, auth, async (tx) => {
    if (!(await canAccessSource(tx, ctx, sourceId))) throw permanent("forbidden");
    const [row] = await tx
      .select()
      .from(sources)
      .where(and(eq(sources.organizationId, ctx.organizationId), eq(sources.id, sourceId)));
    if (!row) throw permanent("source_not_found");
    await tx.update(sources).set(setStatus("running")).where(eq(sources.id, sourceId));
    return row;
  });

  const kind = captureKindFromMime(src.mimeType);
  const fail = async (category: string) => {
    await withAuthContext(db, auth, async (tx) => {
      await tx.update(sources).set(setStatus("failed", category)).where(eq(sources.id, sourceId));
      await recordAudit(tx, ctx, {
        action: "source.extracted",
        targetType: "source",
        targetId: sourceId,
        metadata: { status: "failed", errorCategory: category, gaps: [] },
      });
    });
  };
  if (!kind) {
    await fail("unsupported_format");
    return;
  }

  let input: { kind: typeof kind; text?: string; bytes?: Uint8Array };
  if (src.objectKey) {
    let bytes: Uint8Array;
    try {
      bytes = await getSourceStore().get(src.objectKey);
    } catch {
      // Storage may be temporarily unavailable: retry with backoff.
      throw new JobError("storage_unavailable", true);
    }
    if (`sha256:${sha256Hex(bytes)}` !== src.checksum) {
      await fail("checksum_mismatch");
      return;
    }
    input = { kind, bytes };
  } else {
    const text = src.textContent ?? "";
    if (`sha256:${sha256Hex(text)}` !== src.checksum) {
      await fail("checksum_mismatch");
      return;
    }
    input = { kind, text };
  }

  const result = await extractSource(input, { ocr: ocrOptionsFromEnv() });
  if (result.status === "failed") {
    await fail(result.errorCategory ?? "extraction_error");
    return;
  }

  await withAuthContext(db, auth, async (tx) => {
    // Recheck: access may have been removed while extraction ran.
    if (!(await canAccessSource(tx, ctx, sourceId))) throw permanent("forbidden");
    await tx
      .delete(sourceChunks)
      .where(and(eq(sourceChunks.organizationId, ctx.organizationId), eq(sourceChunks.sourceId, sourceId)));
    if (result.chunks.length) {
      await tx.insert(sourceChunks).values(
        result.chunks.map((ch) => ({
          organizationId: ctx.organizationId,
          sourceId,
          ordinal: ch.ordinal,
          text: ch.text,
          locator: ch.locator.label,
        })),
      );
    }
    await tx.update(sources).set(setStatus("succeeded")).where(eq(sources.id, sourceId));
    await recordAudit(tx, ctx, {
      action: "source.extracted",
      targetType: "source",
      targetId: sourceId,
      metadata: {
        status: "succeeded",
        completeness: result.status,
        chunkCount: result.chunks.length,
        characters: result.stats.characters,
        ...(result.stats.ocrPages ? { ocrPages: result.stats.ocrPages } : {}),
        gaps: result.gaps.map((g) => ({
          code: g.code,
          message: g.message,
          locator: g.locator?.label ?? null,
          affectsCompleteness: g.affectsCompleteness,
        })),
      },
    });
  });

  // The extraction succeeded; composing is best-effort and must never fail (and retry) the job.
  await composeRequestedDrafts(db, ctx, sourceId).catch(() => undefined);
}

/**
 * Uploads that asked for it (`usage.composeDraft`) get their draft composed
 * from the extracted source, but only while the draft is still the untouched
 * blank template; any author content, or a concurrent edit, wins and the
 * author can use "Draft from this source" instead. Best-effort: failures
 * never fail the extraction job.
 */
async function composeRequestedDrafts(db: Database, ctx: ReturnType<typeof workerContext>, sourceId: string): Promise<void> {
  const auth = { userId: ctx.userId, organizationId: ctx.organizationId };
  const targets = await withAuthContext(db, auth, (tx) =>
    tx
      .select({ briefingId: briefingSources.briefingId, lockVersion: briefingDrafts.lockVersion })
      .from(briefingSources)
      .innerJoin(
        briefingDrafts,
        and(eq(briefingDrafts.organizationId, briefingSources.organizationId), eq(briefingDrafts.briefingId, briefingSources.briefingId)),
      )
      .where(
        and(
          eq(briefingSources.organizationId, ctx.organizationId),
          eq(briefingSources.sourceId, sourceId),
          sql`${briefingSources.usage}->>'composeDraft' = 'true'`,
        ),
      ),
  );
  for (const t of targets) {
    try {
      await composeDraftFromSource(db, ctx, { briefingId: t.briefingId, expectedVersion: t.lockVersion, sourceId });
    } catch {
      // conflict (draft has content / changed), forbidden, validation: leave the draft alone.
    }
  }
}
