# ADR: Admin classification and publication UX

Date: 2026-09-29
Phase: UI-only HLD accepted for local validation
Status: UI-only flow locally verified; production-serving `test` deployment and controlled Admin-only acceptance authorized. True atomic product batch deferred.

## Context

G1 approves two explicit outcomes in one Admin dialog; G2 approves the responsive layout with existing colors. The current assignment endpoint returns per-product saved/uncertain statuses and optional revisions. The site publishes each confirmed item using revision-checked Admin update requests, stopping after ambiguous results. The user now prioritizes shipping the customer-facing workflow using this existing behavior, with a delayed waiting state and an honest confirmed/partial/unknown result. The six Excalidraw diagrams now describe the current sequential release; only the old per-item-progress proposal is historical and does not authorize live item counters. A true backend batch remains a separate, unproven feature.

## Patterns Selected

| Pattern | Why it fits | Trade-off accepted |
| --- | --- | --- |
| Cache-Aside (existing client query cache) | After confirmed writes, invalidate active product/taxonomy queries and explicitly observe whether status readback succeeds. | Refetch may be slow or fail; retain the confirmed write receipts rather than equating read failure with write failure. |
| Anti-Corruption Layer (existing Admin API client) | UI consumes validated assignment and publication results, not raw supplier or CloudBase documents. | Supplier media/detail approval still requires Edit when the existing API rejects publication. |
| Static Content Hosting (existing Astro deployment) | The current release changes Admin site islands, not the Admin function contract. | Built-site browser verification precedes delivery; backend function and SDK deployment belong to the deferred batch feature. |

## Patterns Considered and Rejected

| Pattern | Reason rejected |
| --- | --- |
| Retry | A timed-out assignment or publication may already have committed. Automatic retries could duplicate side effects or overwrite a concurrent edit. Require status verification first. |
| Compensating Transaction / Saga | A successful classification/publication is not safely reversible when later products fail; no idempotent inverse or durable outcome event exists. Report partial results, never pretend rollback. |
| Async Request-Reply / queue | Adds backend jobs, durable progress and a new contract for a capped 1-20 product UI flow. No measured customer timing justifies that migration yet. |
| CQRS / Materialized View | Existing read/write projection suffices; new models would increase consistency and deployment risk without solving unclear UI states. |
| Circuit Breaker / Leader Election / Event Sourcing | No new shared dependency, worker leader or replay/audit requirement; these add infrastructure beyond scope. |

## Scope decision: ship the existing guarded sequence first

The user keeps the existing <=20 selection, but defers the true server-side batch to deliver the customer-facing controls and narrow-screen Admin first. This release explicitly retains sequential revision-checked publication. It can partially succeed and is not a speed fix. The generic `batchUpdate` still rejects products, and the DB facade's similarly named method loops `db().update(id)`; neither is a substitute for a future atomic batch. Image `publishedRefCount` updates still occur after each product commit, so this release cannot promise product/image atomicity. A separate batch G3 must later prove transaction/visibility and lost-response guarantees against an environment not serving production domains; see [SDK-PROBE.md](../../docs/admin-assign-publish-fix/SDK-PROBE.md).

## Security And Data Constraints

- Keep server-side admin role, taxonomy revision, per-product timestamp and published-family guards authoritative. Hide the disallowed bulk Assign action for non-admin operators; UI hiding is not a substitute for authorization.
- Only a complete, confirmed assignment with saved product revisions can start the existing <=20 sequential publish. Published or mixed selections cannot silently enter a partial-publish branch. Already-published same-family child edits may appear publicly on save and require an up-front warning.
- Do not invent atomicity or per-item live progress. Use the existing validated per-product receipts for confirmed/rejected/unknown/not-attempted final results; one failure need not roll back earlier products. On a lost response, read back submitted IDs before showing final status; do not auto-retry. Supplier-linked products needing media/detail approval remain directed to Edit.
- Use TanStack Query v5's active refetch after invalidation as an explicit **read** stage. The installed v5.101.0 runtime/types support `throwOnError`; a failed readback cannot erase prior confirmed write receipts.

## Remaining Gates

The UI-only architecture and test scope were authorized and validated locally. Before live product writes, CI must confirm the deployed release SHA and the operator must capture baseline business fields for the A/C test-only drafts and B existing image-backed product as specified in [G4-TEST-PLAN.md](../../docs/admin-assign-publish-fix/G4-TEST-PLAN.md). Test and restore only through Admin, without direct database/API cleanup; a transient storefront change and revision/audit history cannot be rolled back. No server contract, SDK or database change belongs to this UI release. The local blank-region cause was measured and contained, but live publication latency remains unmeasured; do not promise speed or all-or-nothing publication. Remote transaction validation and a physically separate NoSQL environment remain blockers for the **later atomic batch feature only**.