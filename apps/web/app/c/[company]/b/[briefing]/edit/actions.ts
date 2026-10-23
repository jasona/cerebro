"use server";

import { revalidatePath } from "next/cache";
import type { DocumentIssue } from "@cerebro/briefing-schema";
import {
  acceptSuggestion,
  composeDraftFromSource,
  createEvidenceFromChunk,
  dismissSuggestion,
  isDomainError,
  requestPerspectiveSuggestions,
  requestRevisionProposal,
  updateDraft,
  type RevisionProposalResult,
} from "@cerebro/domain";
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

// ---------------------------------------------------------------------------
// AI-assisted proposals (W3.3). Suggestions are stored for review; only
// accepting one changes the draft, with the same expectedVersion check.
// ---------------------------------------------------------------------------

type Target = { company: string; briefing: string; briefingId: string };

export type SuggestOutcome =
  | { status: "suggested" | "none" | "unavailable"; count: number; notes?: string }
  | { status: "error"; message: string };

export async function suggestPerspectivesAction(input: Target): Promise<SuggestOutcome> {
  try {
    const rc = await getBriefingRequestContext(input.company, input.briefing);
    const res = await requestPerspectiveSuggestions(rc.db, rc.ctx, { briefingId: input.briefingId });
    revalidatePath(paths.briefingEdit(input.company, input.briefing));
    return { status: res.status, count: res.suggestions.length, ...(res.notes ? { notes: res.notes } : {}) };
  } catch (err) {
    if (isDomainError(err)) return { status: "error", message: errorMessage(err.code) };
    throw err;
  }
}

export type ProposalOutcome =
  | { status: RevisionProposalResult["status"]; explanation?: string }
  | { status: "error"; message: string };

export async function requestProposalAction(input: Target & { instruction: string }): Promise<ProposalOutcome> {
  try {
    const rc = await getBriefingRequestContext(input.company, input.briefing);
    const res = await requestRevisionProposal(rc.db, rc.ctx, { briefingId: input.briefingId, instruction: input.instruction });
    revalidatePath(paths.briefingEdit(input.company, input.briefing));
    return { status: res.status, ...(res.explanation ? { explanation: res.explanation } : {}) };
  } catch (err) {
    if (isDomainError(err)) return { status: "error", message: err.code === "validation" ? "Write an instruction first." : errorMessage(err.code) };
    throw err;
  }
}

export type DecideOutcome =
  | { status: "accepted"; version: number; issues: DocumentIssue[] }
  | { status: "dismissed" }
  | { status: "conflict"; currentVersion: number | null; stale: boolean; message: string }
  | { status: "invalid"; message: string }
  | { status: "error"; message: string };

function decideError(err: unknown): DecideOutcome {
  if (!isDomainError(err)) throw err;
  const d = err.details as { currentVersion?: unknown; reason?: unknown; messages?: unknown } | undefined;
  if (err.code === "conflict") {
    return {
      status: "conflict",
      currentVersion: typeof d?.currentVersion === "number" ? d.currentVersion : null,
      stale: d?.reason === "suggestion_stale",
      message: d?.reason === "suggestion_decided" ? "This suggestion was already accepted or dismissed." : err.message,
    };
  }
  if (err.code === "validation") {
    const messages = Array.isArray(d?.messages) ? d.messages.filter((m): m is string => typeof m === "string").slice(0, 5) : [];
    return { status: "invalid", message: [err.message, ...messages].join(" ").slice(0, 1000) };
  }
  return { status: "error", message: errorMessage(err.code) };
}

export async function acceptSuggestionAction(input: Target & { suggestionId: string; expectedVersion: number }): Promise<DecideOutcome> {
  try {
    const rc = await getBriefingRequestContext(input.company, input.briefing);
    const res = await acceptSuggestion(rc.db, rc.ctx, {
      briefingId: input.briefingId,
      suggestionId: input.suggestionId,
      expectedVersion: input.expectedVersion,
    });
    revalidatePath(paths.briefingEdit(input.company, input.briefing));
    revalidatePath(paths.briefingPreview(input.company, input.briefing));
    return { status: "accepted", version: res.draftVersion, issues: res.issues };
  } catch (err) {
    return decideError(err);
  }
}

export async function dismissSuggestionAction(input: Target & { suggestionId: string }): Promise<DecideOutcome> {
  try {
    const rc = await getBriefingRequestContext(input.company, input.briefing);
    await dismissSuggestion(rc.db, rc.ctx, { briefingId: input.briefingId, suggestionId: input.suggestionId });
    revalidatePath(paths.briefingEdit(input.company, input.briefing));
    return { status: "dismissed" };
  } catch (err) {
    return decideError(err);
  }
}
