/**
 * Drizzle schema for Cerebro. The executable source of truth is the SQL in
 * `packages/database/migrations`; this file must stay consistent with it.
 *
 * Conventions: UUID primary keys, timestamptz, `organization_id` on every
 * tenant row, composite `(organization_id, id)` uniques so that every tenant
 * reference is a composite foreign key that cannot cross companies.
 */
import { sql, type SQL } from "drizzle-orm";
import {
  type AnyPgColumn,
  type PgTableExtraConfigValue,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enumerated values (enforced with CHECK constraints)
// ---------------------------------------------------------------------------

export const COMPANY_ROLES = ["owner", "admin", "member"] as const;
export const MEMBERSHIP_STATUSES = ["active", "invited", "suspended", "removed"] as const;
export const SUB_MEMBERSHIP_STATUSES = ["active", "removed"] as const;
export const VISIBILITIES = ["company", "department", "team", "restricted"] as const;
export const GRANT_ROLES = ["reader", "editor", "publisher", "owner"] as const;
export const CONNECTION_KINDS = ["dev_token", "oauth"] as const;
export const CONNECTION_STATUSES = ["active", "revoked"] as const;
export const OPERATION_STATUSES = ["pending", "succeeded", "failed"] as const;
export const INVITATION_KINDS = ["membership", "briefing_grant"] as const;
export const SOURCE_KINDS = ["upload", "text", "llm_handoff"] as const;
export const EXTRACTION_STATUSES = ["pending", "running", "succeeded", "failed"] as const;
export const EVIDENCE_ORIGINS = ["llm_handoff", "upload", "manual"] as const;
export const QA_VISIBILITIES = ["private"] as const;
export const QA_ROLES = ["reader", "assistant"] as const;
export const GENERATION_STATUSES = ["pending", "complete", "abstained", "failed"] as const;
export const FEEDBACK_TYPES = ["question", "comment", "concern", "correction"] as const;
export const FEEDBACK_STATUSES = ["submitted", "acknowledged", "resolved", "dismissed"] as const;
export const ENGAGEMENT_EVENT_TYPES = [
  "open",
  "section_view",
  "block_view",
  "evidence_open",
  "perspective_select",
  "question_asked",
  "feedback_submitted",
] as const;
export const AI_RUN_STATUSES = ["running", "succeeded", "failed", "abstained"] as const;
export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export const RETRIEVAL_CHUNK_KINDS = ["block", "evidence"] as const;

export type CompanyRole = (typeof COMPANY_ROLES)[number];
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];
export type Visibility = (typeof VISIBILITIES)[number];
export type GrantRole = (typeof GRANT_ROLES)[number];
export type JobStatus = (typeof JOB_STATUSES)[number];

const oneOf = (column: AnyPgColumn, values: readonly string[]): SQL =>
  sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`;

// ---------------------------------------------------------------------------
// Custom column types
// ---------------------------------------------------------------------------

/** pgvector column without a fixed dimension; `embedding_model` records the model. */
export const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector",
  toDriver: (value) => `[${value.join(",")}]`,
  fromDriver: (value) =>
    typeof value === "string" ? value.slice(1, -1).split(",").filter(Boolean).map(Number) : (value as number[]),
});

export const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

// ---------------------------------------------------------------------------
// Column helpers
// ---------------------------------------------------------------------------

const pk = () => uuid("id").primaryKey().defaultRandom();
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () => ts("updated_at").notNull().defaultNow();
const orgId = () =>
  uuid("organization_id")
    .notNull()
    .references(() => organizations.id);
const userRef = (name: string) => uuid(name).references(() => users.id);

// ---------------------------------------------------------------------------
// Global identity
// ---------------------------------------------------------------------------

export const users = pgTable(
  "users",
  {
    id: pk(),
    authSubject: text("auth_subject").notNull().unique(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    avatarUrl: text("avatar_url"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_lower_idx").on(sql`lower(${t.email})`)],
);

export const organizations = pgTable("organizations", {
  id: pk(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  settings: jsonb("settings").notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// Company structure
// ---------------------------------------------------------------------------

export const memberships = pgTable(
  "memberships",
  {
    id: pk(),
    organizationId: orgId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").notNull().default("member"),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("memberships_org_id_key").on(t.organizationId, t.id),
    unique("memberships_org_user_key").on(t.organizationId, t.userId),
    index("memberships_user_idx").on(t.userId),
    check("memberships_role_check", oneOf(t.role, COMPANY_ROLES)),
    check("memberships_status_check", oneOf(t.status, MEMBERSHIP_STATUSES)),
  ],
);

export const departments = pgTable(
  "departments",
  {
    id: pk(),
    organizationId: orgId(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    archivedAt: ts("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("departments_org_id_key").on(t.organizationId, t.id),
    unique("departments_org_slug_key").on(t.organizationId, t.slug),
  ],
);

export const teams = pgTable(
  "teams",
  {
    id: pk(),
    organizationId: orgId(),
    departmentId: uuid("department_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    archivedAt: ts("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("teams_org_id_key").on(t.organizationId, t.id),
    unique("teams_org_dept_id_key").on(t.organizationId, t.departmentId, t.id),
    unique("teams_dept_slug_key").on(t.organizationId, t.departmentId, t.slug),
    foreignKey({
      name: "teams_department_fk",
      columns: [t.organizationId, t.departmentId],
      foreignColumns: [departments.organizationId, departments.id],
    }),
  ],
);

export const departmentMemberships = pgTable(
  "department_memberships",
  {
    id: pk(),
    organizationId: orgId(),
    departmentId: uuid("department_id").notNull(),
    userId: uuid("user_id").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("department_memberships_org_id_key").on(t.organizationId, t.id),
    unique("department_memberships_dept_user_key").on(t.departmentId, t.userId),
    index("department_memberships_user_idx").on(t.organizationId, t.userId),
    foreignKey({
      name: "department_memberships_department_fk",
      columns: [t.organizationId, t.departmentId],
      foreignColumns: [departments.organizationId, departments.id],
    }),
    foreignKey({
      name: "department_memberships_membership_fk",
      columns: [t.organizationId, t.userId],
      foreignColumns: [memberships.organizationId, memberships.userId],
    }),
    check("department_memberships_status_check", oneOf(t.status, SUB_MEMBERSHIP_STATUSES)),
  ],
);

export const teamMemberships = pgTable(
  "team_memberships",
  {
    id: pk(),
    organizationId: orgId(),
    teamId: uuid("team_id").notNull(),
    userId: uuid("user_id").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("team_memberships_org_id_key").on(t.organizationId, t.id),
    unique("team_memberships_team_user_key").on(t.teamId, t.userId),
    index("team_memberships_user_idx").on(t.organizationId, t.userId),
    foreignKey({
      name: "team_memberships_team_fk",
      columns: [t.organizationId, t.teamId],
      foreignColumns: [teams.organizationId, teams.id],
    }),
    foreignKey({
      name: "team_memberships_membership_fk",
      columns: [t.organizationId, t.userId],
      foreignColumns: [memberships.organizationId, memberships.userId],
    }),
    check("team_memberships_status_check", oneOf(t.status, SUB_MEMBERSHIP_STATUSES)),
  ],
);

// ---------------------------------------------------------------------------
// LLM integration
// ---------------------------------------------------------------------------

export const integrationConnections = pgTable(
  "integration_connections",
  {
    id: pk(),
    organizationId: orgId(),
    userId: uuid("user_id").notNull(),
    kind: text("kind").notNull().default("dev_token"),
    label: text("label").notNull(),
    /** Authenticated client identifier (OAuth client id, or "dev"). */
    clientId: text("client_id").notNull(),
    /** Identity-provider grant reference; never a credential. */
    grantRef: text("grant_ref"),
    scopes: jsonb("scopes").notNull().default([]),
    status: text("status").notNull().default("active"),
    /** SHA-256 of a dev connection token. Plaintext is never stored. */
    tokenHash: text("token_hash").unique(),
    /** Short non-secret prefix shown in Settings to identify a token. */
    tokenPrefix: text("token_prefix"),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
    /** OAuth connections: the authorization server issuer (migration 0006). */
    issuer: text("issuer"),
    /** OAuth connections: tokens authenticated at or before this instant are refused (0006). */
    notBefore: ts("not_before"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("integration_connections_org_id_key").on(t.organizationId, t.id),
    index("integration_connections_user_idx").on(t.organizationId, t.userId),
    uniqueIndex("integration_connections_oauth_active_key")
      .on(t.organizationId, t.userId, t.issuer, t.clientId)
      .where(sql`kind = 'oauth' and status = 'active'`),
    index("integration_connections_oauth_lookup_idx").on(t.userId, t.issuer, t.clientId).where(sql`kind = 'oauth'`),
    check(
      "integration_connections_oauth_check",
      sql`(${t.kind} = 'oauth' and ${t.issuer} is not null and ${t.tokenHash} is null) or (${t.kind} = 'dev_token' and ${t.issuer} is null and ${t.tokenHash} is not null)`,
    ),
    foreignKey({
      name: "integration_connections_membership_fk",
      columns: [t.organizationId, t.userId],
      foreignColumns: [memberships.organizationId, memberships.userId],
    }),
    check("integration_connections_kind_check", oneOf(t.kind, CONNECTION_KINDS)),
    check("integration_connections_status_check", oneOf(t.status, CONNECTION_STATUSES)),
  ],
);

export const authoringPreferences = pgTable(
  "authoring_preferences",
  {
    id: pk(),
    organizationId: orgId(),
    userId: uuid("user_id").notNull(),
    defaultDepartmentId: uuid("default_department_id"),
    defaultTeamId: uuid("default_team_id"),
    preferredStyle: text("preferred_style"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("authoring_preferences_org_id_key").on(t.organizationId, t.id),
    unique("authoring_preferences_org_user_key").on(t.organizationId, t.userId),
    foreignKey({
      name: "authoring_preferences_membership_fk",
      columns: [t.organizationId, t.userId],
      foreignColumns: [memberships.organizationId, memberships.userId],
    }),
    foreignKey({
      name: "authoring_preferences_department_fk",
      columns: [t.organizationId, t.defaultDepartmentId],
      foreignColumns: [departments.organizationId, departments.id],
    }),
    foreignKey({
      name: "authoring_preferences_team_fk",
      columns: [t.organizationId, t.defaultDepartmentId, t.defaultTeamId],
      foreignColumns: [teams.organizationId, teams.departmentId, teams.id],
    }),
    check(
      "authoring_preferences_team_needs_department_check",
      sql`${t.defaultTeamId} is null or ${t.defaultDepartmentId} is not null`,
    ),
  ],
);

export const integrationOperations = pgTable(
  "integration_operations",
  {
    id: pk(),
    organizationId: orgId(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    connectionId: uuid("connection_id"),
    action: text("action").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    inputDigest: text("input_digest").notNull(),
    status: text("status").notNull().default("pending"),
    resourceType: text("resource_type"),
    resourceId: uuid("resource_id"),
    result: jsonb("result"),
    errorCategory: text("error_category"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: ts("completed_at"),
  },
  (t) => [
    unique("integration_operations_org_id_key").on(t.organizationId, t.id),
    unique("integration_operations_idempotency_key")
      .on(t.organizationId, t.actorId, t.connectionId, t.action, t.idempotencyKey)
      .nullsNotDistinct(),
    foreignKey({
      name: "integration_operations_connection_fk",
      columns: [t.organizationId, t.connectionId],
      foreignColumns: [integrationConnections.organizationId, integrationConnections.id],
    }),
    check("integration_operations_status_check", oneOf(t.status, OPERATION_STATUSES)),
  ],
);

// ---------------------------------------------------------------------------
// Briefings
// ---------------------------------------------------------------------------

export const briefings = pgTable(
  "briefings",
  {
    id: pk(),
    organizationId: orgId(),
    ownerId: uuid("owner_id").notNull(),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    /** Short library summary (published position headline/summary). */
    summary: text("summary"),
    homeDepartmentId: uuid("home_department_id"),
    homeTeamId: uuid("home_team_id"),
    visibility: text("visibility").notNull().default("company"),
    audienceDepartmentId: uuid("audience_department_id"),
    audienceTeamId: uuid("audience_team_id"),
    currentPublicationId: uuid("current_publication_id"),
    searchTsv: tsvector("search_tsv").generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(title, '') || ' ' || coalesce(summary, ''))`,
    ),
    archivedAt: ts("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique("briefings_org_id_key").on(t.organizationId, t.id),
    unique("briefings_org_slug_key").on(t.organizationId, t.slug),
    index("briefings_owner_idx").on(t.organizationId, t.ownerId),
    index("briefings_home_idx").on(t.organizationId, t.homeDepartmentId, t.homeTeamId),
    index("briefings_search_idx").using("gin", t.searchTsv),
    foreignKey({
      name: "briefings_owner_membership_fk",
      columns: [t.organizationId, t.ownerId],
      foreignColumns: [memberships.organizationId, memberships.userId],
    }),
    foreignKey({
      name: "briefings_home_department_fk",
      columns: [t.organizationId, t.homeDepartmentId],
      foreignColumns: [departments.organizationId, departments.id],
    }),
    foreignKey({
      name: "briefings_home_team_fk",
      columns: [t.organizationId, t.homeDepartmentId, t.homeTeamId],
      foreignColumns: [teams.organizationId, teams.departmentId, teams.id],
    }),
    foreignKey({
      name: "briefings_audience_department_fk",
      columns: [t.organizationId, t.audienceDepartmentId],
      foreignColumns: [departments.organizationId, departments.id],
    }),
    foreignKey({
      name: "briefings_audience_team_fk",
      columns: [t.organizationId, t.audienceTeamId],
      foreignColumns: [teams.organizationId, teams.id],
    }),
    foreignKey({
      name: "briefings_current_publication_fk",
      columns: [t.organizationId, t.id, t.currentPublicationId],
      foreignColumns: [publications.organizationId, publications.briefingId, publications.id],
    }),
    check("briefings_visibility_check", oneOf(t.visibility, VISIBILITIES)),
    check("briefings_home_check", sql`${t.homeTeamId} is null or ${t.homeDepartmentId} is not null`),
    check(
      "briefings_audience_check",
      sql`(${t.visibility} = 'department' and ${t.audienceDepartmentId} is not null and ${t.audienceTeamId} is null)
       or (${t.visibility} = 'team' and ${t.audienceTeamId} is not null and ${t.audienceDepartmentId} is null)
       or (${t.visibility} in ('company', 'restricted') and ${t.audienceDepartmentId} is null and ${t.audienceTeamId} is null)`,
    ),
  ],
);

export const briefingRevisions = pgTable(
  "briefing_revisions",
  {
    id: pk(),
    organizationId: orgId(),
    briefingId: uuid("briefing_id").notNull(),
    number: integer("number").notNull(),
    documentJson: jsonb("document_json").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    contentHash: text("content_hash").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique("briefing_revisions_org_id_key").on(t.organizationId, t.id),
    unique("briefing_revisions_org_briefing_id_key").on(t.organizationId, t.briefingId, t.id),
    unique("briefing_revisions_number_key").on(t.briefingId, t.number),
    foreignKey({
      name: "briefing_revisions_briefing_fk",
      columns: [t.organizationId, t.briefingId],
      foreignColumns: [briefings.organizationId, briefings.id],
    }),
    check("briefing_revisions_number_check", sql`${t.number} > 0`),
  ],
);

export const publications = pgTable(
  "publications",
  {
    id: pk(),
    organizationId: orgId(),
    briefingId: uuid("briefing_id").notNull(),
    revisionId: uuid("revision_id").notNull().unique(),
    publishedBy: uuid("published_by")
      .notNull()
      .references(() => users.id),
    publishedAt: ts("published_at").notNull().defaultNow(),
    changeSummary: text("change_summary"),
    connectionId: uuid("connection_id"),
    /** The only column the runtime role may update. */
    withdrawnAt: ts("withdrawn_at"),
  },
  (t): PgTableExtraConfigValue[] => [
    unique("publications_org_id_key").on(t.organizationId, t.id),
    unique("publications_org_briefing_id_key").on(t.organizationId, t.briefingId, t.id),
    index("publications_briefing_idx").on(t.organizationId, t.briefingId, t.publishedAt),
    foreignKey({
      name: "publications_revision_fk",
      columns: [t.organizationId, t.briefingId, t.revisionId],
      foreignColumns: [briefingRevisions.organizationId, briefingRevisions.briefingId, briefingRevisions.id],
    }),
    foreignKey({
      name: "publications_connection_fk",
      columns: [t.organizationId, t.connectionId],
      foreignColumns: [integrationConnections.organizationId, integrationConnections.id],
    }),
  ],
);

export const briefingGrants = pgTable(
  "briefing_grants",
  {
    id: pk(),
    organizationId: orgId(),
    briefingId: uuid("briefing_id").notNull(),
    /** Global user; may be an external reader without company membership. */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").notNull().default("reader"),
    /** Optional revision scope: the grant covers only this revision. */
    revisionId: uuid("revision_id"),
    issuedBy: uuid("issued_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    revokedAt: ts("revoked_at"),
    revokedBy: userRef("revoked_by"),
  },
  (t) => [
    unique("briefing_grants_org_id_key").on(t.organizationId, t.id),
    index("briefing_grants_user_idx").on(t.organizationId, t.userId),
    uniqueIndex("briefing_grants_active_key")
      .on(t.briefingId, t.userId, t.role, sql`coalesce(${t.revisionId}, '00000000-0000-0000-0000-000000000000'::uuid)`)
      .where(sql`revoked_at is null`),
    foreignKey({
      name: "briefing_grants_briefing_fk",
      columns: [t.organizationId, t.briefingId],
      foreignColumns: [briefings.organizationId, briefings.id],
    }),
    foreignKey({
      name: "briefing_grants_revision_fk",
      columns: [t.organizationId, t.briefingId, t.revisionId],
      foreignColumns: [briefingRevisions.organizationId, briefingRevisions.briefingId, briefingRevisions.id],
    }),
    check("briefing_grants_role_check", oneOf(t.role, GRANT_ROLES)),
    check("briefing_grants_revision_reader_check", sql`${t.revisionId} is null or ${t.role} = 'reader'`),
  ],
);

export const briefingDrafts = pgTable(
  "briefing_drafts",
  {
    id: pk(),
    organizationId: orgId(),
    briefingId: uuid("briefing_id").notNull().unique(),
    documentJson: jsonb("document_json").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    lockVersion: integer("lock_version").notNull().default(1),
    baseRevisionId: uuid("base_revision_id"),
    updatedBy: uuid("updated_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("briefing_drafts_org_id_key").on(t.organizationId, t.id),
    foreignKey({
      name: "briefing_drafts_briefing_fk",
      columns: [t.organizationId, t.briefingId],
      foreignColumns: [briefings.organizationId, briefings.id],
    }),
    foreignKey({
      name: "briefing_drafts_base_revision_fk",
      columns: [t.organizationId, t.briefingId, t.baseRevisionId],
      foreignColumns: [briefingRevisions.organizationId, briefingRevisions.briefingId, briefingRevisions.id],
    }),
  ],
);

export const publicationPreviews = pgTable(
  "publication_previews",
  {
    id: pk(),
    organizationId: orgId(),
    briefingId: uuid("briefing_id").notNull(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    connectionId: uuid("connection_id"),
    draftLockVersion: integer("draft_lock_version").notNull(),
    contentDigest: text("content_digest").notNull(),
    evidenceDigest: text("evidence_digest").notNull(),
    homeDepartmentId: uuid("home_department_id"),
    homeTeamId: uuid("home_team_id"),
    visibility: text("visibility").notNull(),
    audienceDepartmentId: uuid("audience_department_id"),
    audienceTeamId: uuid("audience_team_id"),
    /** Snapshot of explicit recipient grants included in the reviewed audience. */
    audienceSnapshot: jsonb("audience_snapshot").notNull().default({}),
    expiresAt: ts("expires_at").notNull(),
    consumedAt: ts("consumed_at"),
    publicationId: uuid("publication_id"),
    /** Current publication when the preview was created (null: none). Publishing requires it to still be current. */
    basePublicationId: uuid("base_publication_id"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("publication_previews_org_id_key").on(t.organizationId, t.id),
    index("publication_previews_briefing_idx").on(t.organizationId, t.briefingId),
    foreignKey({
      name: "publication_previews_briefing_fk",
      columns: [t.organizationId, t.briefingId],
      foreignColumns: [briefings.organizationId, briefings.id],
    }),
    foreignKey({
      name: "publication_previews_connection_fk",
      columns: [t.organizationId, t.connectionId],
      foreignColumns: [integrationConnections.organizationId, integrationConnections.id],
    }),
    foreignKey({
      name: "publication_previews_publication_fk",
      columns: [t.organizationId, t.briefingId, t.publicationId],
      foreignColumns: [publications.organizationId, publications.briefingId, publications.id],
    }),
    foreignKey({
      name: "publication_previews_base_publication_fk",
      columns: [t.organizationId, t.briefingId, t.basePublicationId],
      foreignColumns: [publications.organizationId, publications.briefingId, publications.id],
    }),
    check("publication_previews_visibility_check", oneOf(t.visibility, VISIBILITIES)),
  ],
);

export const revisionEvidence = pgTable(
  "revision_evidence",
  {
    id: pk(),
    organizationId: orgId(),
    revisionId: uuid("revision_id").notNull(),
    /** The document's stable `ev_` identifier. */
    evidenceKey: text("evidence_key").notNull(),
    title: text("title").notNull(),
    excerpt: text("excerpt").notNull(),
    attribution: text("attribution"),
    locator: text("locator"),
    origin: text("origin").notNull().default("manual"),
    /** Private provenance; never returned to readers. */
    sourceId: uuid("source_id"),
    excerptHash: text("excerpt_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("revision_evidence_org_id_key").on(t.organizationId, t.id),
    unique("revision_evidence_org_revision_id_key").on(t.organizationId, t.revisionId, t.id),
    unique("revision_evidence_key_key").on(t.revisionId, t.evidenceKey),
    foreignKey({
      name: "revision_evidence_revision_fk",
      columns: [t.organizationId, t.revisionId],
      foreignColumns: [briefingRevisions.organizationId, briefingRevisions.id],
    }),
    foreignKey({
      name: "revision_evidence_source_fk",
      columns: [t.organizationId, t.sourceId],
      foreignColumns: [sources.organizationId, sources.id],
    }),
    check("revision_evidence_origin_check", oneOf(t.origin, EVIDENCE_ORIGINS)),
  ],
);

export const shareLinks = pgTable(
  "share_links",
  {
    id: pk(),
    organizationId: orgId(),
    briefingId: uuid("briefing_id").notNull(),
    /** Set for pinned links; null resolves to the current publication. */
    revisionId: uuid("revision_id"),
    tokenHash: text("token_hash").notNull().unique(),
    accessPolicy: text("access_policy").notNull().default("authenticated_authorized"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    expiresAt: ts("expires_at"),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("share_links_org_id_key").on(t.organizationId, t.id),
    index("share_links_briefing_idx").on(t.organizationId, t.briefingId),
    foreignKey({
      name: "share_links_briefing_fk",
      columns: [t.organizationId, t.briefingId],
      foreignColumns: [briefings.organizationId, briefings.id],
    }),
    foreignKey({
      name: "share_links_revision_fk",
      columns: [t.organizationId, t.briefingId, t.revisionId],
      foreignColumns: [briefingRevisions.organizationId, briefingRevisions.briefingId, briefingRevisions.id],
    }),
    check("share_links_access_policy_check", oneOf(t.accessPolicy, ["authenticated_authorized"])),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: pk(),
    organizationId: orgId(),
    /** Normalized (trimmed, lower-cased) email. */
    email: text("email").notNull(),
    kind: text("kind").notNull(),
    membershipRole: text("membership_role"),
    briefingId: uuid("briefing_id"),
    grantRole: text("grant_role"),
    revisionId: uuid("revision_id"),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => users.id),
    expiresAt: ts("expires_at").notNull(),
    acceptedAt: ts("accepted_at"),
    acceptedBy: userRef("accepted_by"),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("invitations_org_id_key").on(t.organizationId, t.id),
    index("invitations_email_idx").on(t.organizationId, t.email),
    foreignKey({
      name: "invitations_briefing_fk",
      columns: [t.organizationId, t.briefingId],
      foreignColumns: [briefings.organizationId, briefings.id],
    }),
    foreignKey({
      name: "invitations_revision_fk",
      columns: [t.organizationId, t.briefingId, t.revisionId],
      foreignColumns: [briefingRevisions.organizationId, briefingRevisions.briefingId, briefingRevisions.id],
    }),
    check("invitations_kind_check", oneOf(t.kind, INVITATION_KINDS)),
    check(
      "invitations_target_check",
      sql`(${t.kind} = 'membership' and ${t.membershipRole} in ('admin', 'member') and ${t.briefingId} is null)
       or (${t.kind} = 'briefing_grant' and ${t.briefingId} is not null and ${t.grantRole} in ('reader', 'editor', 'publisher'))`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Private sources
// ---------------------------------------------------------------------------

export const sources = pgTable(
  "sources",
  {
    id: pk(),
    organizationId: orgId(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    /** Immutable private object-storage key, when the source is a file. */
    objectKey: text("object_key"),
    /** Inline text for small text/handoff sources. */
    textContent: text("text_content"),
    mimeType: text("mime_type"),
    byteSize: integer("byte_size"),
    checksum: text("checksum").notNull(),
    extractionStatus: text("extraction_status").notNull().default("pending"),
    extractionErrorCategory: text("extraction_error_category"),
    connectionId: uuid("connection_id"),
    /** Host-provided attribution label; not verification. */
    attribution: text("attribution"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("sources_org_id_key").on(t.organizationId, t.id),
    index("sources_creator_idx").on(t.organizationId, t.createdBy),
    foreignKey({
      name: "sources_connection_fk",
      columns: [t.organizationId, t.connectionId],
      foreignColumns: [integrationConnections.organizationId, integrationConnections.id],
    }),
    check("sources_kind_check", oneOf(t.kind, SOURCE_KINDS)),
    check("sources_extraction_status_check", oneOf(t.extractionStatus, EXTRACTION_STATUSES)),
    check("sources_content_check", sql`${t.objectKey} is not null or ${t.textContent} is not null`),
  ],
);

export const sourceChunks = pgTable(
  "source_chunks",
  {
    id: pk(),
    organizationId: orgId(),
    sourceId: uuid("source_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    text: text("text").notNull(),
    /** Page/slide/message locator, e.g. "p. 8". */
    locator: text("locator"),
    embedding: vector("embedding"),
    embeddingModel: text("embedding_model"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("source_chunks_org_id_key").on(t.organizationId, t.id),
    unique("source_chunks_ordinal_key").on(t.sourceId, t.ordinal),
    foreignKey({
      name: "source_chunks_source_fk",
      columns: [t.organizationId, t.sourceId],
      foreignColumns: [sources.organizationId, sources.id],
    }),
  ],
);

export const briefingSources = pgTable(
  "briefing_sources",
  {
    id: pk(),
    organizationId: orgId(),
    briefingId: uuid("briefing_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    usage: jsonb("usage").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    unique("briefing_sources_org_id_key").on(t.organizationId, t.id),
    unique("briefing_sources_pair_key").on(t.briefingId, t.sourceId),
    foreignKey({
      name: "briefing_sources_briefing_fk",
      columns: [t.organizationId, t.briefingId],
      foreignColumns: [briefings.organizationId, briefings.id],
    }),
    foreignKey({
      name: "briefing_sources_source_fk",
      columns: [t.organizationId, t.sourceId],
      foreignColumns: [sources.organizationId, sources.id],
    }),
  ],
);

// ---------------------------------------------------------------------------
// Engagement
// ---------------------------------------------------------------------------

export const aiRuns = pgTable(
  "ai_runs",
  {
    id: pk(),
    organizationId: orgId(),
    actorId: userRef("actor_id"),
    task: text("task").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    status: text("status").notNull().default("running"),
    latencyMs: integer("latency_ms"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    errorCategory: text("error_category"),
    createdAt: createdAt(),
    completedAt: ts("completed_at"),
  },
  (t) => [
    unique("ai_runs_org_id_key").on(t.organizationId, t.id),
    check("ai_runs_status_check", oneOf(t.status, AI_RUN_STATUSES)),
  ],
);

export const qaThreads = pgTable(
  "qa_threads",
  {
    id: pk(),
    organizationId: orgId(),
    briefingId: uuid("briefing_id").notNull(),
    revisionId: uuid("revision_id").notNull(),
    readerId: uuid("reader_id")
      .notNull()
      .references(() => users.id),
    /** Selected perspective `psp_` id, if any. */
    perspectiveKey: text("perspective_key"),
    visibility: text("visibility").notNull().default("private"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("qa_threads_org_id_key").on(t.organizationId, t.id),
    unique("qa_threads_org_revision_id_key").on(t.organizationId, t.revisionId, t.id),
    index("qa_threads_reader_idx").on(t.organizationId, t.readerId, t.revisionId),
    foreignKey({
      name: "qa_threads_revision_fk",
      columns: [t.organizationId, t.briefingId, t.revisionId],
      foreignColumns: [briefingRevisions.organizationId, briefingRevisions.briefingId, briefingRevisions.id],
    }),
    check("qa_threads_visibility_check", oneOf(t.visibility, QA_VISIBILITIES)),
  ],
);

export const qaMessages = pgTable(
  "qa_messages",
  {
    id: pk(),
    organizationId: orgId(),
    threadId: uuid("thread_id").notNull(),
    /** Denormalized from the thread so citations can be bound to the same revision. */
    revisionId: uuid("revision_id").notNull(),
    role: text("role").notNull(),
    content: text("content").notNull(),
    generationStatus: text("generation_status").notNull().default("complete"),
    aiRunId: uuid("ai_run_id"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("qa_messages_org_id_key").on(t.organizationId, t.id),
    unique("qa_messages_org_revision_id_key").on(t.organizationId, t.revisionId, t.id),
    index("qa_messages_thread_idx").on(t.organizationId, t.threadId, t.createdAt),
    foreignKey({
      name: "qa_messages_thread_fk",
      columns: [t.organizationId, t.revisionId, t.threadId],
      foreignColumns: [qaThreads.organizationId, qaThreads.revisionId, qaThreads.id],
    }),
    foreignKey({
      name: "qa_messages_ai_run_fk",
      columns: [t.organizationId, t.aiRunId],
      foreignColumns: [aiRuns.organizationId, aiRuns.id],
    }),
    check("qa_messages_role_check", oneOf(t.role, QA_ROLES)),
    check("qa_messages_generation_status_check", oneOf(t.generationStatus, GENERATION_STATUSES)),
  ],
);

export const answerCitations = pgTable(
  "answer_citations",
  {
    id: pk(),
    organizationId: orgId(),
    messageId: uuid("message_id").notNull(),
    revisionId: uuid("revision_id").notNull(),
    /** Stable `blk_` id within the revision document. */
    blockKey: text("block_key"),
    evidenceId: uuid("evidence_id"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("answer_citations_org_id_key").on(t.organizationId, t.id),
    foreignKey({
      name: "answer_citations_message_fk",
      columns: [t.organizationId, t.revisionId, t.messageId],
      foreignColumns: [qaMessages.organizationId, qaMessages.revisionId, qaMessages.id],
    }),
    foreignKey({
      name: "answer_citations_evidence_fk",
      columns: [t.organizationId, t.revisionId, t.evidenceId],
      foreignColumns: [revisionEvidence.organizationId, revisionEvidence.revisionId, revisionEvidence.id],
    }),
    check("answer_citations_target_check", sql`num_nonnulls(${t.blockKey}, ${t.evidenceId}) = 1`),
  ],
);

export const feedback = pgTable(
  "feedback",
  {
    id: pk(),
    organizationId: orgId(),
    briefingId: uuid("briefing_id").notNull(),
    revisionId: uuid("revision_id").notNull(),
    blockKey: text("block_key"),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    type: text("type").notNull(),
    text: text("text").notNull(),
    status: text("status").notNull().default("submitted"),
    /** Revision that addressed this feedback, if any. */
    resolutionRevisionId: uuid("resolution_revision_id"),
    qaThreadId: uuid("qa_thread_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("feedback_org_id_key").on(t.organizationId, t.id),
    index("feedback_revision_idx").on(t.organizationId, t.briefingId, t.revisionId),
    foreignKey({
      name: "feedback_revision_fk",
      columns: [t.organizationId, t.briefingId, t.revisionId],
      foreignColumns: [briefingRevisions.organizationId, briefingRevisions.briefingId, briefingRevisions.id],
    }),
    foreignKey({
      name: "feedback_resolution_revision_fk",
      columns: [t.organizationId, t.briefingId, t.resolutionRevisionId],
      foreignColumns: [briefingRevisions.organizationId, briefingRevisions.briefingId, briefingRevisions.id],
    }),
    foreignKey({
      name: "feedback_qa_thread_fk",
      columns: [t.organizationId, t.qaThreadId],
      foreignColumns: [qaThreads.organizationId, qaThreads.id],
    }),
    check("feedback_type_check", oneOf(t.type, FEEDBACK_TYPES)),
    check("feedback_status_check", oneOf(t.status, FEEDBACK_STATUSES)),
  ],
);

export const engagementEvents = pgTable(
  "engagement_events",
  {
    id: pk(),
    organizationId: orgId(),
    briefingId: uuid("briefing_id").notNull(),
    revisionId: uuid("revision_id").notNull(),
    /** Pseudonymous session identifier; not a user id. */
    sessionId: text("session_id").notNull(),
    eventType: text("event_type").notNull(),
    blockKey: text("block_key"),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
    dedupeKey: text("dedupe_key"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("engagement_events_org_id_key").on(t.organizationId, t.id),
    unique("engagement_events_dedupe_key").on(t.organizationId, t.dedupeKey),
    index("engagement_events_revision_idx").on(t.organizationId, t.revisionId, t.occurredAt),
    foreignKey({
      name: "engagement_events_revision_fk",
      columns: [t.organizationId, t.briefingId, t.revisionId],
      foreignColumns: [briefingRevisions.organizationId, briefingRevisions.briefingId, briefingRevisions.id],
    }),
    check("engagement_events_type_check", oneOf(t.eventType, ENGAGEMENT_EVENT_TYPES)),
  ],
);

export const engagementInsights = pgTable(
  "engagement_insights",
  {
    id: pk(),
    organizationId: orgId(),
    briefingId: uuid("briefing_id").notNull(),
    revisionId: uuid("revision_id"),
    topic: text("topic").notNull(),
    summary: text("summary"),
    readerCount: integer("reader_count").notNull().default(0),
    questionCount: integer("question_count").notNull().default(0),
    /** Authorized supporting references (block ids, submitted feedback ids). */
    supportingRefs: jsonb("supporting_refs").notNull().default([]),
    watermark: ts("watermark").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("engagement_insights_org_id_key").on(t.organizationId, t.id),
    index("engagement_insights_briefing_idx").on(t.organizationId, t.briefingId),
    foreignKey({
      name: "engagement_insights_briefing_fk",
      columns: [t.organizationId, t.briefingId],
      foreignColumns: [briefings.organizationId, briefings.id],
    }),
    foreignKey({
      name: "engagement_insights_revision_fk",
      columns: [t.organizationId, t.briefingId, t.revisionId],
      foreignColumns: [briefingRevisions.organizationId, briefingRevisions.briefingId, briefingRevisions.id],
    }),
  ],
);

// ---------------------------------------------------------------------------
// Audit, jobs, retrieval
// ---------------------------------------------------------------------------

export const auditEvents = pgTable(
  "audit_events",
  {
    id: pk(),
    organizationId: orgId(),
    actorId: userRef("actor_id"),
    connectionId: uuid("connection_id"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id"),
    revisionId: uuid("revision_id"),
    /** Limited metadata; never source text, prompts or credentials. */
    metadata: jsonb("metadata").notNull().default({}),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
  },
  (t) => [
    unique("audit_events_org_id_key").on(t.organizationId, t.id),
    index("audit_events_target_idx").on(t.organizationId, t.targetType, t.targetId, t.occurredAt),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: pk(),
    organizationId: uuid("organization_id").references(() => organizations.id),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull().default({}),
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    runAfter: ts("run_after").notNull().defaultNow(),
    lockedAt: ts("locked_at"),
    lockedBy: text("locked_by"),
    lastErrorCategory: text("last_error_category"),
    dedupeKey: text("dedupe_key").unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("jobs_claim_idx").on(t.status, t.kind, t.runAfter),
    check("jobs_status_check", oneOf(t.status, JOB_STATUSES)),
    check("jobs_attempts_check", sql`${t.attempts} >= 0 and ${t.maxAttempts} > 0`),
  ],
);

/**
 * Derived retrieval projection over published blocks and approved evidence.
 * Never canonical content; rebuildable from revisions. Never holds private
 * source chunks.
 */
export const retrievalChunks = pgTable(
  "retrieval_chunks",
  {
    id: pk(),
    organizationId: orgId(),
    briefingId: uuid("briefing_id").notNull(),
    revisionId: uuid("revision_id").notNull(),
    kind: text("kind").notNull(),
    sectionKey: text("section_key"),
    blockKey: text("block_key"),
    evidenceId: uuid("evidence_id"),
    ordinal: integer("ordinal").notNull(),
    text: text("text").notNull(),
    tsv: tsvector("tsv").generatedAlwaysAs(sql`to_tsvector('english', text)`),
    embedding: vector("embedding"),
    embeddingModel: text("embedding_model"),
    embeddingDims: integer("embedding_dims"),
    isCurrent: boolean("is_current").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    unique("retrieval_chunks_org_id_key").on(t.organizationId, t.id),
    unique("retrieval_chunks_ordinal_key").on(t.revisionId, t.ordinal),
    index("retrieval_chunks_revision_idx").on(t.organizationId, t.revisionId),
    index("retrieval_chunks_tsv_idx").using("gin", t.tsv),
    foreignKey({
      name: "retrieval_chunks_revision_fk",
      columns: [t.organizationId, t.briefingId, t.revisionId],
      foreignColumns: [briefingRevisions.organizationId, briefingRevisions.briefingId, briefingRevisions.id],
    }),
    foreignKey({
      name: "retrieval_chunks_evidence_fk",
      columns: [t.organizationId, t.revisionId, t.evidenceId],
      foreignColumns: [revisionEvidence.organizationId, revisionEvidence.revisionId, revisionEvidence.id],
    }),
    check("retrieval_chunks_kind_check", oneOf(t.kind, RETRIEVAL_CHUNK_KINDS)),
    check(
      "retrieval_chunks_target_check",
      sql`(${t.kind} = 'block' and ${t.blockKey} is not null and ${t.evidenceId} is null)
       or (${t.kind} = 'evidence' and ${t.evidenceId} is not null)`,
    ),
  ],
);

/**
 * Private per-user reading state (migration 0005): the last revision of a
 * briefing the user opened, for library "Unread" / "New version" badges.
 * RLS limits rows to their own user; this is never author analytics and is
 * separate from the pseudonymous engagement_events.
 */
export const briefingReads = pgTable(
  "briefing_reads",
  {
    id: pk(),
    organizationId: orgId(),
    briefingId: uuid("briefing_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    lastRevisionNumber: integer("last_revision_number").notNull(),
    lastOpenedAt: ts("last_opened_at").notNull().defaultNow(),
  },
  (t) => [
    unique("briefing_reads_org_id_key").on(t.organizationId, t.id),
    unique("briefing_reads_user_key").on(t.organizationId, t.briefingId, t.userId),
    index("briefing_reads_user_idx").on(t.organizationId, t.userId),
    check("briefing_reads_revision_check", sql`${t.lastRevisionNumber} >= 1`),
    foreignKey({
      name: "briefing_reads_briefing_fk",
      columns: [t.organizationId, t.briefingId],
      foreignColumns: [briefings.organizationId, briefings.id],
    }),
  ],
);

/**
 * Explicit identity links (migration 0006): a verified external identity
 * (issuer + subject, from Clerk or the MCP OAuth authorization server) to a
 * Cerebro user. Not a tenant table; RLS exposes only the caller's own links.
 */
export const userIdentities = pgTable(
  "user_identities",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("user_identities_issuer_subject_key").on(t.issuer, t.subject),
    unique("user_identities_user_issuer_key").on(t.userId, t.issuer),
    check("user_identities_nonempty_check", sql`length(${t.issuer}) > 0 and length(${t.subject}) > 0`),
  ],
);

/** Tables carrying `organization_id` that are subject to tenant RLS. */
export const TENANT_TABLES = [
  "memberships",
  "departments",
  "teams",
  "department_memberships",
  "team_memberships",
  "integration_connections",
  "authoring_preferences",
  "integration_operations",
  "briefings",
  "briefing_revisions",
  "publications",
  "briefing_grants",
  "briefing_drafts",
  "publication_previews",
  "revision_evidence",
  "share_links",
  "invitations",
  "sources",
  "source_chunks",
  "briefing_sources",
  "ai_runs",
  "qa_threads",
  "qa_messages",
  "answer_citations",
  "feedback",
  "engagement_events",
  "engagement_insights",
  "audit_events",
  "jobs",
  "retrieval_chunks",
  "briefing_reads",
] as const;
