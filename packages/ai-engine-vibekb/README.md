# Website model and public VibeKB adapter

Implements the existing `ConversationEngine`. The host still owns conversations, fencing,
tool authority, product reads and inquiry submission. This package does not send mail.

Model requests use the configured chat-completions endpoint. MCP uses
`@modelcontextprotocol/sdk@1.32.2` and its Streamable HTTP client. The existing server was
checked at VibeKB commit `76b94c2f052d79685d2ccbc4e41456d412e3777b` on 2026-11-02.

Only `search_documents`, `list_documents` and `get_document` are called. The model can
request a short search phrase; it cannot choose a workspace, document ID, destination or
tool name. What is public is decided by the knowledge base server, not here: the adapter
holds a read-only `kbpub_` key that the server binds to one public workspace, sends no
workspace or tag, refuses any server that does not identify as `knowledge-base-public`,
and rejects results that span two workspaces. Source-prefix labels are not authorization.
See `docs/ai-platform/PUBLIC-KNOWLEDGE-WORKSPACE.zh-CN.md`.

Every operation is bounded by request size, elapsed time, tool count and three planning
rounds. Public product prose uses one additional no-tool model call over current
server-projected cards. The worker's deadline covers both phases. Aborting an unstarted
run also releases its in-memory handle. Provider billing cancellation and crash-safe
idempotent generation are not claimed.

Current configuration and local acceptance steps are in
`docs/ai-platform/assistant-ui/REAL-CHAT-SETUP.zh-CN.md`. A production service must use an
approved fixed MCP channel and server credentials; the temporary SSH harness is an
acceptance transport, not a daemon deployment.

Protocol references checked against installed runtime types:

- https://ts.sdk.modelcontextprotocol.io/client
- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports

Run `pnpm --filter @vibelingan-channel/ai-engine-vibekb test` and `typecheck`.
