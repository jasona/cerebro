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
  - `aud` containing `APP_URL + /api/mcp`. This comes only from `APP_URL`, never from the Host header, so OAuth stays off until `APP_URL` is set;
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
