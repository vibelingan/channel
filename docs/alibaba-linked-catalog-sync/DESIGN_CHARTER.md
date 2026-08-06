# Design Charter — `feature/alibaba-linked-catalog-sync`

**Status:** IMPLEMENTATION-READY; ARCHITECTURE FROZEN  
**Feature name:** Channel Alibaba Open Platform Linked Catalog Sync  
**Reviewed baseline:** `vibelingan/channel main@5c14193b93cf023ed791086902bc4423fd077198`  
**Revision:** R1 (2026-08-06) — see `REVISION_R1.md`; actual starting baseline `main@2f79a61`  
**Document language:** English only

## 1. Mission

Add secure, resumable, auditable Alibaba Open Platform catalog synchronization to the existing Channel platform without replacing the Astro storefront, CloudBase backend, registry-driven admin, media lifecycle, Headphones module, or existing legacy pricing behavior.

“Accio sync” is a business/project shorthand only. Runtime code uses authorized Alibaba Open Platform APIs. Scraping Accio, 1688, Alibaba pages, or undocumented browser endpoints is prohibited.

## 2. Exact feature naming

Use these names consistently:

| Surface | Frozen name |
|---|---|
| Git branch | `feature/alibaba-linked-catalog-sync` |
| Documentation folder | `docs/alibaba-linked-catalog-sync/` |
| Domain package | `packages/alibaba-catalog-sync/` |
| Package name | `@vibelingan-channel/alibaba-catalog-sync` |
| CloudBase function | `alibaba-catalog-sync` |
| Admin page | `AlibabaCatalogSyncPage` |
| Public pricing component | `AlibabaCatalogPricingBlock` |
| Product pricing field | `alibabaCatalogPricing` |
| Primary source field | `alibabaPrimarySourceKey` |
| Primary offer field | `alibabaPrimaryOfferKey` |
| Gateway route path (R1) | `/api/alibaba-catalog-sync` |
| OAuth callback route (R1) | `/api/alibaba-catalog-sync/oauth/callback` |

Do not introduce generic `integration-*`, `source-*`, or `catalogPrice` names for provider-owned artifacts in this phase unless the file is an existing cross-provider repository primitive.

## 3. End-to-end flow

```text
Alibaba OAuth authorization
  → signed Alibaba Open Platform API requests
  → exact response bytes stored in private CloudBase object storage
  → Alibaba-prefixed raw metadata and source mirror
  → normalized Alibaba supplier product/SKU offers
  → deterministic Alibaba source-to-Channel-product link
  → products.alibabaCatalogPricing materialized field
  → operator review for new drafts and curated content
  → existing public API
  → linked-product Alibaba pricing renderer OR unchanged legacy renderer
```

## 4. Compatibility invariants

1. Existing `unitPrice`, `wholesalePrice`, and `vipPrice` fields remain in collection definitions, database rows, DTOs, API projections, tests, fixtures, and legacy UI paths.
2. Existing `PriceBlock`, `canSeeVipPricing`, catalog JWT verification, and public API authorization behavior remain.
3. Alibaba sync code never writes, clears, migrates, or derives from those legacy price fields.
4. Overstock is not changed by this feature.
5. A product with `alibabaPrimarySourceKey` uses `alibabaCatalogPricing` for current display.
6. A linked product with missing/unavailable Alibaba pricing renders unavailable/quote-required and never falls back to legacy prices.
7. A product without `alibabaPrimarySourceKey` continues through the current legacy pricing path unchanged.
8. Unlinking a product restores the legacy path because no legacy values were destroyed.
9. No cleanup of unused pricing code is allowed in this feature. Documentation comments may clarify ownership only.

## 5. Synchronization invariants

1. The worker cannot publish a product. Every worker-created product is runtime-validated as `published: false`.
2. Exact Alibaba response bytes are persisted before parsing, normalization, media import, or product projection.
3. Alibaba-linked pricing, source MOQ, SKU data, and source availability follow Alibaba after healthy run validation.
4. Curated name, description, Channel category, public media selection/order, merchandising, and publication state are never overwritten.
5. New source products are not fuzzy-matched and are not auto-published.
6. Every run is idempotent, resumable, lease-protected, fenced, and auditable.
7. Duplicate timer delivery must not duplicate links, offers, drafts, images, or product updates.
8. Incremental sync does not tombstone; weekly full sync performs tombstone detection only after complete enumeration.
9. OAuth tokens are encrypted at rest and never logged or returned to the browser.
10. Media retrieval is HTTPS-only, allowlisted, redirect-validated, DNS/private-range checked, size-bounded, content-sniffed, and checksum-deduplicated.
11. Test environments do not receive automatic timers.
12. One function manifest drives build, package, smoke, deploy, environment, gateway, and trigger configuration.

## 6. Pricing domain

### 6.1 Canonical source records

- `alibabaSupplierOffers` is the canonical normalized commercial record.
- `products.alibabaCatalogPricing` is a read-optimized materialized field for the existing storefront.
- `products` remains the curated Channel catalog entity.
- Legacy price fields remain legacy/manual compatibility data and are not canonical for a linked product.
- Buyer-specific quotation, service fees, payment fees, FX conversion, and final transaction terms belong to a later RFQ/order domain.

### 6.2 Type contract

```ts
export type AlibabaPriceMode =
  | 'fixed'
  | 'range'
  | 'tiered'
  | 'negotiable'
  | 'unavailable';

export interface AlibabaPriceTier {
  minQuantity: number;
  maxQuantity?: number;
  unitAmountMinor: number;
}

export interface AlibabaCatalogPricing {
  schemaVersion: 'alibaba-catalog-pricing-v1';
  source: 'alibaba';
  currency?: 'CNY' | 'USD'; // R1: optional — see per-mode matrix below
  mode: AlibabaPriceMode;
  amountMinor?: number;
  minAmountMinor?: number;
  maxAmountMinor?: number;
  tiers?: AlibabaPriceTier[];
  sourceMoq?: number;
  sourceOfferKey?: string;
  sourceProductId?: string;
  sourceSkuId?: string;
  sourceUpdatedAt?: string;
  syncedAt: string;
}
```

Validation rules:

- money values are non-negative safe integers in minor currency units;
- `fixed` has exactly `amountMinor`;
- `range` has `minAmountMinor <= maxAmountMinor` and no `amountMinor`;
- `tiered` contains sorted, non-overlapping tiers;
- `negotiable` and `unavailable` contain no numeric amount;
- Phase 2 accepts only CNY and USD;
- decimal source strings are parsed losslessly; floating-point multiplication is forbidden;
- missing/malformed current source price produces `unavailable` in `alibabaCatalogPricing` without mutating legacy fields.

Per-mode field matrix (R1 — every cell not listed as allowed is REQUIRED-ABSENT,
not merely ignored; canonical objects feed candidate hashing):

| mode | currency | amountMinor | minAmountMinor / maxAmountMinor | tiers |
|---|---|---|---|---|
| `fixed` | required | required | absent | absent |
| `range` | required | absent | both required | absent |
| `tiered` | required | absent | absent | required (non-empty) |
| `negotiable` | optional | absent | absent | absent |
| `unavailable` | optional | absent | absent | absent |

`sourceMoq`, provenance fields, `sourceUpdatedAt`, and `syncedAt` are allowed in
every mode. Source deletion has ONE canonical representation (R1): the
materialized object is retained with `mode: 'unavailable'` (provenance and
`syncedAt` survive); renderers must treat an absent object identically as
defense in depth.

### 6.3 Update policy

For linked products:

- Alibaba price/tier, source MOQ, source SKU, source availability, and source timestamps auto-update;
- item-level price moves above 30% are audited and alerted but apply when the run is otherwise healthy;
- run-level anomaly guards may quarantine promotion;
- generic admin CRUD treats Alibaba-owned fields as read-only;
- quarantine approval may promote the frozen candidate but cannot rewrite source price.

## 7. Alibaba-prefixed collections

Extend `CollectionDef` with:

```ts
adminAccess?: 'crud' | 'readOnly' | 'none'; // default: 'crud'
```

Required collections:

| Collection | Admin access | Purpose |
|---|---|---|
| `alibabaConnections` | none | encrypted OAuth tokens and connection state |
| `alibabaOAuthStates` | none | hashed single-use OAuth state records |
| `alibabaSyncLeases` | none | lease, heartbeat, expiry, and fencing |
| `alibabaSyncCheckpoints` | none | resumable cursor and due-schedule state |
| `alibabaSourcePayloads` | readOnly | immutable raw-response metadata and private object reference |
| `alibabaSourceProducts` | readOnly | current parsed source-product mirror |
| `alibabaProductLinks` | readOnly | unique source-key to Channel-product mapping |
| `alibabaSupplierOffers` | readOnly | normalized product/SKU/commercial truth |
| `alibabaSyncRuns` | readOnly | lifecycle, counters, diffs, errors, approvals |
| `alibabaCategoryMappings` | crud | explicit Alibaba category to Channel category mapping |

Existing `products` receives additive Alibaba-owned fields. Existing price fields remain unchanged.

`adminAccess` semantics (R1):

- Enforcement seam: `canReadCollection` / `canEditCollection` in
  `packages/shared/src/auth.ts` consult `getCollection(name)?.adminAccess`;
  all generic admin handler gate call sites inherit the policy transitively.
- Role matrix: `crud` and `readOnly` grant the same roles the existing gate
  grants today (admin and contributor); `readOnly` blocks all generic writes
  for every role; `none` blocks generic reads and writes for every role.
- The existing hardcoded admin-only gating for `users`, `rateLimitHits`, and
  `passwordResets` (`isAdminOnlyCollection`) is preserved unchanged and takes
  precedence; a regression test pins those three collections' behavior.
- The admin `collections` registry-dump action must filter defs by
  `adminAccess`: `none` collections are omitted entirely from the response.
- Dedicated actions on the `alibaba-catalog-sync` function (never generic
  CRUD) provide the operator surface for `none`/`readOnly` state: connection
  status, quarantine review/approval, manual runs, link/unlink, and the
  `setAlibabaPrimaryOffer` pin action.

## 8. Product fields and ownership

### Alibaba-owned additive fields

- `alibabaPrimarySourceKey`
- `alibabaPrimaryOfferKey`
- `alibabaCatalogPricing`
- `alibabaSourceStatus`
- `alibabaSourceLastSyncedAt`

### Operator-owned fields

- public name
- public description
- Channel category
- public image IDs and order
- merchandising copy
- publication state
- existing legacy/manual pricing fields

The Alibaba worker must never edit operator-owned fields or legacy price fields.

## 9. Linking and draft creation

- `sourceKey = sha256('alibaba|' + connectionId + '|' + sourceProductId)`.
- `offerKey` additionally includes source SKU ID or a product-level sentinel.
- deterministic source and offer keys are document IDs.
- `alibabaProductLinks._id = sourceKey` is create-if-absent and enforces one source product to one Channel product.
- one Channel product may aggregate multiple Alibaba source products/offers.
- no fuzzy or name-based automatic matching.
- an admin may explicitly link an existing product.
- a new draft is created only when a category mapping exists.
- all worker-created drafts set `published: false`.

## 10. Raw payload, OAuth, lease, schedule, safety, and media

The exact contracts are specified in `ARCHITECTURE.md` and are mandatory:

- raw bytes before parsing;
- AES-256-GCM encrypted tokens;
- single-use ten-minute OAuth state;
- 180-second lease TTL, 60-second heartbeat, fencing token;
- 15-minute UTC scheduler tick;
- resumable bounded invocation;
- absolute-plus-ratio quarantine thresholds;
- SSRF-safe image import through existing media lifecycle.

## 11. Public API and storefront behavior

- Add `alibabaCatalogPricing` and Alibaba source status fields to the product public allowlist.
- Preserve existing legacy fields and current VIP projection behavior.
- For the same linked product, anonymous and authenticated callers receive identical `alibabaCatalogPricing`.
- Keep current bearer-token/JWT behavior because legacy pricing remains supported.
- Add `AlibabaCatalogPricingBlock`.
- Existing `PriceBlock` remains the unlinked/legacy renderer.
- Product rendering branches on `alibabaPrimarySourceKey`, not on the presence of a numeric price.
- No linked-product fallback to legacy prices.

## 12. Non-goals

- deleting or migrating legacy price fields;
- deleting or refactoring legacy pricing components, auth, tests, fixtures, or seed data;
- changing Overstock;
- markup, FX, fees, buyer-specific quotation;
- checkout, order, payment, payout, escrow, inspection workflow;
- Medusa deployment;
- scraping or undocumented endpoints;
- fuzzy product matching;
- automatic publication.

## 13. Execution gates

The implementation agent starts with MIU 0. A failed gate stops with evidence:

- Alibaba app permission absent;
- official response shape differs from the documented fixture contract;
- signature vector fails;
- CloudBase test deployment contract fails;
- timer trigger cannot be verified in the target environment.

A failed gate does not reopen the additive compatibility policy.
