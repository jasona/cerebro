"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isDomainError, publishBriefing, setEvidenceStatus } from "@cerebro/domain";
import { briefingPaths } from "@/lib/paths";
import { getBriefingRequestContext } from "@/lib/context";
import { field } from "@/lib/errors";

const STATUSES = new Set(["approved", "excluded", "candidate"]);

/**
 * Publish exactly the reviewed preview. One explicit author action; the
 * idempotency key was generated when the preview page rendered, so a retried
 * submit returns the original result instead of a second release.
 */
export async function publishAction(fd: FormData): Promise<void> {
  const company = field(fd, "company");
  const briefing = field(fd, "briefing");
  const changeSummary = field(fd, "changeSummary");
  let target: string;
  try {
    const rc = await getBriefingRequestContext(company, briefing);
    const res = await publishBriefing(rc.db, rc.ctx, {
      briefingId: field(fd, "briefingId"),
      previewId: field(fd, "previewId"),
      ...(changeSummary ? { changeSummary: changeSummary.slice(0, 2000) } : {}),
      idempotencyKey: field(fd, "idempotencyKey"),
    });
    revalidatePath(briefingPaths.reader(company, briefing));
    target = briefingPaths.reader(company, briefing, { published: res.revisionNumber });
  } catch (err) {
    if (!isDomainError(err)) throw err;
    if (err.code === "stale_preview") {
      const reasons = (err.details as { reasons?: unknown } | undefined)?.reasons;
      const list = Array.isArray(reasons) ? reasons.filter((r): r is string => typeof r === "string").join(",") : "";
      target = briefingPaths.preview(company, briefing, { stale: list || "unknown" });
    } else {
      target = briefingPaths.preview(company, briefing, { error: err.code });
    }
  }
  redirect(target);
}

/** Approve / exclude / reset one evidence candidate from the review panel. Changes the draft, so a fresh preview follows. */
export async function setEvidenceStatusAction(fd: FormData): Promise<void> {
  const company = field(fd, "company");
  const briefing = field(fd, "briefing");
  const status = field(fd, "status");
  let target = briefingPaths.preview(company, briefing);
  try {
    if (!STATUSES.has(status)) throw new Error("bad status");
    const rc = await getBriefingRequestContext(company, briefing);
    await setEvidenceStatus(rc.db, rc.ctx, {
      briefingId: field(fd, "briefingId"),
      expectedVersion: Number(field(fd, "expectedVersion")),
      evidenceId: field(fd, "evidenceId"),
      status: status as "approved" | "excluded" | "candidate",
    });
    target = briefingPaths.preview(company, briefing, { updated: field(fd, "evidenceId") });
  } catch (err) {
    if (isDomainError(err)) target = briefingPaths.preview(company, briefing, { error: err.code });
    else if (err instanceof Error && err.message === "bad status") target = briefingPaths.preview(company, briefing, { error: "validation" });
    else throw err;
  }
  redirect(target);
}
