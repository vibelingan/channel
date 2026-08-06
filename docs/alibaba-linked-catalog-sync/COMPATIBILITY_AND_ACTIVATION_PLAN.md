# Compatibility and Activation Plan — Alibaba Linked Catalog Pricing

## 1. Purpose

Activate Alibaba pricing without deleting, migrating, or rewriting existing pricing data and behavior.

This plan replaces the prior destructive migration plan.

## 2. Protected legacy surfaces

The following remain throughout Phase 2:

- `products.unitPrice`
- `products.wholesalePrice`
- `products.vipPrice`
- corresponding Overstock fields
- `PriceBlock.tsx`
- `canSeeVipPricing`
- catalog bearer-token and user revalidation logic
- public API `JWT_SECRET`
- current DTO fields
- current fixtures, seeds, tests, and i18n

No `unsetFields` operation is permitted for these surfaces.

## 3. Additive activation stages

### Stage A — schema and type addition

Add the Alibaba-prefixed collections and product fields. Mark Alibaba-owned product fields read-only in generic admin CRUD.

No storefront behavior changes in Stage A.

### Stage B — source mirror and dry-run projection

Run authorized manual sync into raw/source/offer collections only. Produce candidate `alibabaCatalogPricing` values and diffs without updating products.

Required evidence:

- exact raw payload present;
- deterministic keys stable across rerun;
- money parser and offer selection green;
- no legacy field changes.

### Stage C — test product link

Explicitly link one unpublished test product. Write only:

- `alibabaPrimarySourceKey`
- `alibabaPrimaryOfferKey`
- `alibabaCatalogPricing`
- `alibabaSourceStatus`
- `alibabaSourceLastSyncedAt`

Assert all legacy fields byte-for-byte unchanged.

### Stage D — API additive projection

Expose Alibaba fields through the existing product API while preserving current fields and VIP behavior.

Contract tests must show:

- legacy unlinked payload unchanged;
- linked payload includes Alibaba pricing;
- authenticated/anonymous Alibaba pricing identical;
- existing VIP gating remains unchanged.

### Stage E — UI compatibility routing

Add `AlibabaCatalogPricingBlock` and route by `alibabaPrimarySourceKey`.

Acceptance matrix:

| Link state | Alibaba pricing | Expected renderer |
|---|---|---|
| Unlinked | absent | existing legacy renderer |
| Linked | fixed/range/tiered/negotiable | Alibaba renderer |
| Linked | unavailable/missing | Alibaba unavailable/quote-required state |
| Link removed explicitly | any retained legacy fields | existing legacy renderer restored |

### Stage F — test deployment and controlled activation

- deploy without automatic timer;
- link a small approved product set;
- run manual incremental sync;
- verify linked and unlinked storefront paths;
- verify no legacy data mutation;
- then request production timer approval.

## 4. Rollback

Rollback does not require restoring deleted data because no legacy data is deleted.

Rollback steps:

1. disable/remove `alibaba-catalog-sync` timer trigger;
2. stop new sync runs;
3. deploy the previous site/function commit if necessary;
4. leave raw/source/audit collections intact;
5. optionally clear only Alibaba link fields from explicitly selected products through a dedicated, reviewed rollback command;
6. legacy pricing immediately becomes active again for unlinked products.

The rollback command must never modify legacy pricing fields.

## 5. Future cleanup policy

Any future proposal to remove legacy pricing requires a separate project with:

- explicit user approval;
- usage inventory showing no active consumers;
- dedicated migration and backup plan;
- independent regression review;
- production observation period.

It is not part of Alibaba Linked Catalog Sync.
