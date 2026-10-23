"use server";

import { revalidatePath } from "next/cache";
import { createConnectionToken, revokeConnection, setAuthoringPreferences } from "@cerebro/domain";
import type { ActionState } from "@/lib/action-state";
import { getRequestContext } from "@/lib/context";
import { appUrl } from "@/lib/env";
import { field, runAction } from "@/lib/errors";
import { paths } from "@/lib/paths";

/* Settings actions act on the caller's own account only; the domain enforces it. */

export async function createConnectionTokenAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async () => {
    const company = field(fd, "company");
    const { db, ctx } = await getRequestContext(company);
    const { connection, token } = await createConnectionToken(db, ctx, { label: field(fd, "label") });
    revalidatePath(paths.settings(company));
    return {
      status: "ok",
      message: `Connection “${connection.label}” created.`,
      secret: {
        label: "Development connection token",
        value: token,
        hint: `Copy it now: it is shown only once. Configure your MCP client with the endpoint ${appUrl()}/api/mcp and send the token as "Authorization: Bearer <token>". Revoke it here if it is ever exposed.`,
      },
    };
  });
}

export async function revokeConnectionAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async () => {
    const company = field(fd, "company");
    const { db, ctx } = await getRequestContext(company);
    await revokeConnection(db, ctx, { connectionId: field(fd, "connectionId") });
    revalidatePath(paths.settings(company));
    return { status: "ok", message: "Connection revoked. Its token stops working immediately." };
  });
}

export async function savePreferencesAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return runAction(async () => {
    const company = field(fd, "company");
    const { db, ctx } = await getRequestContext(company);
    const home = field(fd, "home");
    const style = field(fd, "style");
    const homeInput =
      home.startsWith("t:")
        ? { defaultTeamId: home.slice(2) }
        : home.startsWith("d:")
          ? { defaultDepartmentId: home.slice(2), defaultTeamId: null }
          : { defaultDepartmentId: null, defaultTeamId: null };
    await setAuthoringPreferences(db, ctx, { ...homeInput, preferredStyle: style || null });
    revalidatePath(paths.settings(company));
    return { status: "ok", message: "Preferences saved." };
  });
}
