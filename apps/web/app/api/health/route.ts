/**
 * Liveness probe: the web process is up. Never touches the database, so a
 * database outage does not make orchestrators restart healthy processes.
 */
import { healthResponse } from "@cerebro/domain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  return healthResponse();
}
