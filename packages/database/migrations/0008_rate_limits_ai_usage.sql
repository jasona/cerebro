-- Rate-limit counters and AI usage lookups (W4 pilot readiness).
--
-- rate_limit_counters holds fixed-window counters for per-user and
-- per-connection limits on MCP tool calls, reader Q&A and uploads. Limits
-- themselves are configuration (off unless set; none has been agreed). The
-- table lives in Postgres so that every web and worker process shares the
-- same counters. A row carries only ids, a bucket label and a count.
--
-- Rows are private to their user: the counts are a record of one person's
-- activity (including how many private questions they asked), so authors and
-- admins must not be able to read them.

create table rate_limit_counters (
  id uuid primary key default gen_random_uuid() not null,
  organization_id uuid not null references organizations (id),
  user_id uuid not null references users (id),
  -- `<operation>:user` or `<operation>:connection:<connection id>`.
  bucket text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint rate_limit_counters_org_id_key unique (organization_id, id),
  constraint rate_limit_counters_window_key unique (organization_id, user_id, bucket, window_start),
  constraint rate_limit_counters_count_check check (count >= 0),
  constraint rate_limit_counters_bucket_check
    check (bucket ~ '^[a-z_]{1,32}:(user|connection:[0-9a-f-]{36})$')
);

grant select, insert, delete, update (count, updated_at) on rate_limit_counters to cerebro_app;

alter table rate_limit_counters enable row level security;
alter table rate_limit_counters force row level security;

-- Own rows only, inside the current organization (no tenant-wide policy).
create policy rate_limit_counters_own on rate_limit_counters to cerebro_app
  using (organization_id = app_current_org() and user_id = app_current_user())
  with check (organization_id = app_current_org() and user_id = app_current_user());

-- Per-organization AI usage is read from ai_runs (task, provider, model,
-- status, latency and token counts; never content) over a rolling window.
create index ai_runs_org_created_idx on ai_runs (organization_id, created_at);
