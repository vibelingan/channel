# Architecture — Channel Alibaba Open Platform Linked Catalog Sync

## 1. System context

```text
Alibaba Open Platform
        │ OAuth + signed product APIs
        ▼
CloudBase `alibaba-catalog-sync` function
        ├── exact raw response object storage
        ├── Alibaba-prefixed source mirror and supplier offers
        ├── lease/checkpoint/run audit
        ├── candidate media import through existing media lifecycle
        └── fenced update of Alibaba-owned product fields
                 │
                 ▼
Existing `products` collection
        ├── existing legacy pricing fields remain
        └── additive `alibabaCatalogPricing`
                 │
                 ▼
Existing public API and Astro/React storefront
        ├── linked product → AlibabaCatalogPricingBlock
        └── unlinked product → existing PriceBlock/legacy behavior
```

## 2. Module layout

```text
packages/alibaba-catalog-sync/
├── src/alibaba-signature.ts
├── src/alibaba-client.ts
├── src/alibaba-contracts.ts
├── src/alibaba-enumeration.ts
├── src/alibaba-money.ts
├── src/alibaba-pricing.ts
├── src/alibaba-normalizer.ts
├── src/alibaba-merge-policy.ts
├── src/alibaba-run-state.ts
└── src/*.test.ts

apps/functions/alibaba-catalog-sync/
├── src/index.ts
├── src/http-adapter.ts
├── src/handler.ts
├── src/oauth.ts
├── src/runner.ts
├── src/scheduler.ts
├── src/media-import.ts
└── src/*.test.ts

apps/site/src/islands/admin/alibaba-catalog-sync/
├── AlibabaCatalogSyncPage.tsx
├── AlibabaConnectionPanel.tsx
├── AlibabaSyncRunTable.tsx
├── AlibabaQuarantineReview.tsx
└── AlibabaProductLinkAction.tsx

apps/site/src/islands/shop/
├── AlibabaCatalogPricingBlock.tsx
└── alibaba-catalog-pricing.test.ts

scripts/cloudbase-function-manifest.mjs
```

No generic integration framework is introduced. Shared repository primitives are extended only where required.

## 3. Data model

### 3.1 `alibabaConnections`

Stores connection identity and encrypted token envelope. Generic admin routes cannot read it.

### 3.2 `alibabaOAuthStates`

Document ID is `sha256(state)`. Stores requesting user, connection intent, expiry, and consumed time. Consume transactionally.

### 3.3 `alibabaSyncLeases`

```ts
interface AlibabaSyncLease {
  _id: string; // connectionId
  holder: string;
  fence: number;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  releasedAt?: string;
}
```

### 3.4 `alibabaSyncCheckpoints`

Stores active run, mode, stage, page/range cursor, committed incremental cursor, due times, continuation count, and update time.

### 3.5 `alibabaSourcePayloads`

Stores metadata for exact raw response bytes held in private object storage: response SHA-256, byte length, endpoint ID, redacted request fingerprint, status, content type, object key, connection, run, and fetched time.

OAuth token responses are never raw-mirrored.

### 3.6 `alibabaSourceProducts`

```ts
interface AlibabaSourceProduct {
  _id: string; // sourceKey
  sourceKey: string;
  connectionId: string;
  sourceProductId: string;
  payloadId: string;
  sourceTitle?: string;
  sourceDescription?: string;
  sourceCategoryId?: string;
  sourceCategoryPath?: string[];
  sourceImageUrls: string[];
  sourceUpdatedAt?: string;
  fetchedAt: string;
  active: boolean;
  firstSeenRunId: string;
  lastSeenRunId: string;
  tombstonedAt?: string;
  parseVersion: 'alibaba-source-product-v1';
}
```

### 3.7 `alibabaProductLinks`

```ts
interface AlibabaProductLink {
  _id: string; // sourceKey
  sourceKey: string;
  connectionId: string;
  sourceProductId: string;
  productId: string;
  linkedByUserId?: string;
  linkedAt: string;
}
```

Create-if-absent enforces one source product to one Channel product. A Channel product may have multiple link rows.

### 3.8 `alibabaSupplierOffers`

One document per product/SKU offer.

```ts
interface AlibabaSupplierOffer {
  _id: string; // offerKey
  offerKey: string;
  sourceKey: string;
  connectionId: string;
  sourceProductId: string;
  sourceSkuId: string;
  active: boolean;
  sourceAttributes: Record<string, string>;
  sourceAvailability?: number;
  pricing: AlibabaCatalogPricing;
  sourceUpdatedAt?: string;
  syncedAt: string;
  lastSeenRunId: string;
}
```

### 3.9 `alibabaSyncRuns`

Stores mode, trigger, status, holder/fence, candidate hash, lifecycle timestamps, counters, redacted alerts, one-time approval, and normalized error summary.

### 3.10 Additive product fields

```ts
interface AlibabaLinkedCatalogFields {
  alibabaPrimarySourceKey?: string;
  alibabaPrimaryOfferKey?: string;
  alibabaCatalogPricing?: AlibabaCatalogPricing;
  alibabaSourceStatus?: 'available' | 'limited' | 'unavailable' | 'removed' | 'unknown';
  alibabaSourceLastSyncedAt?: string;
}
```

All are read-only in generic admin CRUD. Existing price fields remain writable/behaving exactly as today.

## 4. Money normalization

- preserve money lexemes as strings through a lossless JSON boundary;
- accept only strict decimal strings with at most two fractional digits for Phase 2;
- return integer minor units by string manipulation;
- reject signs, separators, exponent notation, extra decimals, unsafe integers, NaN, and Infinity;
- never use `parseFloat`, binary floating multiplication, or rounded conversion.

Tier rules:

- positive integer quantities;
- sorted ascending;
- no duplicate starts or overlaps;
- one optional open-ended final tier;
- one currency across all tiers;
- source MOQ compatible with first tier.

## 5. Primary offer and price materialization

Across active offers linked to one Channel product:

1. use operator-pinned `alibabaPrimaryOfferKey` when still valid;
2. otherwise choose the lowest valid minimum unit amount;
3. tie-break by source key then SKU ID lexically.

Materialize the selected offer into `products.alibabaCatalogPricing`.

Never write `unitPrice`, `wholesalePrice`, or `vipPrice`. Never fabricate a fixed amount from multiple SKUs; preserve range/tiered semantics.

## 6. Pricing presentation compatibility

### 6.1 API

- Keep existing public fields and VIP gating unchanged.
- Add `alibabaPrimarySourceKey`, `alibabaCatalogPricing`, and safe source status/timestamp fields to the product allowlist.
- Do not expose connection IDs, raw payload IDs, run IDs, private source URLs, or offer internals.
- Anonymous and authenticated users receive identical Alibaba pricing for a linked product.

### 6.2 UI

```tsx
product.alibabaPrimarySourceKey ? (
  <AlibabaCatalogPricingBlock pricing={product.alibabaCatalogPricing} />
) : (
  <PriceBlock /* existing props and behavior */ />
)
```

Rules:

- branch on link identity, not on the presence of a numeric amount;
- linked + missing pricing renders unavailable;
- never fall back to legacy fields while linked;
- unlinked behavior remains unchanged;
- existing `PriceBlock` may receive a comment identifying it as the legacy/manual compatibility renderer, but no code is removed.

## 7. Merge policy

### New source product

- persist raw and normalized source data;
- require explicit category mapping;
- create unpublished draft with source suggestions and additive Alibaba fields;
- do not auto-select public images.

### Existing unlinked product

- no automatic match;
- admin links explicitly with side-by-side confirmation.

### Existing linked product

- update only Alibaba-owned fields;
- preserve curated and legacy pricing fields;
- alert large price moves;
- never change publication state.

### Source deletion

- tombstone source/offers after complete full pass;
- keep Channel product and legacy fields;
- set Alibaba source status to removed/unavailable;
- set `alibabaCatalogPricing.mode = 'unavailable'` or omit it with linked status driving unavailable UI;
- never auto-unpublish/delete;
- alert operations.

## 8. Raw evidence, OAuth, and secrets

- write exact catalog API response bytes before parsing;
- hash-address private objects and deduplicate by SHA-256;
- never persist auth headers, tokens, app secret, or full signed URL;
- OAuth start requires valid Channel admin session;
- generate 32 random bytes for state, store only SHA-256, 10-minute TTL, consume once;
- AES-256-GCM token envelope uses `ALI_TOKEN_ENCRYPTION_KEY_V1`;
- proactively refresh; mark `authorization_expired` and alert on non-recoverable auth failure.

Required secrets:

- `ALI_APP_KEY`
- `ALI_APP_SECRET`
- `ALI_OAUTH_CALLBACK_URL`
- `ALI_TOKEN_ENCRYPTION_KEY_V1`
- `WECOM_WEBHOOK_URL`

## 9. Lease and fencing

Add precise DB methods:

```ts
acquireAlibabaSyncLease(connectionId, holder, now, ttlMs): Promise<AlibabaLeaseGrant>;
renewAlibabaSyncLease(connectionId, holder, fence, now, ttlMs): Promise<boolean>;
releaseAlibabaSyncLease(connectionId, holder, fence): Promise<boolean>;
assertAlibabaSyncLease(connectionId, holder, fence, now): Promise<boolean>;
createDocWithId(collection, id, data): Promise<'created' | 'exists'>;
upsertDocWithId(collection, id, data): Promise<CollectionDoc>;
```

CloudBase uses `@cloudbase/node-sdk` transactions. Local JSON uses one synchronous critical section.

- TTL 180 seconds;
- renew every 60 seconds and before long operations;
- fence increments on acquisition after release/expiry;
- every public product promotion transaction rechecks holder/fence/non-expiry;
- lost lease stops promotion immediately;
- existing image-mutation ownership remains unchanged.

## 10. Scheduling and bounded execution

Function timer expression:

```text
0 */15 * * * * *
```

UTC scheduler tick:

- resume active run first;
- otherwise full sync Sunday 18:30 UTC;
- otherwise incremental every four hours at minute 15;
- otherwise exit without Alibaba API calls.

Bounds per invocation:

- 720-second soft deadline;
- at most 200 source products or 50 API calls;
- checkpoint after every durable page;
- continuation resumes next tick;
- fail and alert after 24 hours or 96 continuations;
- one active run per connection;
- manual run uses same runner and lease.

No timer in test environment.

## 11. Full and incremental behavior

Incremental:

- request after committed cursor;
- persist raw/source/offer state;
- validate candidate;
- promote healthy Alibaba-owned product fields;
- advance cursor only after durable page and promotion/quarantine decision.

Full:

- enumerate full authorized catalog using the documented 5,000-item bisection algorithm;
- record every seen source key;
- tombstone only after complete successful enumeration.

## 12. Safety and quarantine

Quarantine before product promotion when:

- candidate linked-product changes `>= 20` and ratio `> 30%`;
- tombstones `>= 5` and ratio `> 10%`;
- parse failures `>= 5` and ratio `> 5%`;
- signature vector fails;
- response contract fails;
- unsupported currency;
- raw evidence missing;
- lease/fence invalid.

Quarantine preserves raw and normalized candidates. Approval records actor, time, reason, run, and immutable candidate hash.

## 13. Media import

- HTTPS only;
- exact allowlist/suffix-safe hostname checks;
- validate every redirect target;
- resolve DNS and reject loopback/private/link-local/multicast/reserved IPv4/IPv6;
- connection/read/total timeout;
- streaming byte cap;
- MIME allowlist plus magic-byte validation;
- SHA-256 dedupe;
- import through existing media lifecycle as candidate media;
- never set public product image IDs automatically.

## 14. Deployment manifest

Replace duplicated hardcoded function arrays with one repository manifest that includes existing functions plus `alibaba-catalog-sync`.

The manifest must drive:

- workspace build selection;
- artifact packaging;
- cold-start smoke;
- environment variables;
- test/prod deployment;
- gateway route;
- timer trigger desired state;
- drift tests.

This is the only intended shared deployment refactor. It must preserve existing `admin` and `public-api` behavior exactly.

## 15. Future Medusa seam

A future outbound projector may consume curated products, Alibaba offers, and Alibaba pricing. No current module imports Medusa and no Medusa-specific schema is added.
