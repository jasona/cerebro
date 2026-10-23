-- Private per-user reading state: the last revision of a briefing a user
-- opened, for the library's "Unread" / "New version" indicators.
--
-- This is the reader's own data, not author analytics. engagement_events
-- deliberately keys readers by a pseudonymous session id; this table is
-- separate so that pseudonymity is never weakened. Row-level security limits
-- every row to its own user (and organization): authors, admins and other
-- members cannot read it, and no engagement summary uses it.

create table briefing_reads (
  id uuid primary key default gen_random_uuid() not null,
  organization_id uuid not null references organizations (id),
  briefing_id uuid not null,
  user_id uuid not null references users (id),
  last_revision_number integer not null,
  last_opened_at timestamptz not null default now(),
  constraint briefing_reads_org_id_key unique (organization_id, id),
  constraint briefing_reads_user_key unique (organization_id, briefing_id, user_id),
  constraint briefing_reads_revision_check check (last_revision_number >= 1),
  constraint briefing_reads_briefing_fk foreign key (organization_id, briefing_id)
    references briefings (organization_id, id)
);

create index briefing_reads_user_idx on briefing_reads (organization_id, user_id);

grant select, insert, update (last_revision_number, last_opened_at) on briefing_reads to cerebro_app;

alter table briefing_reads enable row level security;
alter table briefing_reads force row level security;

-- Own rows only, inside the current organization. There is deliberately no
-- tenant-wide policy: nobody else (author, admin) can see a user's reads.
create policy briefing_reads_own on briefing_reads to cerebro_app
  using (organization_id = app_current_org() and user_id = app_current_user())
  with check (organization_id = app_current_org() and user_id = app_current_user());
