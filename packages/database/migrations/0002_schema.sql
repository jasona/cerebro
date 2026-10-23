-- Core tables. Generated from src/schema.ts with drizzle-kit, then kept in sync by hand.
-- Any schema.ts change must be reflected in a new migration file.

CREATE TABLE "ai_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_id" uuid,
	"task" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"latency_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"error_category" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "ai_runs_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "ai_runs_status_check" CHECK ("ai_runs"."status" in ('running', 'succeeded', 'failed', 'abstained'))
);

CREATE TABLE "answer_citations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"block_key" text,
	"evidence_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "answer_citations_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "answer_citations_target_check" CHECK (num_nonnulls("answer_citations"."block_key", "answer_citations"."evidence_id") = 1)
);

CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_id" uuid,
	"connection_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid,
	"revision_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_org_id_key" UNIQUE("organization_id","id")
);

CREATE TABLE "authoring_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"default_department_id" uuid,
	"default_team_id" uuid,
	"preferred_style" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authoring_preferences_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "authoring_preferences_org_user_key" UNIQUE("organization_id","user_id"),
	CONSTRAINT "authoring_preferences_team_needs_department_check" CHECK ("authoring_preferences"."default_team_id" is null or "authoring_preferences"."default_department_id" is not null)
);

CREATE TABLE "briefing_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"briefing_id" uuid NOT NULL,
	"document_json" jsonb NOT NULL,
	"schema_version" integer NOT NULL,
	"lock_version" integer DEFAULT 1 NOT NULL,
	"base_revision_id" uuid,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "briefing_drafts_briefing_id_unique" UNIQUE("briefing_id"),
	CONSTRAINT "briefing_drafts_org_id_key" UNIQUE("organization_id","id")
);

CREATE TABLE "briefing_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"briefing_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'reader' NOT NULL,
	"revision_id" uuid,
	"issued_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "briefing_grants_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "briefing_grants_role_check" CHECK ("briefing_grants"."role" in ('reader', 'editor', 'publisher', 'owner')),
	CONSTRAINT "briefing_grants_revision_reader_check" CHECK ("briefing_grants"."revision_id" is null or "briefing_grants"."role" = 'reader')
);

CREATE TABLE "briefing_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"briefing_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"document_json" jsonb NOT NULL,
	"schema_version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "briefing_revisions_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "briefing_revisions_org_briefing_id_key" UNIQUE("organization_id","briefing_id","id"),
	CONSTRAINT "briefing_revisions_number_key" UNIQUE("briefing_id","number"),
	CONSTRAINT "briefing_revisions_number_check" CHECK ("briefing_revisions"."number" > 0)
);

CREATE TABLE "briefing_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"briefing_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "briefing_sources_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "briefing_sources_pair_key" UNIQUE("briefing_id","source_id")
);

CREATE TABLE "briefings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"summary" text,
	"home_department_id" uuid,
	"home_team_id" uuid,
	"visibility" text DEFAULT 'company' NOT NULL,
	"audience_department_id" uuid,
	"audience_team_id" uuid,
	"current_publication_id" uuid,
	"search_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(summary, ''))) STORED,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "briefings_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "briefings_org_slug_key" UNIQUE("organization_id","slug"),
	CONSTRAINT "briefings_visibility_check" CHECK ("briefings"."visibility" in ('company', 'department', 'team', 'restricted')),
	CONSTRAINT "briefings_home_check" CHECK ("briefings"."home_team_id" is null or "briefings"."home_department_id" is not null),
	CONSTRAINT "briefings_audience_check" CHECK (("briefings"."visibility" = 'department' and "briefings"."audience_department_id" is not null and "briefings"."audience_team_id" is null)
       or ("briefings"."visibility" = 'team' and "briefings"."audience_team_id" is not null and "briefings"."audience_department_id" is null)
       or ("briefings"."visibility" in ('company', 'restricted') and "briefings"."audience_department_id" is null and "briefings"."audience_team_id" is null))
);

CREATE TABLE "department_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "department_memberships_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "department_memberships_dept_user_key" UNIQUE("department_id","user_id"),
	CONSTRAINT "department_memberships_status_check" CHECK ("department_memberships"."status" in ('active', 'removed'))
);

CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "departments_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "departments_org_slug_key" UNIQUE("organization_id","slug")
);

CREATE TABLE "engagement_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"briefing_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"event_type" text NOT NULL,
	"block_key" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "engagement_events_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "engagement_events_dedupe_key" UNIQUE("organization_id","dedupe_key"),
	CONSTRAINT "engagement_events_type_check" CHECK ("engagement_events"."event_type" in ('open', 'section_view', 'block_view', 'evidence_open', 'perspective_select', 'question_asked', 'feedback_submitted'))
);

CREATE TABLE "engagement_insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"briefing_id" uuid NOT NULL,
	"revision_id" uuid,
	"topic" text NOT NULL,
	"summary" text,
	"reader_count" integer DEFAULT 0 NOT NULL,
	"question_count" integer DEFAULT 0 NOT NULL,
	"supporting_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"watermark" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "engagement_insights_org_id_key" UNIQUE("organization_id","id")
);

CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"briefing_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"block_key" text,
	"author_id" uuid NOT NULL,
	"type" text NOT NULL,
	"text" text NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"resolution_revision_id" uuid,
	"qa_thread_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "feedback_type_check" CHECK ("feedback"."type" in ('question', 'comment', 'concern', 'correction')),
	CONSTRAINT "feedback_status_check" CHECK ("feedback"."status" in ('submitted', 'acknowledged', 'resolved', 'dismissed'))
);

CREATE TABLE "integration_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text DEFAULT 'dev_token' NOT NULL,
	"label" text NOT NULL,
	"client_id" text NOT NULL,
	"grant_ref" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"token_hash" text,
	"token_prefix" text,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_connections_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "integration_connections_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "integration_connections_kind_check" CHECK ("integration_connections"."kind" in ('dev_token', 'oauth')),
	CONSTRAINT "integration_connections_status_check" CHECK ("integration_connections"."status" in ('active', 'revoked'))
);

CREATE TABLE "integration_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"connection_id" uuid,
	"action" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"input_digest" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"resource_type" text,
	"resource_id" uuid,
	"result" jsonb,
	"error_category" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "integration_operations_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "integration_operations_idempotency_key" UNIQUE NULLS NOT DISTINCT("organization_id","actor_id","connection_id","action","idempotency_key"),
	CONSTRAINT "integration_operations_status_check" CHECK ("integration_operations"."status" in ('pending', 'succeeded', 'failed'))
);

CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"kind" text NOT NULL,
	"membership_role" text,
	"briefing_id" uuid,
	"grant_role" text,
	"revision_id" uuid,
	"token_hash" text NOT NULL,
	"invited_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invitations_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "invitations_kind_check" CHECK ("invitations"."kind" in ('membership', 'briefing_grant')),
	CONSTRAINT "invitations_target_check" CHECK (("invitations"."kind" = 'membership' and "invitations"."membership_role" in ('admin', 'member') and "invitations"."briefing_id" is null)
       or ("invitations"."kind" = 'briefing_grant' and "invitations"."briefing_id" is not null and "invitations"."grant_role" in ('reader', 'editor', 'publisher')))
);

CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error_category" text,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "jobs_status_check" CHECK ("jobs"."status" in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "jobs_attempts_check" CHECK ("jobs"."attempts" >= 0 and "jobs"."max_attempts" > 0)
);

CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "memberships_org_user_key" UNIQUE("organization_id","user_id"),
	CONSTRAINT "memberships_role_check" CHECK ("memberships"."role" in ('owner', 'admin', 'member')),
	CONSTRAINT "memberships_status_check" CHECK ("memberships"."status" in ('active', 'invited', 'suspended', 'removed'))
);

CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);

CREATE TABLE "publication_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"briefing_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"connection_id" uuid,
	"draft_lock_version" integer NOT NULL,
	"content_digest" text NOT NULL,
	"evidence_digest" text NOT NULL,
	"home_department_id" uuid,
	"home_team_id" uuid,
	"visibility" text NOT NULL,
	"audience_department_id" uuid,
	"audience_team_id" uuid,
	"audience_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"publication_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publication_previews_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "publication_previews_visibility_check" CHECK ("publication_previews"."visibility" in ('company', 'department', 'team', 'restricted'))
);

CREATE TABLE "publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"briefing_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"published_by" uuid NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"change_summary" text,
	"connection_id" uuid,
	"withdrawn_at" timestamp with time zone,
	CONSTRAINT "publications_revision_id_unique" UNIQUE("revision_id"),
	CONSTRAINT "publications_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "publications_org_briefing_id_key" UNIQUE("organization_id","briefing_id","id")
);

CREATE TABLE "qa_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"generation_status" text DEFAULT 'complete' NOT NULL,
	"ai_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_messages_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "qa_messages_org_revision_id_key" UNIQUE("organization_id","revision_id","id"),
	CONSTRAINT "qa_messages_role_check" CHECK ("qa_messages"."role" in ('reader', 'assistant')),
	CONSTRAINT "qa_messages_generation_status_check" CHECK ("qa_messages"."generation_status" in ('pending', 'complete', 'abstained', 'failed'))
);

CREATE TABLE "qa_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"briefing_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"reader_id" uuid NOT NULL,
	"perspective_key" text,
	"visibility" text DEFAULT 'private' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_threads_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "qa_threads_org_revision_id_key" UNIQUE("organization_id","revision_id","id"),
	CONSTRAINT "qa_threads_visibility_check" CHECK ("qa_threads"."visibility" in ('private'))
);

CREATE TABLE "retrieval_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"briefing_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"section_key" text,
	"block_key" text,
	"evidence_id" uuid,
	"ordinal" integer NOT NULL,
	"text" text NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
	"embedding" vector,
	"embedding_model" text,
	"embedding_dims" integer,
	"is_current" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retrieval_chunks_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "retrieval_chunks_ordinal_key" UNIQUE("revision_id","ordinal"),
	CONSTRAINT "retrieval_chunks_kind_check" CHECK ("retrieval_chunks"."kind" in ('block', 'evidence')),
	CONSTRAINT "retrieval_chunks_target_check" CHECK (("retrieval_chunks"."kind" = 'block' and "retrieval_chunks"."block_key" is not null and "retrieval_chunks"."evidence_id" is null)
       or ("retrieval_chunks"."kind" = 'evidence' and "retrieval_chunks"."evidence_id" is not null))
);

CREATE TABLE "revision_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"evidence_key" text NOT NULL,
	"title" text NOT NULL,
	"excerpt" text NOT NULL,
	"attribution" text,
	"locator" text,
	"origin" text DEFAULT 'manual' NOT NULL,
	"source_id" uuid,
	"excerpt_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "revision_evidence_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "revision_evidence_org_revision_id_key" UNIQUE("organization_id","revision_id","id"),
	CONSTRAINT "revision_evidence_key_key" UNIQUE("revision_id","evidence_key"),
	CONSTRAINT "revision_evidence_origin_check" CHECK ("revision_evidence"."origin" in ('llm_handoff', 'upload', 'manual'))
);

CREATE TABLE "share_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"briefing_id" uuid NOT NULL,
	"revision_id" uuid,
	"token_hash" text NOT NULL,
	"access_policy" text DEFAULT 'authenticated_authorized' NOT NULL,
	"created_by" uuid NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_links_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "share_links_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "share_links_access_policy_check" CHECK ("share_links"."access_policy" in ('authenticated_authorized'))
);

CREATE TABLE "source_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"text" text NOT NULL,
	"locator" text,
	"embedding" vector,
	"embedding_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_chunks_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "source_chunks_ordinal_key" UNIQUE("source_id","ordinal")
);

CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"object_key" text,
	"text_content" text,
	"mime_type" text,
	"byte_size" integer,
	"checksum" text NOT NULL,
	"extraction_status" text DEFAULT 'pending' NOT NULL,
	"extraction_error_category" text,
	"connection_id" uuid,
	"attribution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "sources_kind_check" CHECK ("sources"."kind" in ('upload', 'text', 'llm_handoff')),
	CONSTRAINT "sources_extraction_status_check" CHECK ("sources"."extraction_status" in ('pending', 'running', 'succeeded', 'failed')),
	CONSTRAINT "sources_content_check" CHECK ("sources"."object_key" is not null or "sources"."text_content" is not null)
);

CREATE TABLE "team_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_memberships_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "team_memberships_team_user_key" UNIQUE("team_id","user_id"),
	CONSTRAINT "team_memberships_status_check" CHECK ("team_memberships"."status" in ('active', 'removed'))
);

CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teams_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "teams_org_dept_id_key" UNIQUE("organization_id","department_id","id"),
	CONSTRAINT "teams_dept_slug_key" UNIQUE("organization_id","department_id","slug")
);

CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auth_subject" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_auth_subject_unique" UNIQUE("auth_subject")
);

ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "answer_citations" ADD CONSTRAINT "answer_citations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "answer_citations" ADD CONSTRAINT "answer_citations_message_fk" FOREIGN KEY ("organization_id","revision_id","message_id") REFERENCES "public"."qa_messages"("organization_id","revision_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "answer_citations" ADD CONSTRAINT "answer_citations_evidence_fk" FOREIGN KEY ("organization_id","revision_id","evidence_id") REFERENCES "public"."revision_evidence"("organization_id","revision_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "authoring_preferences" ADD CONSTRAINT "authoring_preferences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "authoring_preferences" ADD CONSTRAINT "authoring_preferences_membership_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "authoring_preferences" ADD CONSTRAINT "authoring_preferences_department_fk" FOREIGN KEY ("organization_id","default_department_id") REFERENCES "public"."departments"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "authoring_preferences" ADD CONSTRAINT "authoring_preferences_team_fk" FOREIGN KEY ("organization_id","default_department_id","default_team_id") REFERENCES "public"."teams"("organization_id","department_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "briefing_drafts" ADD CONSTRAINT "briefing_drafts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "briefing_drafts" ADD CONSTRAINT "briefing_drafts_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "briefing_drafts" ADD CONSTRAINT "briefing_drafts_briefing_fk" FOREIGN KEY ("organization_id","briefing_id") REFERENCES "public"."briefings"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "briefing_drafts" ADD CONSTRAINT "briefing_drafts_base_revision_fk" FOREIGN KEY ("organization_id","briefing_id","base_revision_id") REFERENCES "public"."briefing_revisions"("organization_id","briefing_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "briefing_grants" ADD CONSTRAINT "briefing_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "briefing_grants" ADD CONSTRAINT "briefing_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "briefing_grants" ADD CONSTRAINT "briefing_grants_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "briefing_grants" ADD CONSTRAINT "briefing_grants_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "briefing_grants" ADD CONSTRAINT "briefing_grants_briefing_fk" FOREIGN KEY ("organization_id","briefing_id") REFERENCES "public"."briefings"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "briefing_grants" ADD CONSTRAINT "briefing_grants_revision_fk" FOREIGN KEY ("organization_id","briefing_id","revision_id") REFERENCES "public"."briefing_revisions"("organization_id","briefing_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "briefing_revisions" ADD CONSTRAINT "briefing_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "briefing_revisions" ADD CONSTRAINT "briefing_revisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "briefing_revisions" ADD CONSTRAINT "briefing_revisions_briefing_fk" FOREIGN KEY ("organization_id","briefing_id") REFERENCES "public"."briefings"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "briefing_sources" ADD CONSTRAINT "briefing_sources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "briefing_sources" ADD CONSTRAINT "briefing_sources_briefing_fk" FOREIGN KEY ("organization_id","briefing_id") REFERENCES "public"."briefings"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "briefing_sources" ADD CONSTRAINT "briefing_sources_source_fk" FOREIGN KEY ("organization_id","source_id") REFERENCES "public"."sources"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "briefings" ADD CONSTRAINT "briefings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "briefings" ADD CONSTRAINT "briefings_owner_membership_fk" FOREIGN KEY ("organization_id","owner_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "briefings" ADD CONSTRAINT "briefings_home_department_fk" FOREIGN KEY ("organization_id","home_department_id") REFERENCES "public"."departments"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "briefings" ADD CONSTRAINT "briefings_home_team_fk" FOREIGN KEY ("organization_id","home_department_id","home_team_id") REFERENCES "public"."teams"("organization_id","department_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "briefings" ADD CONSTRAINT "briefings_audience_department_fk" FOREIGN KEY ("organization_id","audience_department_id") REFERENCES "public"."departments"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "briefings" ADD CONSTRAINT "briefings_audience_team_fk" FOREIGN KEY ("organization_id","audience_team_id") REFERENCES "public"."teams"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "briefings" ADD CONSTRAINT "briefings_current_publication_fk" FOREIGN KEY ("organization_id","id","current_publication_id") REFERENCES "public"."publications"("organization_id","briefing_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "department_memberships" ADD CONSTRAINT "department_memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "department_memberships" ADD CONSTRAINT "department_memberships_department_fk" FOREIGN KEY ("organization_id","department_id") REFERENCES "public"."departments"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "department_memberships" ADD CONSTRAINT "department_memberships_membership_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "departments" ADD CONSTRAINT "departments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "engagement_events" ADD CONSTRAINT "engagement_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "engagement_events" ADD CONSTRAINT "engagement_events_revision_fk" FOREIGN KEY ("organization_id","briefing_id","revision_id") REFERENCES "public"."briefing_revisions"("organization_id","briefing_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "engagement_insights" ADD CONSTRAINT "engagement_insights_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "engagement_insights" ADD CONSTRAINT "engagement_insights_briefing_fk" FOREIGN KEY ("organization_id","briefing_id") REFERENCES "public"."briefings"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "engagement_insights" ADD CONSTRAINT "engagement_insights_revision_fk" FOREIGN KEY ("organization_id","briefing_id","revision_id") REFERENCES "public"."briefing_revisions"("organization_id","briefing_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_revision_fk" FOREIGN KEY ("organization_id","briefing_id","revision_id") REFERENCES "public"."briefing_revisions"("organization_id","briefing_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_resolution_revision_fk" FOREIGN KEY ("organization_id","briefing_id","resolution_revision_id") REFERENCES "public"."briefing_revisions"("organization_id","briefing_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_qa_thread_fk" FOREIGN KEY ("organization_id","qa_thread_id") REFERENCES "public"."qa_threads"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_membership_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "integration_operations" ADD CONSTRAINT "integration_operations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "integration_operations" ADD CONSTRAINT "integration_operations_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "integration_operations" ADD CONSTRAINT "integration_operations_connection_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "public"."integration_connections"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_briefing_fk" FOREIGN KEY ("organization_id","briefing_id") REFERENCES "public"."briefings"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_revision_fk" FOREIGN KEY ("organization_id","briefing_id","revision_id") REFERENCES "public"."briefing_revisions"("organization_id","briefing_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "publication_previews" ADD CONSTRAINT "publication_previews_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "publication_previews" ADD CONSTRAINT "publication_previews_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "publication_previews" ADD CONSTRAINT "publication_previews_briefing_fk" FOREIGN KEY ("organization_id","briefing_id") REFERENCES "public"."briefings"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "publication_previews" ADD CONSTRAINT "publication_previews_connection_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "public"."integration_connections"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "publication_previews" ADD CONSTRAINT "publication_previews_publication_fk" FOREIGN KEY ("organization_id","briefing_id","publication_id") REFERENCES "public"."publications"("organization_id","briefing_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "publications" ADD CONSTRAINT "publications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "publications" ADD CONSTRAINT "publications_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "publications" ADD CONSTRAINT "publications_revision_fk" FOREIGN KEY ("organization_id","briefing_id","revision_id") REFERENCES "public"."briefing_revisions"("organization_id","briefing_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "publications" ADD CONSTRAINT "publications_connection_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "public"."integration_connections"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "qa_messages" ADD CONSTRAINT "qa_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "qa_messages" ADD CONSTRAINT "qa_messages_thread_fk" FOREIGN KEY ("organization_id","revision_id","thread_id") REFERENCES "public"."qa_threads"("organization_id","revision_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "qa_messages" ADD CONSTRAINT "qa_messages_ai_run_fk" FOREIGN KEY ("organization_id","ai_run_id") REFERENCES "public"."ai_runs"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "qa_threads" ADD CONSTRAINT "qa_threads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "qa_threads" ADD CONSTRAINT "qa_threads_reader_id_users_id_fk" FOREIGN KEY ("reader_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "qa_threads" ADD CONSTRAINT "qa_threads_revision_fk" FOREIGN KEY ("organization_id","briefing_id","revision_id") REFERENCES "public"."briefing_revisions"("organization_id","briefing_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "retrieval_chunks" ADD CONSTRAINT "retrieval_chunks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "retrieval_chunks" ADD CONSTRAINT "retrieval_chunks_revision_fk" FOREIGN KEY ("organization_id","briefing_id","revision_id") REFERENCES "public"."briefing_revisions"("organization_id","briefing_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "retrieval_chunks" ADD CONSTRAINT "retrieval_chunks_evidence_fk" FOREIGN KEY ("organization_id","revision_id","evidence_id") REFERENCES "public"."revision_evidence"("organization_id","revision_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "revision_evidence" ADD CONSTRAINT "revision_evidence_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "revision_evidence" ADD CONSTRAINT "revision_evidence_revision_fk" FOREIGN KEY ("organization_id","revision_id") REFERENCES "public"."briefing_revisions"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "revision_evidence" ADD CONSTRAINT "revision_evidence_source_fk" FOREIGN KEY ("organization_id","source_id") REFERENCES "public"."sources"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_briefing_fk" FOREIGN KEY ("organization_id","briefing_id") REFERENCES "public"."briefings"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_revision_fk" FOREIGN KEY ("organization_id","briefing_id","revision_id") REFERENCES "public"."briefing_revisions"("organization_id","briefing_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "source_chunks" ADD CONSTRAINT "source_chunks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "source_chunks" ADD CONSTRAINT "source_chunks_source_fk" FOREIGN KEY ("organization_id","source_id") REFERENCES "public"."sources"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "sources" ADD CONSTRAINT "sources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "sources" ADD CONSTRAINT "sources_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "sources" ADD CONSTRAINT "sources_connection_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "public"."integration_connections"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_team_fk" FOREIGN KEY ("organization_id","team_id") REFERENCES "public"."teams"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_membership_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "teams" ADD CONSTRAINT "teams_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "teams" ADD CONSTRAINT "teams_department_fk" FOREIGN KEY ("organization_id","department_id") REFERENCES "public"."departments"("organization_id","id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "audit_events_target_idx" ON "audit_events" USING btree ("organization_id","target_type","target_id","occurred_at");
CREATE INDEX "briefing_grants_user_idx" ON "briefing_grants" USING btree ("organization_id","user_id");
CREATE UNIQUE INDEX "briefing_grants_active_key" ON "briefing_grants" USING btree ("briefing_id","user_id","role",coalesce("revision_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE revoked_at is null;
CREATE INDEX "briefings_owner_idx" ON "briefings" USING btree ("organization_id","owner_id");
CREATE INDEX "briefings_home_idx" ON "briefings" USING btree ("organization_id","home_department_id","home_team_id");
CREATE INDEX "briefings_search_idx" ON "briefings" USING gin ("search_tsv");
CREATE INDEX "department_memberships_user_idx" ON "department_memberships" USING btree ("organization_id","user_id");
CREATE INDEX "engagement_events_revision_idx" ON "engagement_events" USING btree ("organization_id","revision_id","occurred_at");
CREATE INDEX "engagement_insights_briefing_idx" ON "engagement_insights" USING btree ("organization_id","briefing_id");
CREATE INDEX "feedback_revision_idx" ON "feedback" USING btree ("organization_id","briefing_id","revision_id");
CREATE INDEX "integration_connections_user_idx" ON "integration_connections" USING btree ("organization_id","user_id");
CREATE INDEX "invitations_email_idx" ON "invitations" USING btree ("organization_id","email");
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("status","kind","run_after");
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");
CREATE INDEX "publication_previews_briefing_idx" ON "publication_previews" USING btree ("organization_id","briefing_id");
CREATE INDEX "publications_briefing_idx" ON "publications" USING btree ("organization_id","briefing_id","published_at");
CREATE INDEX "qa_messages_thread_idx" ON "qa_messages" USING btree ("organization_id","thread_id","created_at");
CREATE INDEX "qa_threads_reader_idx" ON "qa_threads" USING btree ("organization_id","reader_id","revision_id");
CREATE INDEX "retrieval_chunks_revision_idx" ON "retrieval_chunks" USING btree ("organization_id","revision_id");
CREATE INDEX "retrieval_chunks_tsv_idx" ON "retrieval_chunks" USING gin ("tsv");
CREATE INDEX "share_links_briefing_idx" ON "share_links" USING btree ("organization_id","briefing_id");
CREATE INDEX "sources_creator_idx" ON "sources" USING btree ("organization_id","created_by");
CREATE INDEX "team_memberships_user_idx" ON "team_memberships" USING btree ("organization_id","user_id");
CREATE UNIQUE INDEX "users_email_lower_idx" ON "users" USING btree (lower("email"));