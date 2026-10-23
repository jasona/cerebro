-- Runtime role, privileges, row-level security and immutability guards.
--
-- The application connects with the owner/migration credentials and switches
-- to cerebro_app per transaction (`SET LOCAL ROLE cerebro_app`, see
-- withAuthContext). cerebro_app owns nothing and has no BYPASSRLS, so every
-- runtime query is subject to the policies below.
--
-- The owner connection must be a superuser or hold BYPASSRLS: tables FORCE
-- row-level security and no policy targets the owner, so a plain owner role
-- would see no rows under withSystemContext.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'cerebro_app') then
    create role cerebro_app nologin nobypassrls;
  end if;
  if not (select rolsuper from pg_roles where rolname = current_user) then
    execute format('grant cerebro_app to %I', current_user);
  end if;
end
$$;

-- Transaction-local authorization context. Unset settings read as '' after a
-- transaction ends, hence nullif.
create or replace function app_current_org() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.org_id', true), '')::uuid $$;

create or replace function app_current_user() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

grant usage on schema public to cerebro_app;
grant execute on function app_current_org(), app_current_user() to cerebro_app;

grant select on users to cerebro_app;
grant update (display_name, avatar_url, updated_at) on users to cerebro_app;
grant select on organizations to cerebro_app;
grant update (name, settings, updated_at) on organizations to cerebro_app;

grant select, insert, update on
  memberships, departments, teams, department_memberships, team_memberships,
  integration_connections, authoring_preferences, integration_operations,
  briefings, briefing_grants, briefing_drafts, publication_previews,
  share_links, invitations, sources, source_chunks, briefing_sources,
  ai_runs, qa_threads, qa_messages, feedback, engagement_insights,
  retrieval_chunks
  to cerebro_app;

grant delete on
  authoring_preferences, publication_previews, briefing_sources,
  source_chunks, retrieval_chunks
  to cerebro_app;

-- Append-only for the runtime role.
grant select, insert on
  briefing_revisions, revision_evidence, audit_events, engagement_events,
  answer_citations, publications, jobs
  to cerebro_app;
revoke update, delete on briefing_revisions, revision_evidence, audit_events from cerebro_app;

-- Withdrawal is the only permitted change to a publication.
grant update (withdrawn_at) on publications to cerebro_app;
revoke delete on publications from cerebro_app;

-- ---------------------------------------------------------------------------
-- Immutability guards (apply to every role, including the owner)
-- ---------------------------------------------------------------------------

create or replace function cerebro_forbid_update() returns trigger
  language plpgsql
  as $$
begin
  raise exception '% rows are immutable', tg_table_name using errcode = 'insufficient_privilege';
end
$$;

create trigger briefing_revisions_immutable before update on briefing_revisions
  for each row execute function cerebro_forbid_update();
create trigger revision_evidence_immutable before update on revision_evidence
  for each row execute function cerebro_forbid_update();
create trigger audit_events_immutable before update on audit_events
  for each row execute function cerebro_forbid_update();

create or replace function cerebro_publication_guard() returns trigger
  language plpgsql
  as $$
begin
  if old.withdrawn_at is not null and new.withdrawn_at is distinct from old.withdrawn_at then
    raise exception 'a withdrawn publication cannot be restored or re-dated' using errcode = 'insufficient_privilege';
  end if;
  if (new.organization_id, new.briefing_id, new.revision_id, new.published_by, new.published_at,
      new.change_summary, new.connection_id)
     is distinct from
     (old.organization_id, old.briefing_id, old.revision_id, old.published_by, old.published_at,
      old.change_summary, old.connection_id) then
    raise exception 'publication records are immutable except for withdrawal' using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;

create trigger publications_guard before update on publications
  for each row execute function cerebro_publication_guard();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

-- Tenant isolation: every tenant row is visible and writable only inside the
-- organization named by app.org_id. Finer-grained rules (audience, grants,
-- drafts, external readers' lack of directory access) are domain-enforced.
do $$
declare
  t text;
begin
  foreach t in array array[
    'memberships', 'departments', 'teams', 'department_memberships', 'team_memberships',
    'integration_connections', 'authoring_preferences', 'integration_operations',
    'briefings', 'briefing_revisions', 'publications', 'briefing_grants', 'briefing_drafts',
    'publication_previews', 'revision_evidence', 'share_links', 'invitations', 'sources',
    'source_chunks', 'briefing_sources', 'ai_runs', 'qa_threads', 'qa_messages',
    'answer_citations', 'feedback', 'engagement_events', 'engagement_insights',
    'audit_events', 'jobs', 'retrieval_chunks'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I to cerebro_app
         using (organization_id = app_current_org())
         with check (organization_id = app_current_org())',
      t);
  end loop;
end
$$;

-- A user can always see their own memberships across companies (company
-- switcher, resolving which company a request belongs to).
create policy memberships_self_read on memberships for select to cerebro_app
  using (user_id = app_current_user());

alter table users enable row level security;
alter table users force row level security;

-- Users are visible to themselves, and to anyone working inside a company
-- they belong to or hold a briefing grant in.
create policy users_read on users for select to cerebro_app
  using (
    id = app_current_user()
    or exists (
      select 1 from memberships m
      where m.user_id = users.id and m.organization_id = app_current_org()
    )
    or exists (
      select 1 from briefing_grants g
      where g.user_id = users.id and g.organization_id = app_current_org()
    )
  );

create policy users_update_self on users for update to cerebro_app
  using (id = app_current_user())
  with check (id = app_current_user());

alter table organizations enable row level security;
alter table organizations force row level security;

create policy organizations_read on organizations for select to cerebro_app
  using (
    id = app_current_org()
    or exists (
      select 1 from memberships m
      where m.organization_id = organizations.id
        and m.user_id = app_current_user()
        and m.status = 'active'
    )
  );

create policy organizations_update on organizations for update to cerebro_app
  using (id = app_current_org())
  with check (id = app_current_org());
