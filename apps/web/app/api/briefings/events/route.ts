import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { getBriefingRequestContext } from "@/lib/context";
import { getSessionUser } from "@/lib/auth";
import { recordEngagementEvent, RECORDABLE_EVENT_TYPES, type RecordableEventType } from "@cerebro/domain";

export const dynamic = "force-dynamic";

/** Pseudonymous per-browser-session key; hashed by the domain, never stored as given. */
const SESSION_KEY_COOKIE = "cb_reader_session";

const isString = (v: unknown, max = 200): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

/**
 * Record one measured reader event. Always answers 204 with no body, whether
 * or not it was recorded, so the endpoint reveals nothing about briefings and
 * reading never depends on it. The domain checks read access on the revision.
 */
export async function POST(req: Request): Promise<Response> {
  const done = () => new Response(null, { status: 204 });
  try {
    const user = await getSessionUser();
    if (!user) return done();
    const body = (await req.json()) as Record<string, unknown>;
    const { company, briefing, briefingId, revisionNumber, type, blockId } = body;
    if (!isString(company) || !isString(briefing) || !isString(briefingId, 64)) return done();
    if (typeof revisionNumber !== "number" || !Number.isInteger(revisionNumber) || revisionNumber < 1) return done();
    if (!RECORDABLE_EVENT_TYPES.includes(type as RecordableEventType)) return done();
    if (blockId !== undefined && !isString(blockId, 100)) return done();

    const rc = await getBriefingRequestContext(company, briefing);
    const jar = await cookies();
    let sessionKey = jar.get(SESSION_KEY_COOKIE)?.value;
    if (!sessionKey || sessionKey.length < 8 || sessionKey.length > 200) {
      sessionKey = randomUUID();
      jar.set(SESSION_KEY_COOKIE, sessionKey, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
      });
    }
    await recordEngagementEvent(rc.db, rc.ctx, {
      briefingId,
      revisionNumber,
      type: type as RecordableEventType,
      ...(blockId ? { blockId } : {}),
      sessionKey,
    });
  } catch {
    // Silent by design (unknown briefing, no access, validation, outage).
  }
  return done();
}
