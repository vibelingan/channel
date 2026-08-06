# Issue — Channel Alibaba Open Platform Linked Catalog Sync

## Problem

Channel currently manages catalog products manually and has no secure Alibaba Open Platform connection, raw-response audit trail, normalized source-product/SKU mirror, resumable sync runner, deterministic product link, source-owned pricing field, or operations console.

Existing price fields (`unitPrice`, `wholesalePrice`, `vipPrice`) support current manual and legacy behavior but cannot faithfully represent Alibaba fixed, range, tiered, negotiable, or unavailable prices with source provenance.

## Goal

Implement an additive Alibaba-linked catalog synchronization pipeline that:

- connects one authorized Alibaba account;
- stores exact raw catalog API responses before parsing;
- mirrors Alibaba products and SKU offers;
- links source products deterministically to Channel products;
- writes only Alibaba-owned additive product fields;
- creates unpublished drafts for mapped new products;
- preserves all existing price fields and legacy pricing behavior;
- automatically follows healthy Alibaba pricing/MOQ/availability changes for linked products;
- runs incrementally and weekly with durable checkpoints and fencing leases;
- provides auditable admin controls and redacted alerts;
- deploys through the normal CloudBase CI/CD path.

## Acceptance criteria

### Compatibility

- `unitPrice`, `wholesalePrice`, and `vipPrice` remain in current schemas and rows.
- Existing legacy price API/UI behavior remains green.
- The new sync never writes those fields.
- Unlinked product rendering is unchanged.
- Linked product rendering always uses `alibabaCatalogPricing`, including unavailable state, and never falls back to legacy prices.
- Overstock behavior is unchanged.

### Connection and security

- Admin can connect/disconnect Alibaba through OAuth.
- OAuth state is random, server-stored as a hash, single-use, and expires in ten minutes.
- Tokens are AES-256-GCM encrypted and never appear in logs, responses, or alerts.
- Authorization expiry produces visible state and WeCom alert.

### Raw and normalized data

- Every successful API page is stored as exact bytes before parsing.
- Raw objects are private and hash-addressed.
- `alibabaSourceProducts` and `alibabaSupplierOffers` are idempotently upserted by deterministic IDs.
- Money parsing uses integer minor units without floating-point arithmetic.
- Fixed, range, tiered, negotiable, and unavailable modes are represented.

### Product projection

- Worker-created products are always unpublished.
- New drafts require explicit category mapping.
- Existing products link only by explicit admin action or an existing stable link.
- Alibaba-owned fields update automatically after healthy validation.
- Curated fields and legacy pricing fields do not auto-update.

### Synchronization and operations

- Incremental, full, manual, duplicate timer, retry, and continuation paths are idempotent.
- Full runs tombstone only after complete enumeration.
- Runs resume after timeout/retryable failure.
- Lease contention allows one active holder; stale holders cannot promote after fence takeover.
- Quarantine happens before product promotion.
- One manifest owns function build/package/smoke/deploy/env/route/trigger.
- Test environment has no automatic timer.
- Production uses one 15-minute timer tick after explicit approval.

## Non-goals

No legacy pricing removal, Overstock changes, Medusa, checkout, payments, payouts, FX, markup, scraping, fuzzy matching, or automatic publication.
