"use server";

import { askQuestion, isDomainError, submitFeedback, type AskQuestionResult, type DomainErrorCode, type FeedbackType } from "@cerebro/domain";
import type { ActionState } from "@/lib/action-state";
import { getBriefingRequestContext } from "@/lib/context";
import { errorMessage, field, runAction } from "@/lib/errors";

/* Reader actions. Every call resolves the context server-side; the domain authorizes the exact revision. */

export interface AskInput {
  company: string;
  briefing: string;
  briefingId: string;
  /** The revision on screen. Answers are grounded only in this revision. */
  revisionNumber: number;
  question: string;
  focusBlockId?: string;
  perspectiveId?: string;
  threadId?: string;
}

export type AskOutcome =
  | { ok: true; result: AskQuestionResult }
  | { ok: false; code: DomainErrorCode | "unknown"; message: string; threadMismatch?: boolean };

export async function askAction(input: AskInput): Promise<AskOutcome> {
  try {
    const rc = await getBriefingRequestContext(input.company, input.briefing);
    const result = await askQuestion(rc.db, rc.ctx, {
      briefingId: input.briefingId,
      revisionNumber: input.revisionNumber,
      question: input.question,
      ...(input.focusBlockId ? { focusBlockId: input.focusBlockId } : {}),
      ...(input.perspectiveId ? { perspectiveId: input.perspectiveId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
    });
    return { ok: true, result };
  } catch (err) {
    if (isDomainError(err)) {
      const reason = (err.details as { reason?: string } | undefined)?.reason;
      if (err.code === "conflict" && reason === "thread_revision_mismatch") {
        return { ok: false, code: err.code, message: "That conversation belongs to a different version.", threadMismatch: true };
      }
      return { ok: false, code: err.code, message: err.code === "validation" ? "Enter a question of up to 2,000 characters." : errorMessage(err.code) };
    }
    throw err;
  }
}

export interface SendToAuthorInput {
  company: string;
  briefing: string;
  briefingId: string;
  revisionNumber: number;
  text: string;
  blockId?: string;
  fromThreadId?: string;
}

/** Explicit, attributed submission of a question the briefing could not answer. Only the question text is sent. */
export async function sendQuestionToAuthorAction(input: SendToAuthorInput): Promise<ActionState> {
  return runAction(async () => {
    const rc = await getBriefingRequestContext(input.company, input.briefing);
    await submitFeedback(rc.db, rc.ctx, {
      briefingId: input.briefingId,
      revisionNumber: input.revisionNumber,
      type: "question",
      text: input.text,
      ...(input.blockId ? { blockId: input.blockId } : {}),
      ...(input.fromThreadId ? { fromThreadId: input.fromThreadId } : {}),
    });
    return { status: "ok", message: "Sent to the author with your name. Your conversation stays private." };
  });
}

const FEEDBACK_FORM_TYPES: FeedbackType[] = ["comment", "concern", "correction"];

/** Reader feedback form: comment / concern / correction on the whole briefing or one block. */
export async function submitFeedbackAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async () => {
    const type = field(fd, "type") as FeedbackType;
    if (!FEEDBACK_FORM_TYPES.includes(type)) return { status: "error", code: "validation", message: "Choose comment, concern or correction." };
    const text = field(fd, "text");
    if (!text) return { status: "error", code: "validation", message: "Write your feedback before sending it." };
    const revisionNumber = Number(field(fd, "revisionNumber"));
    const blockId = field(fd, "blockId");
    const rc = await getBriefingRequestContext(field(fd, "company"), field(fd, "briefing"));
    await submitFeedback(rc.db, rc.ctx, {
      briefingId: field(fd, "briefingId"),
      revisionNumber,
      type,
      text,
      ...(blockId ? { blockId } : {}),
    });
    return { status: "ok", message: `Sent to the author with your name, for version ${revisionNumber}.` };
  });
}
