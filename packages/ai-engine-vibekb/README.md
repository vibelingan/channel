# Website model and public VibeKB adapter

Implements the existing `ConversationEngine`. The host still owns conversations, fencing,
tool authority, product reads and inquiry submission. This package does not send mail.

Model requests use the configured chat-completions endpoint. MCP uses
`@modelcontextprotocol/sdk@1.32.2` and its Streamable HTTP client. The existing server was
checked at VibeKB commit `76b94c2f052d79685d2ccbc4e41456d412e3777b` on 2026-11-02.

Only `search_documents`, `list_documents` and `get_document` are called. The model can
request a short search phrase; it cannot choose a workspace, document ID, destination or
tool name. The application fixes the workspace, an explicit document allowlist and the
public tag. Full document responses must repeat the correct ID, owner and public tag.
Internal results are filtered before entering model context. A shared MCP token alone
does not prove public-only access, and source-prefix labels are not authorization.

Every operation is bounded by request size, elapsed time, tool count and three planning
rounds. Public product prose uses one additional no-tool model call over current
server-projected cards. The worker's deadline covers both phases. Aborting an unstarted
run also releases its in-memory handle. Provider billing cancellation and crash-safe
idempotent generation are not claimed.

Current configuration and local acceptance steps are in
`docs/ai-platform/assistant-ui/REAL-CHAT-DELIVERY.md`. A production service must use an
approved fixed MCP channel and server credentials; the temporary SSH harness is an
acceptance transport, not a daemon deployment.

Protocol references checked against installed runtime types:

- https://ts.sdk.modelcontextprotocol.io/client
- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports

Run `pnpm --filter @vibelingan-channel/ai-engine-vibekb test` and `typecheck`.
