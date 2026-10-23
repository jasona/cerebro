# @cerebro/integrations

Cerebro's remote MCP adapter: "Send this to Cerebro" from an executive's LLM. It is served by the web app at `/api/mcp` over Streamable HTTP. It runs statelessly, so every request is authenticated and handled by a fresh server (T21). Every tool calls the same domain services as the web app.

Tools: `get_authoring_context`, `create_brief_draft`, `get_operation`, `find_briefs`, `get_brief`, `update_brief_draft`, `preview_brief`, `publish_brief`, `get_author_feedback`. See `llm-docs/LLM_INTEGRATION.md`.

## Authorization

`/api/mcp` accepts two bearer credentials (`src/auth.ts`):

| Credential | When | Scopes |
| --- | --- | --- |
| OAuth access token (JWT) | Production path. On only when `CEREBRO_OAUTH_ISSUER` is set | From the token's `scope` (or `scp`) claim |
| Connection token `cbr_…` | D08 dev/test stand-in. Refused when `NODE_ENV=production` unless `CEREBRO_ALLOW_DEV_CONNECTION_TOKENS=1` | All scopes; the user's own permissions still apply |

**OAuth (resource-server side, `src/oauth.ts`).** Cerebro does not issue tokens. The authorization server is Clerk (D13), the same instance as web sign-in; setup is in [Connect an LLM host via Clerk OAuth](#connect-an-llm-host-via-clerk-oauth).

- Protected Resource Metadata (RFC 9728) is served at `/.well-known/oauth-protected-resource/api/mcp` and at the root form. It returns 404 while `CEREBRO_OAUTH_ISSUER` is unset.
- A 401 response carries `WWW-Authenticate: Bearer resource_metadata="…", scope="…"`.
- Each token is verified against the issuer's JWKS, using `CEREBRO_OAUTH_JWKS_URL` or discovery from the issuer's RFC 8414 or OpenID metadata (for Clerk, `<issuer>/.well-known/oauth-authorization-server` names `<issuer>/.well-known/jwks.json`). Discovery and JWKS requests time out after 5 seconds, and a failed discovery is not cached (D11). Only asymmetric algorithms are accepted. The token must also have:
  - `iss` equal to the configured issuer;
  - `aud` containing `APP_URL + /api/mcp`. This comes only from `APP_URL`, never from the Host header, so OAuth stays off until `APP_URL` is set. Clerk sets `aud` from the RFC 8707 `resource` the host sends, but only when the instance setting `aud_claim_enabled` is on;
  - a valid `exp` and a `sub`;
  - no `act` claim (RFC 8693 token exchange). Cerebro has no delegation chains.
- `CEREBRO_OAUTH_PROFILE` selects the remaining rules:

  | Profile | `typ` header | Client | For |
  | --- | --- | --- | --- |
  | `clerk` (default) | Must be `at+jwt` (or `application/at+jwt`) | `client_id` only | Clerk. Its session tokens and M2M tokens are signed by the same keys with the same issuer but are not `at+jwt` and have no `client_id`, so they are refused even if custom session claims add an `aud`. Clerk's `azp` is the frontend origin, not the OAuth client |
  | `generic` | Not checked | `client_id`, else `azp` | Another RFC 9068-style authorization server |

  An unknown profile value throws `OAuthConfigError` rather than falling back.
- Opaque tokens (Clerk `oat_…`) are refused with "only JWT access tokens are accepted". Clerk must issue JWT access tokens.
- The domain call `authenticateOAuthGrant` maps `sub` to a user. The mapping uses only the explicit `user_identities` link for (issuer, subject); unknown subjects are refused and nobody is provisioned. Clerk web sign-in writes that link as (session `iss`, Clerk user id), and Clerk OAuth tokens carry the same `iss` and `sub`, so one Clerk user is one Cerebro user on both paths. A user must sign in to the web app once before a host can connect.
- The grant is recorded as an `integration_connections` row with `kind = 'oauth'`, one per company, user, issuer and client. It appears in Settings → Connections and is revoked there.
- A revoked grant refuses every token until the user authorizes again: the token's `auth_time` must be later than the revocation.
- **Without `auth_time` (Clerk).** Clerk access tokens carry no `auth_time` and Clerk refresh tokens do not expire, so a token from a fresh authorization cannot be told apart from one refreshed from the revoked grant. A revoked Clerk grant therefore stays refused (fail-closed). The way back is **Reconnect** on the revoked connection in Settings → Connections (`reconnectOAuthConnection`): an explicit, audited (`connection.reconnected`) action by the owner in their web session, which needs active membership and is never available over MCP. After it, only tokens whose `iat` is after the reconnection are accepted (`issued_after`, migration 0010), so every access token issued earlier, including any obtained while the grant was revoked, stays refused until it expires. Reconnecting trusts the client's existing refresh token again. To cut a host off for good, leave the connection revoked and delete or block the client in Clerk.
- Clerk cannot revoke JWT access tokens. Cerebro enforces revocation itself on every request, and an issued token otherwise lives until `exp` (one day in Clerk).
- Active membership is rechecked on every request.
- A connection is bound to one company. On first use it binds to the user's only active company. A user with several active companies gets 403 `company_selection_required`; no company-selection step exists yet.

**Scopes (`src/scopes.ts`).** Scopes are independent and bound what a host may attempt. Resource permissions are still enforced by the domain.

| Scope | Tools |
| --- | --- |
| `cerebro:read` | `get_authoring_context`, `get_operation`, `find_briefs`, `get_brief`, `get_author_feedback` |
| `cerebro:draft` | `create_brief_draft`, `update_brief_draft`, `preview_brief` |
| `cerebro:publish` | `publish_brief` |

A `tools/call` without the required scope gets HTTP 403 with `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"`, which lets a host request step-up authorization. The server also rechecks the scope per tool.

## Connect an LLM host via Clerk OAuth

Clerk is the MCP authorization server (D13). It registers the host, signs the user in, shows consent and issues the access token. Cerebro only verifies the token. Use the same Clerk instance as web sign-in (`AUTH_MODE=clerk`, T23). These steps were written from Clerk's documentation and API specification (2026-10-23) and have not yet been run against a live instance; dashboard labels may differ slightly.

**Prerequisites.** `APP_URL` is the public HTTPS origin the host can reach (hosted connectors such as Claude.ai and ChatGPT call it from their cloud, so `localhost` only works for Claude Code and other local clients). The Clerk instance uses Clerk's current OAuth implementation, not the legacy one. Each user signs in to Cerebro on the web once before connecting, which creates their identity link.

### 1. Find the issuer

The issuer is the instance's Frontend API URL: `https://<name>.clerk.accounts.dev` for a development instance, `https://clerk.<your-domain>` for production. It is shown under **API keys** in the Clerk Dashboard and is encoded in the publishable key. Confirm it:

```sh
curl -s https://clerk.<your-domain>/.well-known/oauth-authorization-server | jq '{issuer, jwks_uri, registration_endpoint, scopes_supported}'
```

`issuer` must be exactly the value you will put in `CEREBRO_OAUTH_ISSUER`, with no trailing slash. It is also the `iss` of Clerk web sessions. If they ever differ, the web app logs `oauth.issuer_mismatch` and every MCP connection fails with "not linked to a Cerebro user".

### 2. Configure Clerk

In the Clerk Dashboard, open **OAuth applications**.

1. **Scopes tab.** Create three custom scopes, `cerebro:read`, `cerebro:draft` and `cerebro:publish`, with plain-language descriptions for the consent screen (for example "Read your briefs and feedback", "Create and update drafts", "Publish briefs you have reviewed"). Mark them advertised so they appear in `scopes_supported`.
2. **Settings tab.**
   - **Access token format: JWT.** Cerebro refuses opaque `oat_…` tokens. JWT is the default for new instances; older instances may still be on opaque.
   - **Client onboarding.** Turn on **Publish CIMD support** (Client ID Metadata Documents: the host's client id is an HTTPS URL; Clerk prefers it, and it always requires PKCE `S256`). Turn on **Publish DCR support** (RFC 7591 dynamic registration) only if a host you use does not support CIMD; the consent screen is then always on. Set **Default scopes for dynamic clients** to `cerebro:read cerebro:draft` for hosts that omit `scope`; a host that needs `cerebro:publish` gets a 403 `insufficient_scope` challenge and asks for it.
   - Keep the **consent screen** on.
3. **Settings that have no dashboard control yet**, through the Backend API (or `npx clerk@latest api instance/oauth_application_settings -X PATCH -d '…'`). `aud_claim_enabled` is required: without it Clerk drops the RFC 8707 `resource` from the token, the token has no `aud`, and Cerebro refuses it.

   ```sh
   curl -s -X PATCH https://api.clerk.com/v1/instance/oauth_application_settings \
     -H "Authorization: Bearer $CLERK_SECRET_KEY" -H "Content-Type: application/json" \
     -d '{
       "oauth_jwt_access_tokens": true,
       "aud_claim_enabled": true,
       "pkce_required": true,
       "client_id_metadata_documents_advertised": true,
       "dynamic_client_allowed_scopes": ["openid", "profile", "email", "offline_access", "cerebro:read", "cerebro:draft", "cerebro:publish"],
       "default_scopes": ["cerebro:read", "cerebro:draft"]
     }'
   curl -s https://api.clerk.com/v1/instance/oauth_application_settings -H "Authorization: Bearer $CLERK_SECRET_KEY"
   ```

   Add `"dynamic_oauth_client_registration": true` only if a host needs DCR. To admit only hosts you have approved, also set `"client_id_metadata_documents_only_allow_pre_registered_clients": true` and pre-register each host's CIMD URL in the dashboard.
4. **Redirect URIs.** CIMD and DCR clients bring their own redirect URIs, so nothing is configured for them. Only a manually created OAuth application (a pre-registered, confidential client) needs them, for example `https://claude.ai/api/mcp/auth_callback` for Claude and `https://chatgpt.com/connector_platform_oauth_redirect` for ChatGPT. Check each host's current documentation for the exact value.

### 3. Configure Cerebro

```sh
AUTH_MODE=clerk
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_…   # from Clerk → API keys
CLERK_SECRET_KEY=sk_live_…
APP_URL=https://cerebro.example.com           # public origin, no trailing slash
CEREBRO_OAUTH_ISSUER=https://clerk.example.com
# CEREBRO_OAUTH_PROFILE=clerk                 # the default
```

Do not set `CEREBRO_ALLOW_DEV_CONNECTION_TOKENS` in production. Restart the app.

### 4. Verify the protected resource

```sh
curl -s https://cerebro.example.com/.well-known/oauth-protected-resource/api/mcp
# {"resource":"https://cerebro.example.com/api/mcp","authorization_servers":["https://clerk.example.com"],
#  "scopes_supported":["cerebro:read","cerebro:draft","cerebro:publish"],"bearer_methods_supported":["header"],"resource_name":"Cerebro"}

curl -si -X POST https://cerebro.example.com/api/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -i www-authenticate
# WWW-Authenticate: Bearer realm="cerebro", error_description="Authorization required.",
#   resource_metadata="https://cerebro.example.com/.well-known/oauth-protected-resource/api/mcp", scope="cerebro:read cerebro:draft cerebro:publish"
```

A 404 from the metadata URL means `CEREBRO_OAUTH_ISSUER` or `APP_URL` is unset. `resource` must be exactly `APP_URL/api/mcp`: hosts send it to Clerk as the RFC 8707 `resource`, and it comes back as the token's `aud`.

### 5. Connect a host

**Claude Code**

```sh
claude mcp add --transport http cerebro https://cerebro.example.com/api/mcp
```

Run `claude`, then `/mcp`, choose `cerebro` and authenticate. A browser opens on Clerk's sign-in and consent screen; sign in as the same user as on the web and allow. If you pre-registered a confidential client in Clerk instead of CIMD/DCR, pass its credentials with `--client-id` and `--client-secret` (see Claude Code's MCP documentation).

**Claude (claude.ai, Desktop)**: Settings → Connectors → **Add custom connector**, name `Cerebro`, URL `https://cerebro.example.com/api/mcp`, then **Connect** and complete Clerk's consent. Organization owners may need to add the connector for the organization first.

**ChatGPT**: Settings → Apps & Connectors → Advanced, turn on developer mode, then **Create** a connector with URL `https://cerebro.example.com/api/mcp` and authentication **OAuth**. ChatGPT reads the protected-resource metadata, registers with Clerk (CIMD or DCR) and opens Clerk's consent. Workspace plans may require an admin to enable custom connectors.

### 6. Check the result

In Cerebro, **Settings → Connections** lists the new OAuth connection (one per company, user and client), with its last use. Ask the host to "get my Cerebro authoring context": it should name your company and you. Revoke the connection there to cut the host off on its next request; use **Reconnect** to trust it again (see "Without `auth_time`" above).

**Troubleshooting** (the 401 `error_description` says which):

| Symptom | Cause |
| --- | --- |
| "only JWT access tokens are accepted" | Clerk is issuing opaque tokens. Set the access token format to JWT |
| "Invalid access token." right after consent | Usually no or wrong `aud`: `aud_claim_enabled` is off, or the host did not send `resource`. Otherwise the issuer differs from `CEREBRO_OAUTH_ISSUER`, or the token is not `typ: at+jwt` |
| "not linked to a Cerebro user" | The user has not signed in to the web app yet, or the web session issuer differs from `CEREBRO_OAUTH_ISSUER` |
| 403 `company_selection_required` | The user belongs to more than one company; no company-selection step exists yet |
| 403 `insufficient_scope` | The grant lacks the tool's scope; the host should ask for it, or add the scope to the client in Clerk |
| "connection was revoked" | Reconnect it in Settings → Connections |

## Connect a local MCP client

Connection tokens are the D08 **dev/test stand-in** for OAuth. The endpoint refuses connection tokens when `NODE_ENV=production`, unless `CEREBRO_ALLOW_DEV_CONNECTION_TOKENS=1` is set.

1. Run the app (`npm run dev`) and sign in at `http://localhost:3000/dev/sign-in`.
2. Open **Settings → Connections** (`/c/<company>/settings`) and create a token. It looks like `cbr_…` and is shown once. Each token is bound to one company and one user. Revoke it there at any time; the next request then fails with 401.
3. Configure a client with the token as a bearer header. Never paste the token into a conversation or tool arguments.

**Claude Code**

```sh
claude mcp add --transport http cerebro http://localhost:3000/api/mcp \
  --header "Authorization: Bearer cbr_…"
```

**Claude Desktop** (or any client that supports remote HTTP servers with custom headers): add a server with URL `http://localhost:3000/api/mcp` and the header `Authorization: Bearer cbr_…`. If your build only supports stdio servers, bridge with `npx mcp-remote http://localhost:3000/api/mcp --header "Authorization: Bearer cbr_…"`.

**MCP Inspector**

```sh
npx @modelcontextprotocol/inspector
```

Choose transport "Streamable HTTP" and URL `http://localhost:3000/api/mcp`. Then add the `Authorization: Bearer cbr_…` header in the authentication settings.

**ChatGPT** and other hosted clients connect through Clerk OAuth ([Connect an LLM host via Clerk OAuth](#connect-an-llm-host-via-clerk-oauth)) and need a publicly reachable HTTPS `APP_URL`. They cannot connect with dev connection tokens.

## Behavior notes

- Drafts are private. `publish_brief` publishes exactly the reviewed `preview_id`. Its description tells the host model to call it only after the human has seen the preview and explicitly asked to publish. Any change after a preview makes the preview stale.
- Mutations take an `idempotency_key`. Retrying with the same key returns the original result. Reusing the key with a different payload returns `idempotency_mismatch`.
- Ambiguous or missing destinations, and named readers who are not company members, return `status: "needs_clarification"` and create nothing. External readers are invited from Cerebro's Access page (D10).
- Connection revocation is enforced here, per request. The adapter is stateless and authenticates every request against the connection before any tool runs, so a revoked or expired connection fails with 401 on the very next request. The domain's `withAuthContext` records `connectionId` for audit but does not recheck the connection itself; any new entry point that accepts `via: "mcp"` must authenticate each request the same way (D10). Covered by `test/mcp.test.ts` ("a revoked connection is unauthenticated on the next request").
- Every preview returns a text summary plus an authenticated link to `/c/<company>/b/<slug>/preview`, where evidence toggles and Publish are available. Hosts that support MCP Apps also render an inline preview (next section).

## MCP Apps inline preview (T14, W3.1)

Implemented against the MCP Apps extension `io.modelcontextprotocol/ui`, stable spec **2026-01-26** (SEP-1865, [`specification/2026-01-26/apps.mdx`](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)). The server side uses the official `@modelcontextprotocol/ext-apps` 1.7.x helpers (`registerAppResource`, `registerAppTool`, `getUiCapability`). It is the last line compatible with `@modelcontextprotocol/sdk` 1.x; 2.x requires the split SDK v2 packages.

- **Resource.** `ui://cerebro/brief-preview-v1.html`, mime type `text/html;profile=mcp-app` (`src/preview-ui.ts`, `src/apps.ts`). It is one self-contained HTML5 document with no external loads. `_meta.ui.csp` declares no connect, resource, frame or base-URI domains, so hosts apply the spec's restrictive default. The document also carries its own `<meta>` CSP: `default-src 'none'`, its single inline script and stylesheet allowed by SHA-256 hash, `connect-src 'none'`, `frame-src 'none'`, `base-uri 'none'`, `form-action 'none'`. The bump of `-v1` in the URI is how a changed document reaches hosts that cache templates.
- **Tools.** `preview_brief` and `publish_brief` carry `_meta.ui.resourceUri` (plus the deprecated flat `ui/resourceUri` key that `registerAppTool` adds for older hosts). Both keep default visibility (`["model", "app"]`): the model still uses them in text-only hosts, and the view calls `publish_brief` itself. The server also declares the extension in `capabilities.extensions`.
- **What the view shows.** The view is data-free until the host forwards the tool result (`ui/notifications/tool-result`). It renders the server-bound preview's `structuredContent`: title, kind, position, request (with the shared renderer's `KIND_LABEL`/`REQUEST_LABEL` and plain text from `richTextToPlain`), home, audience in plain language, evidence counts, sections, claims without evidence, errors, warnings, change summary and expiry. Values are written with `textContent` only.
- **Publish.** The **Publish** button opens a confirmation that restates the home and audience. **Confirm and publish** sends `tools/call publish_brief` through the host with only `briefing_id`, the server-issued `preview_id` and an idempotency key generated per preview. It never sends content, home or audience. The preview binding (T15) is the security boundary: a stale, expired or used preview returns `stale_preview` exactly as for the model, and the view then shows the reasons and offers **Preview again** (`preview_brief`). Hosts may add their own approval for UI-initiated tool calls. The click is the author's explicit action in the host, but it grants nothing beyond what `publish_brief` already requires.
- **After publishing.** If the host supports `ui/update-model-context`, the view tells the model that the brief was published and must not be published again. If the host supports `ui/open-link`, it offers **Review in Cerebro** or **Open in Cerebro**.
- **Accessibility and theme.** Native buttons, a labelled confirmation group (Escape cancels and returns focus), live status and alert regions, 44px targets and visible focus. Colours are the design tokens (`packages/ui/src/tokens.css`; a parity test keeps them in step). It follows `prefers-color-scheme` unless the host sends `hostContext.theme`.
- **Capability detection.** The spec asks servers to check the client's `extensions["io.modelcontextprotocol/ui"].mimeTypes`. On a connection where the server sees `initialize` (sessions, in-process), clients that did not declare `text/html;profile=mcp-app` get the tools without UI metadata. The `/api/mcp` endpoint is stateless (T21), so `initialize` and `tools/list` arrive on separate requests and the client's capabilities are not known when tools are listed. There the metadata is always present, and the spec has hosts without the extension treat such tools as standard tools. Either way, the text `content` of every result is unchanged.
- **Tests.** `test/mcp-apps.test.ts` covers the metadata, the resource (mime type, CSP, hashes, no external URLs, token parity), the stale-preview refusal on the UI's publish path, capability gating and the unchanged text fallback. `e2e/09-mcp.spec.ts` renders the view in a sandboxed iframe under the official host-side `AppBridge` and drives it by keyboard and pointer against the live server.
- **Not yet verified in a real host.** No production host (Claude, ChatGPT or other) has rendered this view yet. Host-injected inline scripts or styles would be blocked by the hash-only CSP, and each host's own approval prompts for UI-initiated tool calls still need to be checked.
- Errors return `isError: true` with `structuredContent.error.code`. The codes are `validation`, `conflict` (with `details.currentVersion`), `stale_preview` (with `details.reasons`), `idempotency_mismatch`, `forbidden`, `not_found`, `unauthenticated`, `ambiguous_destination`, `rate_limited` and `unavailable`. Missing evidence and content gaps are warnings, not errors.
- Nothing logs handoff content, prompts, documents or tokens.
