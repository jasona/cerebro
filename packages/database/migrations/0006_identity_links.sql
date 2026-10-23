-- Identity links and OAuth connection grants (D08, W2.2).
--
-- user_identities is the explicit link from a verified external identity
-- (issuer + subject) to a Cerebro user. Clerk web sign-in and MCP OAuth
-- bearer tokens both resolve users through it. Clerk authenticates; Cerebro
-- still owns authorization. Links are created only by the identity service
-- (system context): on first sign-in through a pending invitation, or by
-- claiming an unlinked pre-provisioned user with the same verified email.
-- The runtime role can read only its own links and cannot write any.

create table user_identities (
  id uuid primary key default gen_random_uuid() not null,
  user_id uuid not null references users (id),
  -- Token or session issuer, e.g. Clerk's frontend API URL or the configured
  -- OAuth authorization server issuer (CEREBRO_OAUTH_ISSUER).
  issuer text not null,
  subject text not null,
  created_at timestamptz not null default now(),
  constraint user_identities_issuer_subject_key unique (issuer, subject),
  constraint user_identities_user_issuer_key unique (user_id, issuer),
  constraint user_identities_nonempty_check check (length(issuer) > 0 and length(subject) > 0)
);

grant select on user_identities to cerebro_app;

alter table user_identities enable row level security;
alter table user_identities force row level security;

create policy user_identities_own on user_identities for select to cerebro_app
  using (user_id = app_current_user());

-- OAuth grants reuse integration_connections (kind = 'oauth'), so Settings
-- lists them and revocation works exactly like connection tokens.
--   issuer      the authorization server that issued the access tokens
--   not_before  tokens whose auth_time is not after this instant are refused;
--               set when a connection replaces a revoked one, so tokens
--               refreshed from the revoked grant stay refused.
alter table integration_connections add column issuer text;
alter table integration_connections add column not_before timestamptz;

alter table integration_connections
  add constraint integration_connections_oauth_check check (
    (kind = 'oauth' and issuer is not null and token_hash is null)
    or (kind = 'dev_token' and issuer is null and token_hash is not null)
  );

-- At most one active OAuth connection per company, user, issuer and client.
create unique index integration_connections_oauth_active_key
  on integration_connections (organization_id, user_id, issuer, client_id)
  where kind = 'oauth' and status = 'active';

create index integration_connections_oauth_lookup_idx
  on integration_connections (user_id, issuer, client_id)
  where kind = 'oauth';
