/**
 * URL builders for workspace routes. Use these instead of string templates so
 * slugs are always encoded and query strings stay consistent.
 */
const enc = encodeURIComponent;

export type Query = Record<string, string | number | null | undefined>;

export function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

export const paths = {
  company: (c: string, q?: Query) => withQuery(`/c/${enc(c)}`, q),
  recent: (c: string, q?: Query) => withQuery(`/c/${enc(c)}/recent`, q),
  drafts: (c: string) => `/c/${enc(c)}/drafts`,
  department: (c: string, d: string, q?: Query) => withQuery(`/c/${enc(c)}/d/${enc(d)}`, q),
  team: (c: string, d: string, t: string, q?: Query) => withQuery(`/c/${enc(c)}/d/${enc(d)}/t/${enc(t)}`, q),
  people: (c: string) => `/c/${enc(c)}/people`,
  person: (c: string, userId: string) => `/c/${enc(c)}/people/${enc(userId)}`,
  settings: (c: string) => `/c/${enc(c)}/settings`,
  admin: (c: string, q?: Query) => withQuery(`/c/${enc(c)}/admin`, q),
  /** Reader (latest publication). */
  briefing: (c: string, b: string) => `/c/${enc(c)}/b/${enc(b)}`,
  briefingRevision: (c: string, b: string, n: number) => `/c/${enc(c)}/b/${enc(b)}/v/${n}`,
  briefingEdit: (c: string, b: string) => `/c/${enc(c)}/b/${enc(b)}/edit`,
  briefingPreview: (c: string, b: string) => `/c/${enc(c)}/b/${enc(b)}/preview`,
  briefingHistory: (c: string, b: string) => `/c/${enc(c)}/b/${enc(b)}/history`,
  briefingEngagement: (c: string, b: string) => `/c/${enc(c)}/b/${enc(b)}/engagement`,
  briefingAccess: (c: string, b: string) => `/c/${enc(c)}/b/${enc(b)}/access`,
  /** New brief, inheriting the current home (slugs). */
  newBrief: (c: string, home?: { department?: string | null; team?: string | null }) =>
    withQuery(`/c/${enc(c)}/new`, { department: home?.department ?? undefined, team: home?.team ?? undefined }),
  invite: (token: string) => `/invite/${enc(token)}`,
} as const;

/**
 * Briefing route builders (`/c/[company]/b/[briefing]/**`) with optional
 * query strings: reader, pinned revision, editor, preview and the author
 * views (history, engagement, access). Server and client safe.
 */
export const briefingPaths = {
  reader: (c: string, b: string, q?: Query) => withQuery(paths.briefing(c, b), q),
  pinned: (c: string, b: string, n: number, q?: Query) => withQuery(paths.briefingRevision(c, b, n), q),
  /** Reader for a revision: canonical when `n` is omitted. */
  revision: (c: string, b: string, n: number | null | undefined, q?: Query) =>
    n ? withQuery(paths.briefingRevision(c, b, n), q) : withQuery(paths.briefing(c, b), q),
  edit: (c: string, b: string, q?: Query) => withQuery(paths.briefingEdit(c, b), q),
  preview: (c: string, b: string, q?: Query) => withQuery(paths.briefingPreview(c, b), q),
  history: (c: string, b: string, q?: Query) => withQuery(paths.briefingHistory(c, b), q),
  engagement: (c: string, b: string) => paths.briefingEngagement(c, b),
  access: (c: string, b: string, q?: Query) => withQuery(paths.briefingAccess(c, b), q),
} as const;
