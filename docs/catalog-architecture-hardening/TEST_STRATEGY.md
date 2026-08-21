# Catalog Architecture Hardening Test Strategy

## Sequence

1. Land MIU 01's rooted graph/reservation/known-owner/duplicate verifier before any migration.
2. Characterize old owners before switching a call site.
3. Add oldest/current typed fixtures for the four real families.
4. Land the `@vibelingan-channel/shared/catalog` schema/envelope/family subpath, then normalization/projection/decoder.
5. Land provider pricing, bridge, live grid, card, detail, SKU, and SEO parity independently.
6. Land the adapter interface, four adapters, registry, application/presentation, then controller.
7. Run explicit network/grid and Headphones detail/state retirement MIUs after parity/rollback proof.
8. Migrate `quantity-tier-pricing.test.ts` in MIU 31 only after both replacement contracts exist; import
  `SkuDetailPageView` from MIU 13's exact source. Migrate `api.test.ts`, `sku-detail-tier-pricing.test.ts`,
  FeaturedProducts plus its `electronics-toys.astro` consumer, pricing block, Admin PreviewModal, public
  E2E mocks, and every retiring owner.
9. Delegate legacy `/api/products` types, validation, and envelope decoding to the shared Catalog contract;
  isolate Overstock inventory/clearance DTOs and decoding, then prove zero unassigned consumers.
10. Keep D1 blocked until final Select merge and the full inherited suite pass, then integrate Catalog
  Admin behavior and run local E2E. Author/test deploy and smoke source in MIUs 39-43, produce the
  immutable reviewed manifest in MIU 44, review/push workflow MIU 45, obtain D2, deploy only in MIU 46,
  execute unchanged smoke in MIU 47, and write handoff.

## Fixture Denominator

- Oldest Headphones: no `productFamily`, `slug`, `skuCode`, manual pricing, or `archived`.
- Current `headphones`, `ai-gadgets`, `toys`, and `misc` rows; `/electronics-toys` is a route alias,
  not a fifth domain family.
- Missing/blank slug/SKU; absent/empty/broken/duplicate/ten-item media.
- Quote, scalar unit/wholesale, manual tiers, malformed tiers, and Alibaba linked
  available/missing/unavailable/quote states.
- Missing family + recognized legacy category; explicit invalid family; stale non-Headphones category.
- No fifth family. Adapter completeness is derived from canonical `PRODUCT_FAMILY_OPTIONS`.

Factories implement real interfaces and accept `Partial<T>` overrides; no `as any`.

## Contract Assertions

- Shared schema accepts oldest/current valid DTOs, rejects unknown/private fields and malformed required
  fields, and does not require optional metadata.
- Legacy `api.ts`/`catalog-types.ts` contain no independent Product, Alibaba pricing, or `CatalogPage`
  declaration/validator. Every remaining consumer resolves to shared Catalog or explicit Overstock
  compatibility; the unassigned-consumer denominator is zero.
- Public-read normalization is immutable, infers only missing legacy Headphones family, fails closed on
  explicit invalid family, and is never imported by Admin/write paths.
- List, ID detail, and slug detail projection produce schema-equal public DTOs for the same row.
- Alibaba link identity returns an Alibaba decision for available and unavailable provider data; manual
  and scalar branches are not invoked on linked products.
- Unlinked precedence is manual tiers, scalar wholesale/unit, then quote-required.

## Pricing Parity Matrix

| Consumer | Required assertions |
|---|---|
| `catalog-pricing.ts` | each old helper input maps to the same new decision/display result |
| `CatalogFamilyGrid.catalogProductPrice` | source and rendered output contain no independent precedence; exact old/new display parity |
| Card | amount/range/MOQ/quote copy and action geometry match for each decision |
| Headphones inline detail | provider/manual/scalar/quote blocks and facts match; slugless `_id` opens; quantity-tier test no longer imports the old detail |
| SKU detail | direct/retry/not-found states plus pricing/media parity through MIU 13's exact `SkuDetailPageView` source |
| SEO | canonical remains addressability-driven; JSON-LD offer/priceCurrency/MOQ presence matches visible decision |

## Architecture Gates

- Parse imports/re-exports/dynamic imports into a module graph; reject domain/application -> React,
  domain/application/presentation -> concrete family, family adapter -> application/presentation, and
  cycles crossing layer boundaries.
- Behavioral guards cover visibility, normalization, provider ownership, stale responses, and focus.
- Derived-consumer guard starts from canonical family/schema/pricing exports and verifies every required
  route, including `products/item.astro` and all four family Astro routes, plus adapter, Admin, API, SEO,
  test, workflow, and smoke consumers. A hand-written fifth registration is not proof.
- MIU 01's `scripts/verify-catalog-architecture.mjs` plus its test own the graph, reservation,
  known-owner, and duplicate-governance assertions before migration. MIU 29 only extends retirement:
  adding
  a second resolver, family registry, or Catalog rule authority must fail with both paths.
- Mutation-test each guard by introducing one forbidden edge/consumer omission/behavioral regression and
  recording the named failing assertion.

## Select Integration Suite

After the Select branch's final reviewed SHA is merged and recorded, keep MIUs 26-28 blocked while the
full inherited suite runs against that merge. Transfer them to planned only after every check below passes;
the current in-progress SHA is insufficient:

- controlled value follows parent changes;
- form reset restores the canonical value;
- invalid values and required validation remain visible;
- focus is retained/restored through rerender and validation;
- Arrow/Home/End/Escape/Enter/Space keyboard behavior remains correct;
- outside pointer closes and restores focus correctly;
- no-JS form submission preserves native select semantics.
- Chromium and WebKit execute the integrated controls.

After D1 is satisfied and the MIUs activate, assert Catalog family filter composition and quantity-tier
payload/focus/errors separately without claiming the shared Select files.

## Browser Matrix

Chromium and WebKit at `375x812`, `390x844`, `768x1024`, `1024x768`, and `1440x900` cover all four
families, oldest Headphones, empty/one/partial/full grids, long copy, missing/broken media, filters,
search, pagination, stale cancellation, `_id` inline detail, Back/focus restoration, SKU detail,
no-JS, reduced motion, cold cache, overflow, and console/page/network failures. Screenshots pair with
numeric geometry and unique DOM anchors.

## Build And Runtime Gates

- Repository lint and all configured TypeScript project checks.
- Shared, Public API, local-server, and site unit/integration suites.
- Public function fresh build/package and bare-directory cold start.
- Production-origin site build, secret-name scan, and Playwright discovery with optional env unset.
- Targeted hidden-route build assertions; `/headphones` 200; separate `/overstock`, `/overstock-item`,
  `/teardown-lab`, and `/blue-ocean` 404s; and retained retired-media smoke.

## Sole Live Mutation: Test Deploy

No test mutates live before approval. MIUs 39-43 finish all deploy and smoke source first. MIU 44's
immutable manifest records independently reviewed/pushed implementation and rollback SHAs plus review
evidence and integrity hash; MIU 45 compares all dispatch values with it before credentials, retains the
static lock, and disables push deployment. Each checkout derives both build SHA variables from `HEAD`.
D2 immediately precedes MIU 46, the sole deploy. Evidence records requested implementation commit,
observed deployed release ID, requested rollback commit, and observed rollback release ID separately.
MIU 47 executes unchanged Chromium/WebKit and API/route smoke, including `/headphones` 200 and separate
`/overstock` and `/overstock-item` 404s while retaining current hidden-route/media checks. A later docs-only closure commit is not deployed and
records no self-referential SHA; external post-push output proves its local/remote equality.
