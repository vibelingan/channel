# Catalog Change Impact Map

Every MIU traces its owner through producers, direct/derived consumers, tests, and build/runtime context.

| Owner | Producers | Derived consumers | Required checks |
|---|---|---|---|
| Public-read normalizer | stored public-read row | projection only; explicitly not Admin/write paths | oldest/current immutability + import graph |
| Foundational verifier | rooted repository + registry/live Git | every migration and retirement gate | graph direction, reservations, known owners, duplicate governance before MIU 02 |
| Public schema/envelope subpath | normalized fields + canonical family + page envelope | Public API, decoder, adapters, factories, E2E, artifact smoke | explicit `./catalog` export + producer/consumer compile |
| Publication/visibility | public query + projection | list/id/slug, media, smoke | optional fields never gate record |
| Family set | shared `PRODUCT_FAMILY_OPTIONS` | four adapters, routes, content, Admin, API, SEO, E2E, smoke | derived completeness; no fake family |
| Alibaba pricing adapter | provider link/data | shared pricing resolver only | linked unavailable never falls through |
| Pricing resolver/view model | normalized product + adapter | bridge, live grid, pricing block, card, detail, SKU, Admin PreviewModal, SEO | complete parity matrix |
| Browser gateway | HTTP/envelope/schema | application controller; `api.test.ts` characterization before MIU 36 migration | malformed required rejection + optional omission |
| Legacy schema delegation | shared Catalog schema/gateway + explicit Overstock inventory/clearance DTO | `/api/products` thin adapters; `_overstock.astro`, `_overstock-item.astro`, retained Overstock components | no independent Product/Alibaba/CatalogPage declaration; zero unassigned consumers |
| List/detail application | gateway results + commands | route/controller | stale/abort/dedupe/filter/page/focus behavior |
| `CatalogFamilyAdapter` interface | public product contract | four adapters, registry | contract exported before implementations |
| Individual family adapters | interface + family content | registry, then route/controller | one per canonical family; no state/JSX/policy |
| Presentation | app state + adapter projections | route/controller | no concrete family imports; geometry/accessibility |
| Route/controller | adapter + application + presentation | `headphones.astro`, `ai-gadgets.astro`, `toys.astro`, `misc.astro` | correct adapter selected; rooted read-only denominator; no policy duplication |
| Select integration | merged `Select.tsx` + `Select.test.ts` | D1-transferred Admin family/filter/tier | inherited controlled/reset/validation/focus/keyboard/no-JS; no overlapping claim |
| Task registry | planning author + MIU docs + live Git | agents/review/handoff | derived exact files, lifecycle, refs/worktrees, active overlap |
| FeaturedProducts | browser gateway + shared card | `electronics-toys.astro` route | MIU 23 owns both component/test and route consumer migration |
| SKU detail view | shared pricing/media/detail contracts | `products/item.astro`; `sku-detail-tier-pricing.test.ts`; `quantity-tier-pricing.test.ts` | MIU 13 route integration + direct MIU 31 dependency/import-source parity |
| Underscore compatibility adapter | explicit Overstock DTO/decoder + legacy ProductGrid/detail chain | `_overstock.astro`, `_overstock-item.astro` read-only references | MIU 36 permanent compatibility ownership; excluded build, no zero-consumer claim |
| Release manifest | independent review + pushed implementation/rollback commits | MIU 45 workflow before credentials | content hash/protected reviewed tag; inputs cannot self-authorize |
| Deploy workflow | manifest + three allowlisted inputs | immutable deploy and fixed rollback jobs | exact checkout/rebuild, checked-out SHA env, static lock; no push deploy |
| Deployed smoke | pre-D2 reviewed API/route/browser source | Chromium/WebKit card, inline detail, SKU, SEO/JSON-LD plus API/privacy | MIUs 41-43 author/test; MIU 47 executes without source changes |
| Existing knowledge authorities | incidents + engineering craft | future design/review | no duplicate catalog authority; links remain valid |
| Hosting prune | deploy script + current route/media allowlist | CDN objects + smoke | separate `/overstock` and `/overstock-item` 404, existing hidden/media checks, `/headphones` 200 |
| Closure evidence | implementation/deployed SHA + deployment observations | docs-only closure commit and branch/PR status | closure SHA is not deployed or self-embedded; external post-push local/remote equality |

## Old-Owner Impact Rule

Before switching a call site, search direct calls, type references, string names, dynamic imports,
re-exports/barrels, tests, mocks, fixtures, scripts, build/package consumers, workflows, and smoke.
Record the old and new owner, switched call site, rollback commit/action, and zero-live-consumer evidence
before retirement. A single grep or source-string ban is not sufficient.

The inventory explicitly assigns `api.test.ts`, `quantity-tier-pricing.test.ts`,
`sku-detail-tier-pricing.test.ts`, live
`FeaturedProducts` plus `electronics-toys.astro`, `AlibabaCatalogPricingBlock`, Admin `PreviewModal`,
and public E2E mocks. MIU 36 delegates Catalog schema authority and owns `ProductGrid`, `ProductCard`,
`PriceBlock`, `ProductDetail`, `OverstockDetail`, and `StockBadge` as permanent non-live Overstock
compatibility adapters; `_overstock.astro`
and `_overstock-item.astro` are permanent read-only references. Only fully migrated owners may require
zero consumers.

Shared files have one owner MIU. `packages/shared/src/catalog/index.ts`, `apps/site/src/i18n/catalog.ts`,
`CollectionView.tsx`, product/Admin tests, `EXECUTION.md`, and `TASK_REGISTRY.json` are later
consumer/references unless an explicit released-to-active transfer is recorded.

## Review Evidence Per MIU

- owner/contract and exact files;
- producer -> consumer trace and derived denominator;
- oldest/current shapes preserved;
- assertions that failed before and passed after;
- compile/build/runtime contexts exercised;
- old-owner switch/rollback/retirement state when applicable;
- reviewed implementation commit, pushed remote SHA, and local/remote equality before deployment;
- for MIUs 44-47, manifest hash, two approved commit SHAs, two separately observed release IDs, reviewed smoke hashes, and evidence;
- for MIU 49, a non-deployed closure commit whose equality is proven by external post-push output.
