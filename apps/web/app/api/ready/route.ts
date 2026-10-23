/**
 * Readiness probe: database reachable, migrations current, job queue depth
 * and oldest pending age, and limit configuration valid. Full details only
 * for internal callers presenting `Authorization: Bearer $READINESS_TOKEN`;
 * others get the status and failing check names. 503 when not ready.
 */
import { getDatabase } from "@cerebro/database";
import { readinessResponse } from "@cerebro/domain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const { db } = await getDatabase();
    return await readinessResponse(db, request);
  } catch {
    // Opening the database failed (e.g. PGlite data dir locked, Postgres down).
    return new Response(JSON.stringify({ status: "not_ready", failing: ["database"] }), {
      status: 503,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
}
