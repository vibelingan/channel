# AI platform review round 4

**Reviewed base:** `3e12a693c8446b2745850de984f41673e811aef4`
**Branch:** `feat/ai-assistant-platform-design`
**Review date:** 2026-08-31 (Asia/Tokyo)
**Decision:** application Phase 1 accepted locally; production release remains blocked

## Scope

This round independently reviewed the reconciled Claude/Codex line, the
AnythingLLM-compatible adapter, worker publication boundary, PostgreSQL event
state, local Compose parity, CloudRun manifest and operator handoff. It also ran
the built local BFF/worker against the current hosted KB.

## P1 findings corrected

1. **Provider output was committed before the final public-source decision.**
   The worker now withholds provider chunks and commits token, approved
   citations, final, assistant message and `COMPLETED` status in one fenced
   PostgreSQL transaction. A mid-batch database failure test proves total
   rollback.
2. **Mixed public/internal citations were filtered instead of refused.** The
   entire answer now fails closed because removing a citation cannot remove a
   fact already derived from it.
3. **Two adapters existed and the tested one was not the package entry.** The
   conformance-tested adapter is now the single root export.
4. **The emitted worker could import test-only code and fail only at startup.**
   Runtime imports now use narrow package subpaths, and both BFF/worker builds
   import their emitted artifact.
5. **Tool-surface inspection failed open for object-shaped/missing workspace
   responses.** Array and object forms are narrowed; missing, malformed,
   enabled and unreachable states all refuse startup.
6. **Citation links accepted arbitrary HTTP(S) destinations.** The worker now
   applies the exact first-party site-origin policy before the atomic commit;
   lookalike/off-site/userinfo links lose their URL.
7. **Compose recorded fake engine provenance in the BFF while the worker called
   the hosted engine.** BFF and worker now share engine id, version and digest,
   with a rendered-Compose parity test.
8. **The production BFF could omit the engine digest.** The single CloudRun
   manifest requires it for both services.
9. **The CloudRun worker declared port 8081 while its container listened on
   8080, and the production manifest omitted runtime gates.** The manifest and
   tests now match the running services.
10. **A direct KB diagnostic created a retained provider thread and printed
    generated text without warning.** CLI output is sanitized and the English
    handoff now names remote mutation, retention and spend before that optional
    probe.
11. **Cancel, reclaim and dead-letter paths bypassed the atomic run fence and
    inverted lock order.** All terminalization now locks conversation then run,
    proves the caller's durable authority, gives recorded cancellation
    precedence, and has PostgreSQL contract tests for each path.
12. **Tool inspection checked only two vendor fields.** It now pins the exact
    hosted workspace field schema observed on 2026-08-31, refuses every new
    top-level and document/thread field until reviewed, and reports field paths
    without values.
13. **The sanitized KB probe still printed internal document names and paths.**
    CLI output is now limited to transport/status/counts; workspace, thread,
    source identifiers, paths, answer text and raw errors are omitted.
14. **CloudRun image references were syntactically invalid and accepted
    `latest`.** The manifest now requires two complete per-service sha256 image
    references and tests their exact output.
15. **Bundle import still resolved from the monorepo.** The build now imports
    each service from its production Docker stage containing only deployed
    production dependencies.
16. **The local KB runbook neither loaded `.env.ai` nor used its documented
    workspace variable, and its key-generation curl printed the admin token.**
    Setup scripts now load the gitignored file, prefer
    `ANYTHINGLLM_WORKSPACE_SLUG`, and a loopback-only helper atomically stores
    the token plus attestation at mode `0600` without printing either value.

## Phase 1 live acceptance

The final built artifacts were started locally with an isolated PostgreSQL
database and the current hosted KB. No cloud resource was purchased, created or
reconfigured.

| Check | Result |
| --- | --- |
| BFF readiness | PASS |
| Worker/database/engine readiness | PASS |
| Approved company query | PASS: `token`, `citation`, `final` |
| Approved provenance and no `file:` URL | PASS |
| Query for gateway test document | PASS: `error` only |
| Rejected-output token/citation leakage | PASS: 0 / 0 |

## Production blockers retained

- Hosted KB transport is public HTTP. The diagnostic override is forbidden by
  the production manifest.
- The exposed instance-wide developer token must be rotated after HTTPS is in
  place.
- The current workspace is not a dedicated public-only corpus.
- Immutable provenance for the hosted fork is not yet supplied.
- TencentDB PostgreSQL purchase, same-region VPC/private 5432 attachment and
  deployed acceptance require explicit approval.
- The separate port-9021 MCP/FTS service remains a different, unreachable
  integration and is not part of this ConversationEngine proof.

The English execution handoff is
[`PHASE-1-REMOTE-KB-HANDOFF.md`](./PHASE-1-REMOTE-KB-HANDOFF.md).
