import type { AudienceDTO } from "@cerebro/domain";

/** Audience stated explicitly, even for the company default: "Everyone at Acme (company-wide)". */
export function explicitAudience(a: Pick<AudienceDTO, "visibility" | "label">): string {
  switch (a.visibility) {
    case "company":
      return `${a.label} (company-wide)`;
    case "department":
      return `${a.label} (its members, including its teams)`;
    case "team":
      return `${a.label} (team members only)`;
    default:
      return `${a.label} (only people with a direct grant)`;
  }
}

export const STALE_REASONS: Record<string, string> = {
  draft_version: "The draft was saved again after the preview.",
  content: "The briefing content changed.",
  evidence: "Evidence approval changed.",
  publication: "Another version was published or withdrawn since the preview.",
  home: "The briefing's home changed.",
  audience: "The audience or named readers changed.",
  expired: "The preview expired.",
  consumed: "This preview was already used.",
  unknown: "Something changed since the preview.",
};

export const ERROR_COPY: Record<string, string> = {
  not_found: "We couldn't find that, or you no longer have access to it.",
  forbidden: "You don't have permission to do that.",
  conflict: "The draft changed at the same time. Review the latest preview.",
  validation: "The brief has errors that block publication. Fix them in the editor first.",
  idempotency_mismatch: "This publish request was already used for something else. Review the preview and try again.",
  rate_limited: "Too many attempts. Wait a moment and try again.",
  unavailable: "Publishing is temporarily unavailable. Nothing was published; try again shortly.",
  unauthenticated: "Your session expired. Sign in again.",
};
