-- AI-assisted composition proposals (W3.3): suggested perspectives and
-- revision proposals for a briefing draft.
--
-- A suggestion is a proposal only (principle 2). It never changes the draft
-- or a publication by itself: the author accepts it, and acceptance writes
-- the draft through the normal lock_version compare-and-increment, or
-- dismisses it. `payload` holds proposed draft content, so it is visible
-- only to the draft's collaborators; the domain layer checks `view_draft`
-- to list and `edit` to request, accept or dismiss. RLS adds the tenant
-- boundary, as for every tenant table.

create table briefing_suggestions (
  id uuid primary key default gen_random_uuid() not null,
  organization_id uuid not null references organizations (id),
  briefing_id uuid not null,
  kind text not null,
  status text not null default 'pending',
  -- Draft lock_version the proposal was generated against.
  base_version integer not null,
  -- Validated proposal: { perspective, rationale } or { operations, scope, explanation }.
  payload jsonb not null,
  provider text not null,
  model text not null,
  ai_run_id uuid,
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  decided_by uuid references users (id),
  decided_at timestamptz,
  -- Draft lock_version written by an accepted suggestion.
  applied_version integer,
  constraint briefing_suggestions_org_id_key unique (organization_id, id),
  constraint briefing_suggestions_kind_check check (kind in ('perspective', 'revision')),
  constraint briefing_suggestions_status_check check (status in ('pending', 'accepted', 'dismissed')),
  constraint briefing_suggestions_base_version_check check (base_version >= 1),
  constraint briefing_suggestions_decision_check check ((status = 'pending') = (decided_at is null)),
  constraint briefing_suggestions_briefing_fk foreign key (organization_id, briefing_id)
    references briefings (organization_id, id),
  constraint briefing_suggestions_ai_run_fk foreign key (organization_id, ai_run_id)
    references ai_runs (organization_id, id)
);

create index briefing_suggestions_briefing_idx on briefing_suggestions (organization_id, briefing_id, status);

-- Proposals are never deleted by the runtime role; only their decision changes.
grant select, insert, update (status, decided_by, decided_at, applied_version) on briefing_suggestions to cerebro_app;

alter table briefing_suggestions enable row level security;
alter table briefing_suggestions force row level security;

create policy tenant_isolation on briefing_suggestions to cerebro_app
  using (organization_id = app_current_org())
  with check (organization_id = app_current_org());

-- A decided suggestion is final.
create or replace function cerebro_suggestion_guard() returns trigger
  language plpgsql
  as $$
begin
  if old.status <> 'pending' then
    raise exception 'a decided suggestion cannot change' using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;

create trigger briefing_suggestions_guard before update on briefing_suggestions
  for each row execute function cerebro_suggestion_guard();
