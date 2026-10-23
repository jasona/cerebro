"use server";

import { revalidatePath } from "next/cache";
import type { DocumentIssue } from "@cerebro/briefing-schema";
import { composeDraftFromSource, createEvidenceFromChunk, isDomainError, updateDraft } from "@cerebro/domain";
import { getBriefingRequestContext } from "@/lib/context";
import { errorMessage } from "@/lib/errors";
import { paths } from "@/lib/paths";

export type SaveOutcome =
  | { status: "saved"; version: number; issues: DocumentIssue[] }
  | { status: "conflict"; currentVersion: number | null }
  | { status: "invalid"; message: string; issues: DocumentIssue[] }
  | { status: "error"; message: string };

function toOutcome(err: unknown): SaveOutcome {
  if (isDomainError(err)) {
    const d = err.details as { currentVersion?: number; issues?: unknown } | undefined;
    if (err.code === "conflict") return { status: "conflict", currentVersion: typeof d?.currentVersion === "number" ? d.currentVersion : null };
    if (err.code === "validation") {
      const issues = Array.isArray(d?.issues) ? (d.issues as DocumentIssue[]).filter((i) => i && typeof i.message === "string") : [];
      return { status: "invalid", message: err.message || errorMessage("validation"), issues };
    }
    return { status: "error", message: errorMessage(err.code) };
  }
  throw err;
}

/**
 * Save the whole draft document with optimistic concurrency. The server
 * validates the document; a stale `expectedVersion` returns `conflict` and
 * nothing is written.
 */
export async function saveDraftAction(input: {
  company: string;
  briefing: string;
  briefingId: string;
  expectedVersion: number;
  document: unknown;
}): Promise<SaveOutcome> {
  try {
    const rc = await getBriefingRequestContext(input.company, input.briefing);
    const res = await updateDraft(rc.db, rc.ctx, {
      briefingId: input.briefingId,
      expectedVersion: input.expectedVersion,
      document: input.document,
    });
    revalidatePath(paths.briefingPreview(input.company, input.briefing));
    return { status: "saved", version: res.draftVersion, issues: res.issues };
  } catch (err) {
    return toOutcome(err);
  }
}

/** Turn a private source chunk into a *candidate* evidence item on the draft (never approved on arrival). */
export async function addChunkEvidenceAction(input: {
  company: string;
  briefing: string;
  briefingId: string;
  expectedVersion: number;
  chunkId: string;
  title: string;
  attribution?: string;
}): Promise<SaveOutcome> {
  try {
    const rc = await getBriefingRequestContext(input.company, input.briefing);
    const res = await createEvidenceFromChunk(rc.db, rc.ctx, {
      briefingId: input.briefingId,
      expectedVersion: input.expectedVersion,
      chunkId: input.chunkId,
      title: input.title,
      ...(input.attribution ? { attribution: input.attribution } : {}),
    });
    revalidatePath(paths.briefingEdit(input.company, input.briefing));
    return { status: "saved", version: res.lockVersion, issues: [] };
  } catch (err) {
    return toOutcome(err);
  }
}

export type ComposeOutcome =
  | { status: "composed"; version: number; gaps: string[]; evidenceAdded: number }
  /** The draft has content; ask the author to confirm replacing it. */
  | { status: "needs_confirmation"; currentVersion: number | null }
  | { status: "conflict"; currentVersion: number | null }
  | { status: "not_ready"; message: string }
  | { status: "error"; message: string };

/**
 * Compose the draft from an extracted source (deterministic; passages become
 * candidate evidence). Replaces only the untouched blank template unless the
 * author confirmed `replace`. Optimistic concurrency on `expectedVersion`.
 */
export async function composeFromSourceAction(input: {
  company: string;
  briefing: string;
  briefingId: string;
  expectedVersion: number;
  sourceId: string;
  replace?: boolean;
}): Promise<ComposeOutcome> {
  try {
    const rc = await getBriefingRequestContext(input.company, input.briefing);
    const res = await composeDraftFromSource(rc.db, rc.ctx, {
      briefingId: input.briefingId,
      expectedVersion: input.expectedVersion,
      sourceId: input.sourceId,
      ...(input.replace ? { replace: true } : {}),
    });
    revalidatePath(paths.briefingEdit(input.company, input.briefing));
    revalidatePath(paths.briefingPreview(input.company, input.briefing));
    return { status: "composed", version: res.draftVersion, gaps: res.gaps.slice(0, 10), evidenceAdded: res.evidenceAdded };
  } catch (err) {
    if (!isDomainError(err)) throw err;
    const d = err.details as { currentVersion?: unknown; reasons?: unknown } | undefined;
    const currentVersion = typeof d?.currentVersion === "number" ? d.currentVersion : null;
    const reasons = Array.isArray(d?.reasons) ? d.reasons : [];
    if (err.code === "conflict") {
      return reasons.includes("draft_not_blank") ? { status: "needs_confirmation", currentVersion } : { status: "conflict", currentVersion };
    }
    if (err.code === "validation" && reasons.length) return { status: "not_ready", message: err.message };
    return { status: "error", message: errorMessage(err.code) };
  }
}
