"use server";

import { redirect } from "next/navigation";
import { acceptInvitation, isDomainError } from "@cerebro/domain";
import type { ActionState } from "@/lib/action-state";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/context";
import { field, toActionError } from "@/lib/errors";
import { paths } from "@/lib/paths";

export async function acceptInvitationAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const token = field(fd, "token");
  const user = await requireUser(paths.invite(token));
  let dest: string;
  try {
    const res = await acceptInvitation(await getDb(), { token, userId: user.userId });
    dest = res.briefingSlug ? paths.briefing(res.organizationSlug, res.briefingSlug) : paths.company(res.organizationSlug);
  } catch (err) {
    if (isDomainError(err) && err.code === "not_found") {
      return { status: "error", code: "not_found", message: "This invitation is not valid. It may have expired, been revoked, or already been used." };
    }
    if (isDomainError(err) && (err.code === "forbidden" || err.code === "validation")) {
      return {
        status: "error",
        code: err.code,
        message: `This invitation was sent to a different email address than the one you are signed in with (${user.email}). Sign in with the invited address.`,
      };
    }
    return toActionError(err);
  }
  redirect(dest);
}
