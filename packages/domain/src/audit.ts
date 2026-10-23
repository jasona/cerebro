import { auditEvents, type Tx } from "@cerebro/database";
import type { RequestContext } from "./context";

export interface AuditInput {
  action: string; // e.g. "briefing.published", "grant.revoked"
  targetType: string; // e.g. "briefing", "team", "share_link"
  targetId?: string | null;
  revisionId?: string | null;
  /** Limited metadata only: never source text, prompts or credentials. */
  metadata?: Record<string, unknown>;
}

/** Append an audit event inside the caller's transaction. */
export async function recordAudit(tx: Tx, ctx: RequestContext, input: AuditInput): Promise<void> {
  await tx.insert(auditEvents).values({
    organizationId: ctx.organizationId,
    actorId: ctx.userId,
    connectionId: ctx.connectionId ?? null,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    revisionId: input.revisionId ?? null,
    metadata: input.metadata ?? {},
  });
}
