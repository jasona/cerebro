-- Retention and deletion mechanism (W4). The retention policy itself (P11)
-- is not set: with no row for a category, data in that category is kept
-- indefinitely, and nothing is deleted.
--
-- Categories:
--   sources        private source originals (objects), extracted chunks and
--                  their embeddings, and briefing-source links
--   conversations  private reader Q&A threads, messages and answer citations
--   events         measured engagement events
--
-- Deliberately not categories here: published revisions and their approved
-- evidence (immutable publication record), submitted feedback, and audit
-- events (append-only; SECURITY_AND_PUBLICATION.md "Audit scope"). Their
-- retention needs the separately defined privileged workflow the planning
-- documents call for once P11 is decided.

create table retention_policies (
  id uuid primary key default gen_random_uuid() not null,
  organization_id uuid not null references organizations (id),
  category text not null,
  -- Null keeps data indefinitely.
  retain_days integer,
  updated_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint retention_policies_org_id_key unique (organization_id, id),
  constraint retention_policies_category_key unique (organization_id, category),
  constraint retention_policies_category_check check (category in ('sources', 'conversations', 'events')),
  constraint retention_policies_days_check check (retain_days is null or retain_days >= 1)
);

grant select, insert, update (retain_days, updated_by, updated_at) on retention_policies to cerebro_app;

alter table retention_policies enable row level security;
alter table retention_policies force row level security;
create policy tenant_isolation on retention_policies to cerebro_app
  using (organization_id = app_current_org())
  with check (organization_id = app_current_org());

-- ---------------------------------------------------------------------------
-- Hard deletion of a private source
-- ---------------------------------------------------------------------------

-- An author (or an admin, as the privileged erasure path) may delete a
-- source; the domain decides who. Chunks and links were already deletable.
grant delete on sources to cerebro_app;

-- Published evidence keeps its approved excerpt (it is part of the immutable
-- revision and governed separately), but its provenance link to a deleted
-- source is severed rather than blocking the deletion.
alter table revision_evidence drop constraint revision_evidence_source_fk;
alter table revision_evidence
  add constraint revision_evidence_source_fk
  foreign key (organization_id, source_id)
  references sources (organization_id, id)
  on delete set null (source_id);

-- revision_evidence stays immutable except for that one change: clearing
-- source_id when the referenced source is deleted.
create or replace function cerebro_revision_evidence_guard() returns trigger
  language plpgsql
  as $$
begin
  if old.source_id is not null and new.source_id is null
     and (to_jsonb(new) - 'source_id') = (to_jsonb(old) - 'source_id') then
    return new;
  end if;
  raise exception '% rows are immutable', tg_table_name using errcode = 'insufficient_privilege';
end
$$;

drop trigger revision_evidence_immutable on revision_evidence;
create trigger revision_evidence_immutable before update on revision_evidence
  for each row execute function cerebro_revision_evidence_guard();
