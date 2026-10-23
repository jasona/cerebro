# @cerebro/integrations

Cerebro's remote MCP adapter: "Send this to Cerebro" from an executive's LLM. It is served by the web app at `/api/mcp` over Streamable HTTP. It runs statelessly, so every request is authenticated and handled by a fresh server (T21). Every tool calls the same domain services as the web app.

Tools: `get_authoring_context`, `create_brief_draft`, `get_operation`, `find_briefs`, `get_brief`, `update_brief_draft`, `preview_brief`, `publish_brief`, `get_author_feedback`. See `llm-docs/LLM_INTEGRATION.md`.

## Authorization

`/api/mcp` accepts two bearer credentials (`src/auth.ts`):

| Credential | When | Scopes |
| --- | --- | --- |
| OAuth access token (JWT) | Production path. On only when `CEREBRO_OAUTH_ISSUER` is set | From the token's `scope` (or `scp`) claim |
| Connection token `cbr_…` | D08 dev/test stand-in. Refused when `NODE_ENV=production` unless `CEREBRO_ALLOW_DEV_CONNECTION_TOKENS=1` | All scopes; the user's own permissions still apply |

**OAuth (resource-server side only, `src/oauth.ts`).** Cerebro does not issue tokens and no authorization server has been chosen (T13).

- Protected Resource Metadata (RFC 9728) is served at `/.well-known/oauth-protected-resource/api/mcp` and at the root form. It returns 404 while `CEREBRO_OAUTH_ISSUER` is unset.
- A 401 response carries `WWW-Authenticate: Bearer resource_metadata="…", scope="…"`.
- Each token is verified against the issuer's JWKS, using `CEREBRO_OAUTH_JWKS_URL` or discovery from the issuer's RFC 8414 or OpenID metadata. Only asymmetric algorithms are accepted. The token must also have:
  - `iss` equal to the configured issuer;
  - `aud` containing `APP_URL + /api/mcp`. In production this comes only from `APP_URL`, never from the Host header;
  - a valid `exp`, a `sub`, and a `client_id` (or `azp`).
- Opaque tokens would need introspection, which is not implemented.
- The domain call `authenticateOAuthGrant` maps `sub` to a user. The mapping uses only the explicit `user_identities` link for (issuer, subject); unknown subjects are refused and nobody is provisioned.
- The grant is recorded as an `integration_connections` row with `kind = 'oauth'`, one per company, user, issuer and client. It appears in Settings → Connections and is revoked there.
- A revoked grant refuses every token until the user authorizes again: the token's `auth_time` must be later than the revocation. Tokens without `auth_time` stay refused, which is the fail-closed choice.
- Active membership is rechecked on every request.
- A connection is bound to one company. On first use it binds to the user's only active company. A user with several active companies gets 403 `company_selection_required`; no company-selection step exists yet.

**Scopes (`src/scopes.ts`).** Scopes are independent and bound what a host may attempt. Resource permissions are still enforced by the domain.

| Scope | Tools |
| --- | --- |
| `cerebro:read` | `get_authoring_context`, `get_operation`, `find_briefs`, `get_brief`, `get_author_feedback` |
| `cerebro:draft` | `create_brief_draft`, `update_brief_draft`, `preview_brief` |
| `cerebro:publish` | `publish_brief` |

A `tools/call` without the required scope gets HTTP 403 with `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"`, which lets a host request step-up authorization. The server also rechecks the scope per tool.

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

**ChatGPT** and other hosted clients require OAuth account linking (an authorization server set in `CEREBRO_OAUTH_ISSUER`) and a publicly reachable HTTPS `APP_URL`. They cannot connect with dev connection tokens.

## Behavior notes

- Drafts are private. `publish_brief` publishes exactly the reviewed `preview_id`. Its description tells the host model to call it only after the human has seen the preview and explicitly asked to publish. Any change after a preview makes the preview stale.
- Mutations take an `idempotency_key`. Retrying with the same key returns the original result. Reusing the key with a different payload returns `idempotency_mismatch`.
- Ambiguous or missing destinations, and named readers who are not company members, return `status: "needs_clarification"` and create nothing. External readers are invited from Cerebro's Access page (D10).
- Connection revocation is enforced here, per request. The adapter is stateless and authenticates every request against the connection before any tool runs, so a revoked or expired connection fails with 401 on the very next request. The domain's `withAuthContext` records `connectionId` for audit but does not recheck the connection itself; any new entry point that accepts `via: "mcp"` must authenticate each request the same way (D10). Covered by `test/mcp.test.ts` ("a revoked connection is unauthenticated on the next request") and, for OAuth grants, `test/oauth.test.ts`.
- There is no embedded MCP Apps UI yet (T14 deferred). Every preview returns a text summary plus an authenticated link to `/c/<company>/b/<slug>/preview`, where evidence toggles and Publish are available.
- Errors return `isError: true` with `structuredContent.error.code`. The codes are `validation`, `conflict` (with `details.currentVersion`), `stale_preview` (with `details.reasons`), `idempotency_mismatch`, `forbidden`, `not_found`, `unauthenticated`, `ambiguous_destination`, `rate_limited` and `unavailable`. Missing evidence and content gaps are warnings, not errors.
- Nothing logs handoff content, prompts, documents or tokens.
