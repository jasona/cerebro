"use server";

import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { devSubjectExists, safeNextPath } from "./auth";
import { authMode } from "./env";
import { encodeSession, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from "./session-token";

/** Dev adapter only: sign in as a seeded `dev|*` user. */
export async function devSignInAction(formData: FormData): Promise<void> {
  if (authMode() !== "dev") notFound();
  const subject = String(formData.get("subject") ?? "");
  if (!(await devSubjectExists(subject))) {
    redirect("/dev/sign-in?error=unknown");
  }
  const jar = await cookies();
  jar.set(SESSION_COOKIE, encodeSession({ sub: subject, iat: Math.floor(Date.now() / 1000) }), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  redirect(safeNextPath(formData.get("next")));
}

export async function signOutAction(): Promise<void> {
  if (authMode() === "clerk") redirect("/sign-out");
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  redirect("/sign-in");
}
