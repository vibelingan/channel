# Start Here — Implementation Agent Contract

You are implementing **Channel Alibaba Open Platform Linked Catalog Sync**.

## Mandatory branch and location

- Branch: `feature/alibaba-linked-catalog-sync`
- Documentation destination: `docs/alibaba-linked-catalog-sync/`
- New package: `packages/alibaba-catalog-sync/`
- New CloudBase function: `apps/functions/alibaba-catalog-sync/`

Do not use the old branch name `feature/alibaba-sync-v3` and do not create generic `integration-*` packages or collection names for this single-provider feature.

## First actions

1. Fetch and create a clean worktree from the latest `origin/main`.
2. Copy this documentation set into `docs/alibaba-linked-catalog-sync/` unchanged.
3. Record the actual starting commit in `EXECUTION_LOG.md`.
4. Read `AGENTS.md`, `docs/ENGINEERING_CRAFT.md`, and `docs/CLOUDBASE_SDK_CONTRACT_VERIFICATION.md`.
5. Run MIU 0 exactly as specified before editing shared runtime surfaces.
6. Stop if a mandatory Alibaba permission or response-contract gate fails. Record evidence; do not substitute scraping or undocumented endpoints.

## Compatibility rule that overrides all ambiguous implementation instincts

This feature is additive.

Do not delete, rename, unset, migrate away from, or broadly refactor:

- `products.unitPrice`
- `products.wholesalePrice`
- `products.vipPrice`
- the existing `PriceBlock` component
- `canSeeVipPricing`
- catalog bearer-token handling
- `JWT_SECRET` provisioning for the public API
- existing legacy pricing tests, fixtures, or seed records
- Overstock pricing behavior

The new Alibaba-linked path must not write or derive from those fields. It adds:

- `alibabaPrimarySourceKey`
- `alibabaPrimaryOfferKey`
- `alibabaCatalogPricing`
- `alibabaSourceStatus`
- `alibabaSourceLastSyncedAt`

The storefront chooses pricing as follows:

```text
product has alibabaPrimarySourceKey
  → render AlibabaCatalogPricingBlock
  → if Alibaba pricing is missing/unavailable, show quote-required/unavailable
  → never fall back to unitPrice/wholesalePrice/vipPrice

product has no alibabaPrimarySourceKey
  → keep the existing legacy pricing path unchanged
```

## Definition of implementation-ready

The architecture in these documents is frozen. Independent review may identify defects, but the implementation agent must not turn review comments into unapproved redesign. Confirmed findings are incorporated through an updated document revision before code starts beyond MIU 0.
