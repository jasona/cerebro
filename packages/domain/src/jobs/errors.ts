import type { Job } from "@cerebro/database";
import type { RequestContext } from "../context";

/**
 * Failure raised by a job handler. `category` is a short machine label that
 * is safe to persist and log; it never carries payload or source text.
 */
export class JobError extends Error {
  readonly category: string;
  readonly retryable: boolean;

  constructor(category: string, retryable: boolean, message = category) {
    super(message);
    this.name = "JobError";
    this.category = category;
    this.retryable = retryable;
  }
}

/** Permanent failure: retrying cannot help (missing rows, lost access, invalid payload). */
export const permanent = (category: string) => new JobError(category, false);

/** Context for a worker acting as `userId` in the job's organization. */
export function workerContext(job: Job, userId: string): RequestContext {
  if (!job.organizationId) throw permanent("missing_organization");
  return { userId, organizationId: job.organizationId, via: "worker", requestId: `job:${job.id}` };
}

export function requireJobOrg(job: Job): string {
  if (!job.organizationId) throw permanent("missing_organization");
  return job.organizationId;
}
