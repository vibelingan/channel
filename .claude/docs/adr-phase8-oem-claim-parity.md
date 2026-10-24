# ADR: OEM Phase 8 Listing Cleanup and Claim Parity

Date: 2026-07-23
Phase: 4 (HLD)
Author: dev-pipeline cloud-design-patterns skill

## Context

Phase 8 removes the two PPT-marked listing statistics bands and normalizes the PPT-selected `20+` experience and `within 24 hours` response claims across existing static-site, result-page, hidden-content, email, and packaged-function carriers. It preserves routes, data, cards, detail economics, APIs, schemas, authentication, SDKs, environment contracts, and production topology.

## Patterns Selected

| Pattern | Why chosen | Trade-off accepted |
|---|---|---|
| Static Content Hosting | Astro compiles deterministic listing and claim content into existing paths that CloudBase overwrites. | CDN freshness must be verified at the deployed edge with release-keyed requests. |

## Patterns Considered and Rejected

| Pattern | Why rejected |
|---|---|
| Retry | No new dependency call is introduced. Existing deployment verification owns transient HTTP handling. |
| Saga / Compensating Transaction | No distributed write or multi-step state mutation exists. |
| CQRS / Materialized View | The removed aggregates are page-local display calculations, not a separate read model. |
| Cache-Aside | No application cache is introduced or invalidated. |
| Pipes and Filters | Existing build and packaging steps already provide the required deterministic flow; a new processing abstraction would add no independent deployment value. |
| Anti-Corruption Layer | No third-party or legacy contract changes. |
| External Configuration Store | No configuration or secret changes. |
| Quarantine / Valet Key | Upload and storage access behavior is untouched. |
| Event Sourcing | No persisted state or audit-event requirement is introduced. |

All remaining reliability, performance, messaging, architecture, deployment, security, and event-driven patterns are inapplicable because Phase 8 changes static presentation/copy only and adds no service, queue, state transition, dependency, tenant, region, or integration.

## G3 Blockers

- [x] None.

## Architecture Decision

Delete only the page-local aggregate variables and stats sections in the two listing pages. Change each stale claim at its existing authoritative producer rather than adding a shared constant that would couple Markdown, Astro, plain-text email, HTML email, and serverless packaging across build boundaries.

Keep generated `dist/` and `.cloudbase-artifacts/` output ignored and uncommitted. Validate source parity, rendered output, packaged admin-function copy, all six retained detail routes, the 1024px `lg` breakpoint, and the canonical public edge. Delivery remains reviewed OEM branch first, followed by a guarded fast-forward of `test`; main/production remain untouched.