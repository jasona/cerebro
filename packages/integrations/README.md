# @cerebro/integrations

Cerebro's remote MCP adapter: "Send this to Cerebro" from an executive's LLM. It is served by the web app at `/api/mcp` over Streamable HTTP. It runs statelessly, so every request is authenticated and handled by a fresh server (T21). Every tool calls the same domain services as the web app.

Tools: `get_authoring_context`, `create_brief_draft`, `get_operation`, `find_briefs`, `get_brief`, `update_brief_draft`, `preview_brief`, `publish_brief`, `get_author_feedback`. See `llm-docs/LLM_INTEGRATION.md`.

## Connect a local MCP client

Connection tokens are the D08 **dev/test stand-in** for OAuth. Production will use an MCP-compatible OAuth authorization server. The endpoint refuses connection tokens when `NODE_ENV=production`, unless `CEREBRO_ALLOW_DEV_CONNECTION_TOKENS=1` is set.

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

**ChatGPT** requires OAuth account linking and a publicly reachable HTTPS URL. It cannot connect with dev connection tokens.

## Behavior notes

- Drafts are private. `publish_brief` publishes exactly the reviewed `preview_id`. Its description tells the host model to call it only after the human has seen the preview and explicitly asked to publish. Any change after a preview makes the preview stale.
- Mutations take an `idempotency_key`. Retrying with the same key returns the original result. Reusing the key with a different payload returns `idempotency_mismatch`.
- Ambiguous or missing destinations, and named readers who are not company members, return `status: "needs_clarification"` and create nothing. External readers are invited from Cerebro's Access page (D10).
- Connection revocation is enforced here, per request. The adapter is stateless and authenticates every request against the connection before any tool runs, so a revoked or expired connection fails with 401 on the very next request. The domain's `withAuthContext` records `connectionId` for audit but does not recheck the connection itself; any new entry point that accepts `via: "mcp"` must authenticate each request the same way (D10). Covered by `test/mcp.test.ts` ("a revoked connection is unauthenticated on the next request").
- There is no embedded MCP Apps UI yet (T14 deferred). Every preview returns a text summary plus an authenticated link to `/c/<company>/b/<slug>/preview`, where evidence toggles and Publish are available.
- Errors return `isError: true` with `structuredContent.error.code`. The codes are `validation`, `conflict` (with `details.currentVersion`), `stale_preview` (with `details.reasons`), `idempotency_mismatch`, `forbidden`, `not_found`, `unauthenticated`, `ambiguous_destination`, `rate_limited` and `unavailable`. Missing evidence and content gaps are warnings, not errors.
- Nothing logs handoff content, prompts, documents or tokens.
