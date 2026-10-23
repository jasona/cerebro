"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  changeAudience,
  createShareLink,
  grantAccess,
  isDomainError,
  moveBriefingHome,
  revokeGrant,
  revokeShareLink,
  type AudienceSpec,
  type GrantableRole,
  type HomeSpec,
} from "@cerebro/domain";
import { briefingPaths } from "@/lib/paths";
import type { ActionState } from "@/lib/action-state";
import { getBriefingRequestContext } from "@/lib/context";
import { appUrl } from "@/lib/env";
import { field, runAction } from "@/lib/errors";

/** "company" | "department:<id>" | "team:<id>" | "restricted" → AudienceSpec. */
function parseAudience(v: string): AudienceSpec | null {
  if (v === "company" || v === "restricted") return { visibility: v };
  const [kind, id] = v.split(":");
  if (kind === "department" && id) return { visibility: "department", departmentId: id };
  if (kind === "team" && id) return { visibility: "team", teamId: id };
  return null;
}

/** "" (company) | "d:<id>" | "t:<id>" → HomeSpec. */
function parseHome(v: string): HomeSpec {
  if (v.startsWith("t:")) return { teamId: v.slice(2) };
  if (v.startsWith("d:")) return { departmentId: v.slice(2) };
  return {};
}

const ctxFor = (fd: FormData) => getBriefingRequestContext(field(fd, "company"), field(fd, "briefing"));
const revalidate = (fd: FormData) => revalidatePath(briefingPaths.access(field(fd, "company"), field(fd, "briefing")));

/** Confirmed audience change (the page showed before/after first). */
export async function changeAudienceAction(fd: FormData): Promise<void> {
  const company = field(fd, "company");
  const briefing = field(fd, "briefing");
  let target: string;
  try {
    const audience = parseAudience(field(fd, "audience"));
    if (!audience) {
      target = briefingPaths.access(company, briefing, { error: "validation" });
    } else {
      const rc = await getBriefingRequestContext(company, briefing);
      await changeAudience(rc.db, rc.ctx, { briefingId: field(fd, "briefingId"), audience });
      revalidatePath(briefingPaths.reader(company, briefing));
      target = briefingPaths.access(company, briefing, { saved: "audience" });
    }
  } catch (err) {
    if (!isDomainError(err)) throw err;
    target = briefingPaths.access(company, briefing, { error: err.code });
  }
  redirect(target);
}

export async function moveHomeAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async () => {
    const rc = await ctxFor(fd);
    const res = await moveBriefingHome(rc.db, rc.ctx, { briefingId: field(fd, "briefingId"), home: parseHome(field(fd, "home")) });
    revalidate(fd);
    return { status: "ok", message: `Moved to ${res.home.label}. The audience is unchanged.` };
  });
}

export async function grantAccessAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async () => {
    const role = field(fd, "role") as GrantableRole;
    const email = field(fd, "email");
    if (!email) return { status: "error", code: "validation", message: "Enter an email address." };
    const rev = Number(field(fd, "revisionNumber"));
    const rc = await ctxFor(fd);
    const g = await grantAccess(rc.db, rc.ctx, {
      briefingId: field(fd, "briefingId"),
      email,
      role,
      ...(role === "reader" && Number.isInteger(rev) && rev > 0 ? { revisionNumber: rev } : {}),
    });
    revalidate(fd);
    return { status: "ok", message: `${g.displayName} is now a ${g.role}${g.revisionNumber ? ` for version ${g.revisionNumber} only` : ""}.` };
  });
}

export async function revokeGrantAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async () => {
    const rc = await ctxFor(fd);
    await revokeGrant(rc.db, rc.ctx, { briefingId: field(fd, "briefingId"), grantId: field(fd, "grantId") });
    revalidate(fd);
    return { status: "ok", message: "Access revoked." };
  });
}

export async function createShareLinkAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async () => {
    const pinned = Number(field(fd, "pinned"));
    const expires = field(fd, "expiresAt");
    let expiresAt: Date | undefined;
    if (expires) {
      // End of the chosen day, server local time.
      expiresAt = new Date(`${expires}T23:59:59`);
      if (Number.isNaN(expiresAt.getTime())) return { status: "error", code: "validation", message: "Enter a valid expiry date." };
    }
    const rc = await ctxFor(fd);
    const res = await createShareLink(rc.db, rc.ctx, {
      briefingId: field(fd, "briefingId"),
      ...(Number.isInteger(pinned) && pinned > 0 ? { pinnedRevisionNumber: pinned } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    });
    revalidate(fd);
    return {
      status: "ok",
      message: res.pinnedRevisionNumber ? `Pinned link to version ${res.pinnedRevisionNumber} created.` : "Stable link created.",
      secret: {
        label: "Share link",
        value: `${appUrl()}${res.path}`,
        hint: "Copy it now: it is shown only once. Opening it requires signing in, and only people who already have access can read the briefing.",
      },
    };
  });
}

export async function revokeShareLinkAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async () => {
    const rc = await ctxFor(fd);
    await revokeShareLink(rc.db, rc.ctx, { briefingId: field(fd, "briefingId"), shareLinkId: field(fd, "shareLinkId") });
    revalidate(fd);
    return { status: "ok", message: "Link revoked. Direct grants are unchanged." };
  });
}
