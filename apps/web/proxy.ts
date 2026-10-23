import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";

/**
 * Request proxy (Next 16's renamed middleware).
 *
 * Only AUTH_MODE=clerk does anything here: Clerk's `auth()` requires
 * clerkMiddleware to have run for the request. In dev mode this is a
 * pass-through and Clerk is never loaded. Authorization is NOT enforced here;
 * domain services are the security boundary.
 */
type Handler = (req: NextRequest, ev: NextFetchEvent) => Promise<Response | undefined | void> | Response | undefined | void;
let clerkHandler: Handler | undefined;

export async function proxy(req: NextRequest, ev: NextFetchEvent) {
  if (process.env.AUTH_MODE?.trim().toLowerCase() !== "clerk") return NextResponse.next();
  if (!clerkHandler) {
    const { clerkMiddleware } = await import("@clerk/nextjs/server");
    clerkHandler = clerkMiddleware() as unknown as Handler;
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
