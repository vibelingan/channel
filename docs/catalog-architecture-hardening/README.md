# Catalog Architecture Hardening Handoff

Status: 49-MIU packet; MIUs 01-16 released; no active exact reservations; MIU 17 planned/inactive; implementation continues; MIU 16 source published and verified; closure publication requires live Git equality verification.
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

Expected branch: `refactor/catalog-architecture-hardening`. MIU 16 activation `8ff32fb`, implementation
`d7fd55f8dc13ffdd0966176f4985468624fb1ae7`, and the historical reviewed ACTIVE source checkpoint
`2eef3220a79cb53da764ccba11ee2b0e23854d1e` were pushed to that origin branch and verified.
The registry release transition was recorded by `801d8712e3abb9a0fe05adcd31328eb37523b054`;
handoff document snapshot `48405b23bcb43d9207e8b2a856768da45704719f` followed, then this correction.
At the observation preceding this correction, the remote branch was at the reviewed source checkpoint
`2eef3220a79cb53da764ccba11ee2b0e23854d1e`; that historical observation does not establish closure publication.
Use `git rev-parse HEAD` and live `origin/refactor/catalog-architecture-hardening` to confirm closure publication before continuing.
Verify local/remote equality; neither the handoff snapshot nor this correction establishes a pushed closure.

Full local validation passed: all workspace tests (site 251/251), workspace and E2E typechecks, Astro
check (0 errors, 0 warnings, 7 existing hints), production Astro build (15 pages), and repository-wide
Biome (356 files). After test-only review strengthening, focused 7/7, `typecheck:test`, site 251/251,
and Biome 356 passed again. Final review audited committed `5fb1a55..2eef322` and found 0 P1/P2/P3;
the previous three P3 findings are resolved. Push-hook craft, review, and doc guards passed.
The pre-push script suite was 92/93 solely because of `local-only-completion`; after source push,
architecture verification reported 0 issues and the script suite passed 93/93.
Craft gates against exact diff base `5fb1a55` retain 14 existing baseline findings, with ZERO NEW findings
and ZERO execution errors, not a clean total. See the finalized review disposition in
[EXECUTION.md](EXECUTION.md#miu-16-finalized-review-disposition) for the breakdown and evidence limits.
No browser E2E was run for this isolated config adapter; actual local Astro module integration was
tested, but adapters are not yet composed into routes. Source publication is not runtime deployment:
no merge into `test` or `main`, CloudBase operation, workflow dispatch, or browser E2E occurred for
MIU 16. Do not reset, rebase, cherry-pick, or create another branch to manufacture equality.

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
- MIU 16 is RELEASED after source publication and verification, activated at `8ff32fb`, with three released owners:
	`apps/site/src/catalog/families/headphones.ts`, `apps/site/src/catalog/families/headphones.test.ts`,
	and `apps/site/src/i18n/headphones.ts`. MIUs 01-16 are released; no active exact reservations remain;
	MIU 17 is planned/inactive. Later MIUs retain their lifecycle states and exact owner files, with
	references/transfers for sequential reuse. Release transition `801d871` and handoff snapshot `48405b2`
	precede this correction; closure publication requires live Git equality verification before continuing.
	No deployment or test-branch merge is authorized. MIU 20 registration and MIU 22 route/controller
	composition remain future work. The denominator is 49; D1 and D2 are unchanged.
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

MIU 16 source publication was completed and verified at historical checkpoint `2eef322`.
Release transition `801d871` and handoff snapshot `48405b2` were recorded afterward, followed by this correction.
The task remains in implementation; this MIU's release is not delivery of the entire 49-MIU task.
Use `git rev-parse HEAD` and live `origin/refactor/catalog-architecture-hardening` to confirm closure publication before continuing.
Require local/remote equality evidence external to the closure commit; no publication of this correction is claimed.
