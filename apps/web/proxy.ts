import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { clerkMiddlewareOptions, resolveAuthMode } from "./lib/auth-mode";

/**
 * Request proxy (Next 16's renamed middleware).
 *
 * Only Clerk mode does anything here: Clerk's `auth()` requires
 * clerkMiddleware to have run for the request. The mode is resolved by the
 * same rule as the server (auth-mode.ts), so production without AUTH_MODE
 * gets Clerk, and AUTH_MODE=dev in production fails. In dev mode this is a
 * pass-through and Clerk is never loaded.
 *
 * The MCP endpoint and OAuth metadata skip Clerk: MCP requests carry their
 * own bearer credentials (OAuth access tokens or dev connection tokens),
 * which Clerk must not interpret as session tokens. The liveness and
 * readiness probes skip Clerk too: they use no session (readiness details
 * take their own `READINESS_TOKEN` bearer), and orchestrator health checks
 * must not depend on Clerk keys or Clerk's availability.
 *
 * Clerk session tokens are accepted only when minted for the APP_URL origin
 * (`authorizedParties`, see auth-mode.ts).
 *
 * Authorization is NOT enforced here; domain services are the security
 * boundary.
 */
type Handler = (req: NextRequest, ev: NextFetchEvent) => Promise<Response | undefined | void> | Response | undefined | void;
let clerkHandler: Handler | undefined;

const BYPASS_CLERK = /^\/(?:api\/mcp|api\/health|api\/ready|\.well-known)(?:\/|$)/;

export async function proxy(req: NextRequest, ev: NextFetchEvent) {
  if (resolveAuthMode(process.env) !== "clerk" || BYPASS_CLERK.test(req.nextUrl.pathname)) return NextResponse.next();
  if (!clerkHandler) {
    const { clerkMiddleware } = await import("@clerk/nextjs/server");
    clerkHandler = clerkMiddleware(clerkMiddlewareOptions(process.env)) as unknown as Handler;
  }
  return (await clerkHandler(req, ev)) ?? NextResponse.next();
}

export const config = {
  matcher: [
    // Skip Next internals and static files.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
