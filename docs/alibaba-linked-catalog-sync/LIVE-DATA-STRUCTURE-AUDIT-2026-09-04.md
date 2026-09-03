# Alibaba live data structure audit — 2026-09-04

## Outcome

The live Alibaba catalog is durably mirrored and internally referential, but it
is not ready to become the shared Dianxiaomi/Alibaba storefront model by simply
renaming fields. The storage and identity layers are healthy. Two normalization
gaps must be handled first:

1. the current offer rows predate the live `attr2_value` extractor and therefore
   still have empty `sourceAttributes`;
2. Alibaba descriptions are source HTML and are duplicated in the source mirror,
   while the future UI needs reviewed structured content rather than provider
   markup.

There are no Alibaba links or category mappings yet, so none of these source rows
has been promoted into the seven existing canonical products. This leaves a safe
window to replay and introduce the common adapter before storefront integration.

## Evidence and provenance

Observed directly from CloudBase environment
`diversity-123-d9grnqfux221323bb` after deploying release
`fa45c3c04a5f5839f5375ae05e34ad8cbe2871e1`:

- Cloud Function: `alibaba-catalog-sync`, `Nodejs20.19`, `Active/Available`;
- health endpoint returned the exact deployed release id;
- the existing authenticated admin page showed connection `channeltec` active,
  with no browser console warnings or errors;
- an authenticated **Run sync now** call completed as
  `incremental-2026-09-03T15-47-19-818Z`;
- that run stored a 173-byte `product.list` response with `total_item: 0`, moved
  the committed cursor to `2026-09-03T15:47:19.818Z`, and left product/offer
  counts unchanged;
- a representative 23,050-byte `product.get` object was read from private
  storage; its computed SHA-256, metadata `_id`, `responseSha256`, path and byte
  length all agreed.

CloudBase's legacy `GetFunctionLogs` operation is retired and this environment
has no CLS log set/topic, so there is no deploy-time stack-trace stream to query.
Gateway and SCF request ids remain available in HTTP responses, but this is an
observability gap rather than a data failure.

## What is stored where

```text
Alibaba TOP response
  |
  +-- private COS object: alibaba-raw/<sha-prefix>/<sha>.json
  |     exact HTTP response bytes, immutable recovery evidence
  |
  +-- alibabaSourcePayloads
  |     metadata and pointer: sha, endpoint, run, bytes, storageFileId
  |
  +-- alibabaSourceProducts
  |     one current provider product projection per sourceProductId
  |
  +-- alibabaSupplierOffers
        one current or historical SKU offer per deterministic offer key

alibabaProductLinks + alibabaCategoryMappings
  -> explicit review/mapping gates
  -> canonical products / public API / storefront
```

The raw JSON is **not** stored as a NoSQL blob. The exact body is a private COS
object; NoSQL stores its small metadata row and the parsed source mirror. One raw
body can be referenced by content hash without duplicating that body.

## Live counts and invariants

| Layer | Observed state | Integrity result |
| --- | ---: | --- |
| Source payload metadata | 2,156 after the fresh smoke | all stored, hash-addressed, storage pointer present |
| `product.get` payloads before smoke | 1,469 | historical versions/retries retained |
| `product.list` payloads before smoke | 686 | enumeration evidence retained |
| Source products | 1,074 active | 1,074 unique provider ids and deterministic keys |
| Active supplier offers | 3,672 | no orphan source key or provider-id mismatch |
| Inactive supplier offers | 129 | retained SKU history, not active catalog conflicts |
| Product links | 0 | no Alibaba source promoted into a canonical product |
| Category mappings | 0 | canonical draft creation correctly remains gated |
| Existing canonical products | 7 | unchanged by Alibaba sync/smoke |

All 1,074 source products:

- reference a present `product.get` payload;
- were last seen by completed full run
  `full-2026-09-03T07-28-56-187Z`;
- have title, description, category id, at least one source image and a source
  update timestamp;
- use `alibaba-source-product-v1` and have a non-empty content hash;
- contain 6,193 top-level image references in total;
- have category ids, but zero have a provider category path.

Active offers range from 1 to 40 per source product (mean 3.42). There are 266
single-offer products and 808 multi-offer products. Eleven active offers use
Alibaba's legitimate default SKU id `-1`; none falls back to the internal
product-level `@product` sentinel.

## Price model

The data confirms that price must stay a discriminated union, not a single
number and not the legacy `vipPrice` field:

| Active mode | Offers | Products | Meaning |
| --- | ---: | ---: | --- |
| `tiered` + USD | 1,808 | 600 | supplier unit price changes by quantity break |
| `unavailable` | 1,864 | 474 | no validated currency-bearing amount in the live detail |

The 1,808 tiered offers contain 4,958 tier rows, up to four tiers per offer.
Tier starts range from 1 to 10,000 units. `sourceAvailability` is present on
1,201 active offers, including many whose price is unavailable, so inventory and
price availability must remain independent facts.

The existing VIP-price behavior is intentionally out of scope. It is a customer
sales policy, while these tiers are supplier quote/cost evidence.

## Actual detail wrapper

The representative live body is not empty. It has this shape:

```text
alibaba_icbu_product_get_response
  product
    product_id, subject, description, category_id, status
    main_image.images.string[]
    product_sku
      sku_attributes.sku_attribute[]
        attribute_id, attribute_name
        values.sku_attribute_value[]
      skus.sku_definition[]
        sku_id, attr2_value, inventory_dto_list, bulk_discount_prices
    wholesale_trade / sourcing_trade
```

The product-level `sku_attribute` array is a dictionary of possible options.
Each SKU's `attr2_value` is the selection for that exact sellable variant. For
example, the sampled product defines connector and color choices, while one SKU
selects `USB+3.5mm + Blue` and another selects `USB+3.5mm + Red`. That is what
“scoped to the SKU” means: the SKU selection is more specific than a generic
compatibility attribute and therefore wins when both name the same option.

## Current normalization gap

The current 3,672 active DB offers all have empty `sourceAttributes` because the
last completed full run occurred before the corrected `attr2_value` parser was
deployed. This is stale derived data, not lost source data and not a key conflict.

A read-only replay of the exact 1,074 current payloads through the corrected and
hardened parser recovered:

- 3,672 SKUs;
- 3,661 attributed SKUs (99.70%);
- 10,100 source attribute name/value pairs;
- zero malformed outer bodies, API-error envelopes, missing product ids or
  malformed embedded maps.

The remaining 11 are the Alibaba default `-1` SKUs whose bodies contain no SKU
attribute dictionary or selection.

## HTML and content boundary

Alibaba TOP detail returns full provider-authored HTML. The sampled response
contains inline CSS, module metadata, tables, image runs, video metadata,
recommended products and company content. The earlier complete replay found
HTML-like markup in 1,073 of 1,074 current descriptions.

Therefore:

- never render `sourceDescription` with direct `innerHTML`;
- keep the exact raw body as private evidence;
- sanitize through a reviewed tag/attribute/protocol allowlist;
- extract conservative headings, paragraphs, lists and label/value tables;
- store/display approved structured content through the public catalog
  projection;
- keep unrecognized source fragments private as evidence.

Longer term, duplicating the full provider HTML in every current source-product
row is unnecessary once structured content and evidence references exist. That
change belongs in the shared adapter migration, not in an ad-hoc Alibaba-only
schema rewrite.

## Common contract with Dianxiaomi

Do not merge the two providers at their raw schemas. Both should implement one
provider-neutral adapter contract resembling:

```ts
type CatalogSourcePricing =
  | { mode: 'fixed'; currency: 'USD' | 'CNY'; amountMinor: number }
  | {
      mode: 'tiered';
      currency: 'USD' | 'CNY';
      tiers: Array<{ minimumQuantity: number; unitAmountMinor: number }>;
    }
  | {
      mode: 'range';
      currency: 'USD' | 'CNY';
      minimumAmountMinor: number;
      maximumAmountMinor: number;
    }
  | { mode: 'negotiable'; currency?: 'USD' | 'CNY' }
  | { mode: 'unavailable' };

interface SourceObservationBundle {
  schemaVersion: string;
  source: {
    kind: 'alibaba' | 'dianxiaomi';
    connectionId: string;
    externalProductId: string;
    observedAt: string;
  };
  identity: { title?: string; sourceCategory?: string };
  content: { structured: unknown[]; imageCandidates: unknown[] };
  variants: Array<{
    externalVariantId: string;
    options: Array<{ sourceName: string; value: string; canonicalKey?: string }>;
    availability?: number;
  }>;
  offers: Array<{ externalVariantId: string; pricing: CatalogSourcePricing }>;
  evidence: Array<{ payloadId: string; sourcePath: string }>;
  warnings: string[];
}
```

The exact shared types should be frozen jointly with the active catalog-refactor
workstream; the sketch above records the proven boundaries, not a new public API.
Alibaba and Dianxiaomi keep their provider-specific parsing behind adapters.
The new UI consumes the common reviewed projection, never provider raw rows.

## Recommended execution order

1. Add a resumable, lease-owned **raw replay** job that updates only derived
   source mirror/offer fields, preserves `lastSeenRunId`, never promotes
   canonical products, and quarantines unexpected count/id changes.
2. Dry-run the exact 1,074 referenced payload ids again, freeze expected hashes
   and counts, then apply the replay and verify 3,661 attributed active offers.
3. Inventory the Dianxiaomi branch and its dirty UI prototype read-only; freeze
   the shared adapter/evidence contract with the catalog-refactor owner.
4. Move provider HTML sanitization and structured-content extraction behind one
   shared content-evidence module.
5. Adapt the newer Admin/UI structure to the common projection, then add category
   mapping and explicit source-product linking.
6. Only after those gates decide when Alibaba data may affect canonical/public
   products and enable a recurring timer.

## Remaining live-probe boundary

The new `inspectProductDetail` action is deployed. Its route recognition and
admin guard were verified live: an unauthenticated request reaches the new action
and returns 401 rather than an unknown-action response. A fresh authenticated
one-product call was not forced by extracting the browser's session token: the
current Admin UI has no control for this diagnostic, and the browser automation
keeps local storage opaque. The normal authenticated incremental smoke above
already proves the deployed OAuth/TOP/list path; the 1,469 stored detail payloads
and full replay provide the data-shape evidence used in this audit.

Expose the inspection through the future consolidated Admin UI, or run it in a
user-visible DevTools session, before calling the one-product diagnostic itself
fully accepted. Do not weaken its admin guard or export the JWT merely to close
that checkbox.
