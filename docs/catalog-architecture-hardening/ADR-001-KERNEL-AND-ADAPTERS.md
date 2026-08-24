# ADR-001: Catalog Kernel, Composition Root, And Provider Pricing

Date: 2026-08-21
Status: accepted; implementation in progress

## Context

Catalog family expansion mixed historical normalization, family selection, optional addressability,
provider/manual pricing, request state, presentation, and SEO. Headphones-owned components became
generic by usage without becoming generic by dependency, while old rows disappeared behind new
optional fields.

## Decision

1. Use ports/adapters with a route/controller composition root. The controller composes exactly one
   family adapter, family-neutral application state, and family-neutral React presentation.
2. Keep domain/application free of React and family modules; keep presentation free of concrete
   families. Dependency direction is enforced by a module graph.
3. Normalize only public reads. Storage/Admin writes remain strict and are never mutated by reads.
4. Establish `@vibelingan-channel/shared/catalog` as the public schema, canonical family, and envelope
   owner before server projection/browser decoding; never export future files from an earlier MIU.
   Legacy `api.ts`/`catalog-types.ts` delegate Catalog types, validation, and envelopes to it; only an
   explicit, genuinely different Overstock DTO/decoder compatibility contract remains local.
5. Canonicalize provider-linked pricing behind `AlibabaPricingAdapter`. Link identity selects that
   branch even when provider pricing is unavailable; manual/scalar fallback applies only when unlinked.
6. Use a Strangler migration with atomic call-site switches, explicit rollback targets, parity tests,
   and delayed retirement of old owners.
7. Preserve targeted hosting retirement: active `/headphones` returns 200; `/overstock`, `/overstock-item`,
   temporarily hidden `/teardown-lab` and `/blue-ocean`, and existing retired media remain governed by the
   real allowlist. Blanket deletion and adding `/headphones` to prune are forbidden.
8. Export the `CatalogFamilyAdapter` contract before implementations, register families only after all
   four adapters land, and migrate the controller afterward.
9. Treat reservations as a lifecycle, not a flat claim list: one active owner per exact file, with
   consumer references or explicit release/activation transfer for sequential edits.
10. Establish the graph/reservation/known-owner/duplicate verifier in MIU 01 before migration; later
   verifier work may extend retirement expectations but cannot retroactively satisfy earlier criteria.
11. Author and review deploy/smoke source in MIUs 39-43, produce the trusted manifest in MIU 44, and
   consume it in workflow MIU 45 before credentials. D2 immediately precedes sole live MIU 46; MIU 47
   only executes reviewed smoke and records evidence. No branch push may deploy.
12. Define release identity through the build: deploy and rollback check out the requested commit,
   rebuild/redeploy with fixed scripts, and bake that SHA through `CHANNEL_BUILD_SHA`/`GITHUB_SHA` as
   the release ID. Record requested SHA and observed release ID; compare them only under this contract.
13. Approve two immutable commits in the manifest: reviewed/pushed implementation and rollback SHAs.
   Record separately observed deploy and rollback release IDs, compared pairwise. A later docs-only closure commit records
   evidence under a distinct closure SHA, is not deployed, and never embeds its own SHA; external registry
   or tool output proves closure local/remote equality after push.

## Selected Patterns

| Pattern | Application | Trade-off |
|---|---|---|
| Anti-Corruption Layer | public-read storage normalization and Alibaba provider conversion | compatibility code remains explicit |
| Ports and adapters | provider pricing and HTTP gateway behind domain/application contracts | more modules, fewer implicit dependencies |
| Composition root | route/controller supplies adapter + state + presentation | route owns wiring but no policy |
| Strangler Fig | one consumer switches at a time | old/new owners coexist temporarily |
| Static hosting with targeted prune | preserve Astro/CDN topology and approved hidden routes | prune list and 404 smoke must stay current |

## Rejected Alternatives

| Alternative | Reason |
|---|---|
| Adapters imported by application/presentation | reverses dependency ownership and reintroduces family coupling |
| Fifth test-only family | tests a synthetic registry path instead of completeness for the four supported families |
| Normalize on write/backfill | changes data and Admin contracts beyond the incident requirement |
| Provider pricing fallback to manual | misrepresents an Alibaba-linked product when provider data is unavailable |
| Source-string architecture checks alone | cannot reliably detect re-exports, aliases, cycles, or behavioral duplicates |
| New knowledge catalog | duplicates `ENGINEERING_CRAFT.md` and incident authority |
| Blanket hosting delete | additive hosting has no safe broad-delete rollback in CI |
| CQRS/event sourcing/new service/cache | no scale or audit requirement justifies the operational cost |

## Consequences

- Shared schema/pricing are runtime dependencies of function and site builds; function packaging,
  bare cold start, and production-origin site build are required.
- The adapter interface must exist before the four implementations; registry follows implementations,
   and controller migration follows registry.
- Pricing migration must prove parity separately in the compatibility bridge, live grid, cards,
   Headphones detail, SKU detail, and SEO before explicit retirement MIUs run.
- `api.test.ts`, `quantity-tier-pricing.test.ts`, `sku-detail-tier-pricing.test.ts`, live FeaturedProducts and its
   `electronics-toys.astro` consumer, pricing block, Admin PreviewModal, and public E2E mocks migrate
   explicitly. MIU 31 migrates the quantity-tier test only after both replacement contracts exist and
   directly consumes MIU 13's `SkuDetailPageView` source. MIU 36 removes duplicate Catalog schema authority
   and permanently owns the intentionally unbuilt Overstock compatibility boundary, including
   `_overstock.astro` and `_overstock-item.astro` as read-only references.
- Test deployment is the sole live mutation and requires exact approved/rollback commit SHAs, checkout,
  rebuild, fixed scripts, static concurrency, and fixed rollback. The build contract makes each resulting
  release ID equal its checked-out commit SHA. Deployed browser/API smoke follows read-only.
- Existing hidden-route and deploy-prune incident records remain canonical and receive references or
  amendments; this ADR only records the architecture decision.
