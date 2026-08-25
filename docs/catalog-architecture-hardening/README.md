# Catalog Architecture Hardening Handoff

Status: 49-MIU packet published; MIUs 01-07 released; MIU 08 planned and inactive.
Branch: `refactor/catalog-architecture-hardening`
Planning packet SHA: `bc1e69e25e9e8d453584be0fde9279f7bdf0c006`.

This packet is the tracked source of truth for a repository-wide Catalog refactor. It covers every
current family (`headphones`, `ai-gadgets`, `toys`, `misc`), historical and current rows,
manual and Alibaba-linked products, Public API, site, Admin, SEO, test deployment, and handoff.
Headphones is the oldest-production-shape compatibility fixture, not the scope boundary. There is no
test-only fifth family.

## Start Here

```sh
cd /Users/SeanCai/Desktop/projects/channel-catalog-miu01-review
git fetch origin
git branch --show-current
git status --short
git rev-parse HEAD origin/refactor/catalog-architecture-hardening
```

Expected branch: `refactor/catalog-architecture-hardening`. No MIU may activate until local HEAD and
`origin/refactor/catalog-architecture-hardening` match after the reviewed closure is pushed. Do not
reset, rebase, cherry-pick, or create another branch to manufacture that equality.

## Reading Order

1. `EXECUTION.md`
2. `REQUIREMENTS.md`
3. `ARCHITECTURE.md`
4. `ADR-001-KERNEL-AND-ADAPTERS.md`
5. `MIU_BREAKDOWN.md`
6. `TEST_STRATEGY.md`
7. `TASK_REGISTRY.json`
8. `IMPACT_MAP.md`
9. `KNOWLEDGE_SYSTEM.md`

## Controlling Decisions

- Domain and application import no React and no family module. A route/controller is the composition
	root that supplies one family adapter plus application state to family-neutral presentation.
- MIU 01 establishes the rooted module-graph, reservation, known-owner, and duplicate-governance
	verifier before any migration; MIU 29 only extends completed-denominator/retirement expectations.
- `packages/shared/src/catalog/index.ts`, exported as `@vibelingan-channel/shared/catalog`, owns the
	public product schema, canonical family, and `CatalogPage` envelope before projection or decoding.
- MIU 36 removes independent Product, Alibaba pricing, `CatalogPage`, envelope, and validation authority
	from legacy `api.ts`/`catalog-types.ts`. Those files may remain thin adapters, but `/api/products`
	delegates to the shared contract while genuinely different Overstock inventory/clearance DTOs and
	decoding remain an explicit compatibility contract consumed only by the two underscore pages.
- Normalization is a public-read boundary only. Admin writes and stored rows are not silently rewritten.
- Alibaba link identity selects provider pricing behind the Alibaba adapter; linked products never
	fall through to manual/scalar pricing because provider data is unavailable.
- Pricing parity covers `catalog-pricing.ts`, live `CatalogFamilyGrid.catalogProductPrice`, card,
	Headphones detail, SKU detail, and SEO before explicit old-owner retirement.
- `CatalogFamilyAdapter` is exported before four implementations; registry follows adapters and the
	route/controller follows registry.
- The rooted read-only route denominator assigns `products/item.astro` to the SKU detail integration
	owner and assigns `headphones.astro`, `ai-gadgets.astro`, `toys.astro`, and `misc.astro` to the
	`CatalogFamilyPage` controller owner.
- Live owners and tests/mocks switch one to three files at a time. MIU 31 atomically migrates
	`quantity-tier-pricing.test.ts` only after both replacement contracts exist and directly depends on
	MIU 13's `apps/site/src/catalog/presentation/SkuDetailPage.tsx` contract. MIU 23 owns
	`electronics-toys.astro` with `FeaturedProducts`. MIU 36 owns the focused `api.test.ts` delegation/
	Overstock compatibility proof. The permanent compatibility boundary retains `ProductGrid`, `ProductCard`/
	`PriceBlock`, `ProductDetail`, `OverstockDetail`, and `StockBadge`; `_overstock.astro` and
	`_overstock-item.astro` are its read-only compatibility references.
- Active `/headphones` remains built and must return 200. Targeted pruning preserves the real deploy
	contract: `/overstock`, `/overstock-item`, temporarily hidden `/teardown-lab` and `/blue-ocean`, and
	the existing retired media allowlist. Route smoke enumerates each status; no blanket delete is allowed.
- No MIU or exact file is active. Future MIU plans have lifecycle state and exact owner files, with
	references/transfers for sequential reuse.
- MIUs 39-43 separately own the real deploy script modification, its new test, the existing smoke script
	modification, its new test, and the new browser smoke. MIU 44 produces and validates the immutable
	`RELEASE_MANIFEST.json`; MIU 45 consumes it before credentials, disables push deployment, and owns the
	workflow. D2 immediately precedes sole live MIU 46. MIU 47 only executes already-reviewed smoke and
	records evidence; it changes no source.

## Select Branch Exclusion

Shared selector merge `78506d525eefcd6410ff0d85a1a020d834f4ab02`, successful CloudBase test deployment
`026e18b45c2bf8b61d54049e7a58bdf22466bfaa`, and focused live E2E passing 9/9 are recorded.
Final-code WebKit validation was unavailable and is not claimed, so D1 remains unsatisfied and MIUs
26-28 remain blocked.

## Completion

The planning packet and MIU 01 closure are published. Later, the manifest records two approved commit SHAs:
the independently reviewed/pushed implementation and rollback commits. Runtime records separate observed
deploy and rollback release IDs and compares each only with its corresponding checked-out commit. Post-deploy
MIUs create a separate docs-only closure commit that is not deployed and does not embed its own SHA;
external registry/tool output proves closure local/remote equality after push, while a separate branch/PR
status may point to `HEAD`.
