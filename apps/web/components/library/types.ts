/** View model for a briefing row, mapped from library DTOs by pages. */
export interface BriefingRowData {
  slug: string;
  title: string;
  summary: string | null;
  /** Omitted for draft rows (DraftRow carries the viewer's roles, not the owner). */
  author?: { userId: string; name: string };
  /** Organizational home, e.g. ["Product", "Platform"]; empty for company-level. */
  homePath: string[];
  /** Audience label, e.g. "Company", "Product department", "Platform team", "Restricted". */
  audienceLabel: string;
  /** Published version number, if published. */
  version: number | null;
  /** Last publication or update time. */
  updatedAt: Date;
  /** "Published" when version 1 is the latest, "Updated" otherwise. */
  activityVerb?: "Published" | "Updated" | "Edited";
  /** The viewer opened an earlier version than the current one (their own private reading state). */
  newVersion?: boolean;
  /** The viewer has never opened this briefing (their own private reading state). */
  unread?: boolean;
  /** Override link target (e.g. drafts open the editor). */
  href?: string;
  /** Status pill for draft rows. */
  status?: "draft" | "published" | "withdrawn";
}
