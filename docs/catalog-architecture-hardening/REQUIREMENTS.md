# Catalog Architecture Hardening Requirements

Status: approved architecture baseline; MIUs 01-04 released; MIU 05 planned and inactive.
Branch: `refactor/catalog-architecture-hardening`
Base: `origin/main` at `9ddda85593517bc9d1d2bea81c4862ce492b144f`.

## Problem

Catalog expansion replaced proven Headphones behavior before extracting it. Optional metadata became
an accidental visibility gate, `_id`-keyed inline detail disappeared, historical rows were not in the
fixture denominator, and family/pricing logic acquired multiple owners. The correction must harden
the whole repository, not produce another Headphones-specific implementation.

## Required Invariants

1. A published product exists independently of optional `slug`, `skuCode`, pricing, media, archive,
   category, or newer family fields. `_id` is sufficient for list-to-inline-detail.
2. Public-read normalization is non-mutating and occurs only when stored products enter public
   projection. It may infer `headphones` only when `productFamily` is missing and a recognized legacy
   Headphones category is present. Explicit invalid family values fail closed.
3. Writes, Admin payloads, migrations, and storage remain explicit; read normalization never becomes
   a covert backfill or accepts malformed writes.
4. `packages/shared/src/catalog/index.ts`, exported through the explicit `./catalog` package subpath,
  is the single public schema, canonical family, and `CatalogPage` envelope owner. Each MIU compiles
  after itself; no barrel exports a file before that file exists. Legacy `api.ts` and `catalog-types.ts`
  may remain thin adapters, but must delegate `/api/products` types, validation, and envelopes to that
  owner and may independently define only the genuinely different Overstock compatibility DTO/decoder.
5. Domain and application modules import no React, Astro, route shell, localized content, or family
   module. Presentation imports no concrete family. The route/controller composes the selected family
   adapter, application state, and family-neutral presentation.
6. The four real families share request generations, dedupe, pagination, filters, selection, focus,
   cards, grids, inline detail, media, loading, errors, empty state, and pricing view contracts.
   Individual adapters provide family content/capabilities/facts only.
7. Alibaba link identity canonically owns provider-linked pricing. The shared resolver delegates that
   branch to the Alibaba adapter even when live provider pricing is missing/unavailable; it cannot
   fall through to manual tiers, scalar price, or quote-required.
8. Pricing migration preserves parity in `catalog-pricing.ts`, live
  `CatalogFamilyGrid.catalogProductPrice`, card rendering, Headphones inline detail, SKU detail, and
  SEO/JSON-LD before old owners retire. Each technical unit owns one to three files.
9. Every old owner has an explicit call-site switch, rollback target, retirement evidence, and no
   request may execute old and new policy simultaneously.
10. MIU 01 establishes rooted module-graph, dependency-direction, reservation, known-owner, and
  duplicate-governance checks before migration. MIU 29 may extend completed-denominator/retirement
  expectations, but no earlier acceptance criterion may depend on it.
11. The task registry distinguishes the task-level active planning claim from future MIU plans. Every
  MIU has `planned|blocked|active|released`; exact files have one active owner, with later use modeled
  as a consumer/reference or explicit released-to-active transfer. The validator derives the file
  denominator from MIU docs and live references, then compares live refs/worktrees/dependency SHAs.
12. `quantity-tier-pricing.test.ts` migrates atomically only after both `CatalogFamilyGrid` and
  `HeadphonesProductDetail` replacement contracts exist. MIU 31 directly depends on MIU 13 and imports
  `SkuDetailPageView` from `apps/site/src/catalog/presentation/SkuDetailPage.tsx`.
13. Reusable lessons are integrated into existing `docs/ENGINEERING_CRAFT.md` and the existing incident
    record that taught the rule. This packet indexes those authorities; it does not create
    `docs/knowledge/catalog` or another rule catalog.
14. The active `/headphones` route remains built and returns 200. The targeted allowlist preserves
  `/overstock`, `/overstock-item`, temporarily hidden `/teardown-lab` and `/blue-ocean`, and the current
  retired media paths. Smoke enumerates `/overstock` and `/overstock-item` 404 independently and retains
  every other governed route/media check. No blanket delete or `/headphones` prune is allowed.
15. MIU 46 is the sole LIVE mutation. MIUs 39-43 author and test deploy/smoke source before approval.
  MIU 44 produces a validated immutable manifest recording independently reviewed/pushed implementation
  and rollback SHAs; MIU 45 compares dispatch inputs and manifest integrity before credentials, disables
  push deployment, and retains static concurrency. Each deploy or rollback derives `CHANNEL_BUILD_SHA`
  and `GITHUB_SHA` from its checked-out commit. Evidence preserves two requested commits and two separately
  observed release IDs; comparisons are pairwise under that build contract.
16. Select-owned Admin files remain blocked in MIUs 26-28 until the final reviewed Select SHA is merged
    and the full inherited suite passes on that merge. D1 is MIU-scoped, not a task dependency; the
    current SHA is insufficient. Controlled updates/reset plus required validation/focus, all specified
    keys, outside pointer, no-JS, Chromium, and WebKit must pass before any of those MIUs becomes planned.
17. The immutable implementation and rollback SHAs are independently reviewed and pushed before D2 and
  recorded in the trusted manifest. A later docs-only closure commit records deployment evidence under its own
    closure SHA and is not claimed as deployed. The closure document records the implementation/deployed
    SHA, never its own SHA; after push, registry/tool output verifies closure local/remote equality, and
    a separate branch/PR status field may point to `HEAD` without embedding a self-referential SHA.

## Repository-Wide Scope

- Shared normalization plus the explicit `@vibelingan-channel/shared/catalog` schema/envelope/family,
  pricing decision, and provider adapter contracts.
- Public API projection and artifact/runtime consumers.
- Browser decoder, application state, explicit `CatalogFamilyAdapter` owner, four adapters, registry,
  shared presentation, and route composition in contract-before-consumer order.
- Current pricing, live `CatalogFamilyGrid`, cards, Headphones inline detail, SKU detail, FeaturedProducts,
  Admin PreviewModal, public E2E mocks, canonical metadata, and JSON-LD, followed by file-specific retirement.
- MIU 36 ownership of legacy `api.ts`, `catalog-types.ts`, and focused `api.test.ts`: all Catalog schema
  authority delegates to shared, while ProductGrid/ProductCard/PriceBlock/ProductDetail/OverstockDetail/
  StockBadge and read-only `_overstock.astro`/`_overstock-item.astro` consume only explicit Overstock
  compatibility. These unbuilt rollback paths are not falsely required to reach zero consumers.
- Explicit migration ownership for `quantity-tier-pricing.test.ts`, `sku-detail-tier-pricing.test.ts`, and the
  `electronics-toys.astro` -> `FeaturedProducts` route consumer.
- Read-only route ownership for `products/item.astro` under SKU detail and the four family Astro routes
  under the `CatalogFamilyPage` controller, included in the rooted consumer denominator.
- Admin family/filter/tier integrations after the Select dependency merges.
- Historical/current typed fixtures for all four real families; no synthetic fifth family.
- Module-graph, behavioral, derived-consumer, task-registry, and change-impact validation.
- Local E2E, deployed test smoke, rollback, and portable handoff evidence.

## Non-Goals

- A Headphones-only rewrite, fifth fake family, visual redesign, or new family.
- Changing pricing policy, provider selection, approved copy, auth, media storage, checkout,
  inventory, localization, or route visibility policy.
- Production backfill, storage mutation during reads, CQRS, event sourcing, cache, BFF, or service.
- Restoring retired underscore Overstock routes, retiring `/headphones`, or deleting hosting content broadly.
- Production deployment or any live mutation other than the explicitly approved test deployment.

## Acceptance

- Oldest Headphones rows and current rows in all four families remain publicly readable and support
  `_id` inline detail; optional addressability adds only deep-link/SEO behavior.
- Shared schema precedes and is imported by projection and decoder.
- Domain/application/presentation graph has no forbidden React/family edges; route/controller is the
  only composition root.
- Pricing parity assertions cover current pricing, live grid pricing, cards, Headphones detail, SKU
  detail, and SEO.
- Every old owner is either active with a rollback plan or retired with mechanically checked zero live
  call sites; every remaining consumer resolves to shared Catalog or explicit Overstock compatibility,
  and no duplicate Product/Alibaba/CatalogPage validation, pricing, normalization, or family policy remains.
- Registry, impact, architecture, unit, integration, build, artifact, local/deployed browser, public API,
  and test-deploy gates pass for one exact reviewed, pushed, and deployed implementation SHA; a later
  docs-only closure commit is separately proven pushed but is not part of that deployed release.
