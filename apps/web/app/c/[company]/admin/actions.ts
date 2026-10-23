"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  addDepartmentMember,
  addTeamMember,
  archiveDepartment,
  archiveTeam,
  changeMemberRole,
  createDepartment,
  createInvitation,
  createTeam,
  removeDepartmentMember,
  removeMembership,
  removeTeamMember,
  renameDepartment,
  renameTeam,
  reparentTeam,
  revokeInvitation,
  type CompanyRole,
} from "@cerebro/domain";
import type { ActionState } from "@/lib/action-state";
import { getRequestContext } from "@/lib/context";
import { appUrl } from "@/lib/env";
import { field, runAction, toActionError } from "@/lib/errors";
import { paths } from "@/lib/paths";

/*
 * Admin server actions. Each resolves the caller's context from the company
 * slug and delegates to the domain service, which enforces owner/admin (D09)
 * and audits. The UI hiding controls is a convenience, not the boundary.
 */

async function ctxFor(fd: FormData) {
  const company = field(fd, "company");
  const ws = await getRequestContext(company);
  return { ...ws, company };
}

function refresh(company: string) {
  revalidatePath(paths.admin(company));
  revalidatePath(`/c/${encodeURIComponent(company)}`, "layout");
}

export async function createDepartmentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { db, ctx, company } = await ctxFor(fd);
    const d = await createDepartment(db, ctx, { name: field(fd, "name") });
    refresh(company);
    return { status: "ok", message: `Created ${d.name}.` };
  });
}

export async function renameDepartmentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { db, ctx, company } = await ctxFor(fd);
    await renameDepartment(db, ctx, { departmentId: field(fd, "departmentId"), name: field(fd, "name") });
    refresh(company);
    return { status: "ok", message: "Renamed." };
  });
}

export async function archiveDepartmentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { db, ctx, company } = await ctxFor(fd);
    await archiveDepartment(db, ctx, { departmentId: field(fd, "departmentId") });
    refresh(company);
    return { status: "ok", message: "Archived. Briefings homed here keep their provenance." };
  });
}

export async function createTeamAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { db, ctx, company } = await ctxFor(fd);
    const t = await createTeam(db, ctx, { departmentId: field(fd, "departmentId"), name: field(fd, "name") });
    refresh(company);
    return { status: "ok", message: `Created ${t.name}.` };
  });
}

export async function renameTeamAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { db, ctx, company } = await ctxFor(fd);
    await renameTeam(db, ctx, { teamId: field(fd, "teamId"), name: field(fd, "name") });
    refresh(company);
    return { status: "ok", message: "Renamed." };
  });
}

export async function archiveTeamAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { db, ctx, company } = await ctxFor(fd);
    await archiveTeam(db, ctx, { teamId: field(fd, "teamId") });
    refresh(company);
    return { status: "ok", message: "Archived. Briefings homed here keep their provenance." };
  });
}

/** Confirm step of the reparent flow (the preview is rendered by the page). */
export async function reparentTeamAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let company = "";
  try {
    const ws = await ctxFor(fd);
    company = ws.company;
    await reparentTeam(ws.db, ws.ctx, { teamId: field(fd, "teamId"), newDepartmentId: field(fd, "newDepartmentId") });
    refresh(company);
  } catch (err) {
    return toActionError(err);
  }
  redirect(paths.admin(company, { tab: "structure", notice: "moved" }));
}

export async function changeRoleAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { db, ctx, company } = await ctxFor(fd);
    await changeMemberRole(db, ctx, { userId: field(fd, "userId"), role: field(fd, "role") as CompanyRole });
    refresh(company);
    return { status: "ok", message: "Role updated." };
  });
}

export async function addTeamMemberAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { db, ctx, company } = await ctxFor(fd);
    await addTeamMember(db, ctx, { teamId: field(fd, "teamId"), userId: field(fd, "userId") });
    refresh(company);
    return { status: "ok", message: "Added to team." };
  });
}

export async function removeTeamMemberAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { db, ctx, company } = await ctxFor(fd);
    await removeTeamMember(db, ctx, { teamId: field(fd, "teamId"), userId: field(fd, "userId") });
    refresh(company);
    return { status: "ok", message: "Removed from team." };
  });
}

export async function addDepartmentMemberAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { db, ctx, company } = await ctxFor(fd);
    await addDepartmentMember(db, ctx, { departmentId: field(fd, "departmentId"), userId: field(fd, "userId") });
    refresh(company);
    return { status: "ok", message: "Added to department." };
  });
}

export async function removeDepartmentMemberAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { db, ctx, company } = await ctxFor(fd);
    await removeDepartmentMember(db, ctx, { departmentId: field(fd, "departmentId"), userId: field(fd, "userId") });
    refresh(company);
    return { status: "ok", message: "Removed from department." };
  });
}

export async function removeMembershipAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { db, ctx, company } = await ctxFor(fd);
    await removeMembership(db, ctx, { userId: field(fd, "userId") });
    refresh(company);
    return { status: "ok", message: "Removed from the company. Their access ends on their next request." };
  });
}

export async function createInvitationAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { db, ctx, company } = await ctxFor(fd);
    const role = field(fd, "role") === "admin" ? "admin" : "member";
    const { invitation, token } = await createInvitation(db, ctx, { kind: "membership", email: field(fd, "email"), role });
    refresh(company);
    return {
      status: "ok",
      message: `Invitation created for ${invitation.email}.`,
      secret: {
        label: "Invitation link",
        value: `${appUrl()}${paths.invite(token)}`,
        hint: "Copy this link now and send it to the person directly. It is shown only once and cannot be retrieved later. It expires in 14 days and only works for that email address.",
      },
    };
  });
}

export async function revokeInvitationAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async () => {
    const { db, ctx, company } = await ctxFor(fd);
    await revokeInvitation(db, ctx, { invitationId: field(fd, "invitationId") });
    refresh(company);
    return { status: "ok", message: "Invitation revoked." };
  });
}
