"use server";

import { revalidatePath } from "next/cache";
import { FEEDBACK_STATUSES, requestTopicSummary, resolveFeedback, type FeedbackStatus } from "@cerebro/domain";
import { briefingPaths } from "@/lib/paths";
import type { ActionState } from "@/lib/action-state";
import { getBriefingRequestContext } from "@/lib/context";
import { field, runAction } from "@/lib/errors";

export async function resolveFeedbackAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async () => {
    const company = field(fd, "company");
    const briefing = field(fd, "briefing");
    const status = field(fd, "status") as FeedbackStatus;
    if (!FEEDBACK_STATUSES.includes(status)) return { status: "error", code: "validation", message: "Choose a status." };
    const rev = Number(field(fd, "resolutionRevision"));
    const rc = await getBriefingRequestContext(company, briefing);
    await resolveFeedback(rc.db, rc.ctx, {
      feedbackId: field(fd, "feedbackId"),
      status,
      ...(Number.isInteger(rev) && rev > 0 ? { resolutionRef: { revisionNumber: rev } } : {}),
    });
    revalidatePath(briefingPaths.engagement(company, briefing));
    return { status: "ok", message: "Feedback updated." };
  });
}

export async function requestTopicSummaryAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async () => {
    const company = field(fd, "company");
    const briefing = field(fd, "briefing");
    const rc = await getBriefingRequestContext(company, briefing);
    const res = await requestTopicSummary(rc.db, rc.ctx, field(fd, "briefingId"));
    revalidatePath(briefingPaths.engagement(company, briefing));
    return {
      status: "ok",
      message: res.created
        ? `Topic summary requested for version ${res.revisionNumber}. It runs in the background; refresh in a minute.`
        : `A summary for version ${res.revisionNumber} with the current questions is already queued or complete.`,
    };
  });
}
