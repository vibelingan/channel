# Common source observation integration — 2026-09-04

## Final decision

Alibaba and Dianxiaomi share a validated **product observation** contract, not
an acquisition workflow and not a public product schema.

```text
Alibaba product.list -> product.get -> immutable raw payload --\
                                                         provider adapter
Dianxiaomi workbook -> bounded parser -> grouped candidates --/       |
                                                                    v
                                                  CatalogSourceObservation
                                                                    |
                                                  latest private source view
                                                                    |
                                         explicit review/link/publish (later)
```

This boundary is deliberately below transport concerns and above provider
payload shapes. Alibaba retains time-window bisection, pagination, TOP signing,
OAuth refresh, rate limiting, checkpoints, tombstones and raw-object recovery.
Dianxiaomi retains workbook detection, archive/XML limits, header mapping,
row quarantine, grouping and per-store evidence. Neither adapter writes a
canonical `products` row merely because source data was collected.

The collection is a latest validated observation per provider product key. For
Alibaba, a complete full run can also prove that a product disappeared and set
the wrapper `active` flag to false. A Dianxiaomi export may cover only one
store, so absence from a later workbook is not deletion evidence; its older
observation remains addressable with `observedAt` and `lastSeenOperationId`
until an explicit source-status record says it is missing.

## Alibaba call strategy

The production path remains `product.list` for discovery followed by one
`product.get` per id. The list response is not an economical replacement for
detail: live evidence shows that description HTML, images, SKU selections,
availability, tier rows, MOQ and source status are detail fields.

- Full sync enumerates the historical modification window with the existing
  bounded time-window bisection and page state; it never assumes one response
  contains the whole catalog.
- Incremental sync reuses that enumerator over the committed cursor window.
- `product.get` is the complete-product normalization boundary for every id.
- The admin single-product action remains a read-only contract probe. It is not
  a hidden targeted sync and does not own checkpoint or tombstone state.
- The current raw replay reads already stored `product.get` bodies. It is a
  recovery/migration path, not a substitute for future provider calls.

## Runtime contract

`CatalogSourceObservation` is strict at runtime with Zod. Unknown object keys,
unsafe media protocols, non-canonical timestamps, invalid money, duplicate
variant/offer keys, dangling offer-to-variant references and overlapping price
tiers fail validation before persistence. Provider option and attribute names
are stored as arrays of `{ sourceName, value }`, so source-controlled text never
becomes an object prototype key.

The price contract is a tagged union:

- `fixed`: currency plus one minor-unit amount;
- `range`: currency plus ordered minimum/maximum minor-unit amounts;
- `tiered`: currency plus non-overlapping quantity windows and unit amounts;
- `negotiable`: no invented amount, optional currency/MOQ;
- `unavailable`: no usable currency-bearing price in the source.

Alibaba quantity breaks are supplier quotation evidence. They do not map to the
legacy customer `vipPrice`, which is out of scope.

Descriptions pass through the shared allowlist sanitizer. The observation may
carry sanitized HTML and text; it never carries executable source HTML. Exact
provider bytes remain separately hash-addressed evidence. Frontend code must
validate the observation and render its reviewed projection rather than read
raw provider JSON or call `innerHTML` with source content.

The embedded Alibaba `attr2_value` is special because it is JSON encoded inside
the outer JSON response. It uses the bounded lossless parser rather than lodash
or ordinary `JSON.parse`: empty, null, scalar, array, malformed, oversized and
over-depth values degrade to the direct compatibility attributes without
throwing; exact numeric id lexemes survive; duplicate and dangerous object keys
are rejected.

“Scoped to one SKU” means the product-level attribute dictionary lists all
possible choices, while that SKU's own `attr2_value` selects its actual choice.
For a product defining Black and Red, the Black SKU selects Black and the Red
SKU selects Red. That SKU-specific selection therefore wins over a same-named
generic compatibility value.

## Persistence contract

`catalogSourceObservations` is private (`ADMINONLY`) and uses a deterministic
SHA-256 id over `(provider, sourceProductKey)`. Replays converge on the same
row. The wrapper stores query/provenance fields plus the validated observation:

- provider and source/external product ids;
- schema version, observation/source-update instants and active flag;
- evidence id;
- `firstSeenOperationId` and `lastSeenOperationId`, neutral names that accept
  an Alibaba sync run id or a Dianxiaomi import job id;
- the strict provider-neutral observation.

The large Alibaba raw response is not copied into NoSQL. Its evidence entry
references the existing payload hash/COS object. Dianxiaomi references the
source workbook digest; the workbook bytes are not stored in the observation.

Normal Alibaba detail ingestion now writes the observation beside its existing
source mirror and supplier offers. A confirmed tombstone deactivates the common
row through the same fenced repair window used for canonical demotion.
Dianxiaomi staging writes one observation per valid grouped product, preserving
separate per-store regular/promotion offers. An invalid observation rejects only
that staged item and never overwrites the last valid common row.

## Existing-data migration

Alibaba's current 1,074 source products are migrated from immutable raw
`product.get` evidence in pages of at most 20 under the shared Alibaba lease.

1. A dry-run page verifies source/payload metadata, byte size, SHA-256, provider
   envelope and ids, deterministic source key, exact current active offer-key
   set, and the common observation contract. It performs no writes.
2. The dry-run returns a SHA-256 over that page's source/raw/offer/observation
   material.
3. Apply requires the exact page hash and repeats the complete preflight before
   its first write. A changed page stops with conflict.
4. Apply updates only derived `sourceAttributes` on existing supplier offers
   and upserts the common observation. It preserves first/last run provenance
   and never writes, links, prices or publishes a canonical product.
5. Deterministic ids make an interrupted page safe to repeat. The entire live
   dataset must pass dry-run before the first apply page.

Expected live invariants from the read-only audit are 1,074 observations,
3,672 active offers represented, 3,661 attributed variants, 10,100 option
pairs, 1,808 tiered USD offers and 1,864 unavailable-price offers. Any mismatch
or per-row failure stops apply for investigation.

## Branch and UI boundary

The stable remote Dianxiaomi feature head was merged into
`fix/alibaba-sync-storage-wiring`; its separate dirty local worktree and newer
UI prototype were not copied or edited. This implementation supplies the
common backend contract that UI can target. It does not adopt either old
Alibaba admin rows or an unpublished prototype as the final UI.

The next UI stage should decode the common observation as `unknown`, display a
source-comparison/review projection, and keep raw evidence behind authenticated
admin routes. Category mapping, product linking and public promotion remain
explicit later decisions.

## Acceptance gates

- common-contract, provider-adapter and malformed-input tests pass;
- real Dianxiaomi acceptance workbook writes 77 deterministic observations,
  preserves store-scoped prices and writes zero canonical products;
- both function artifacts are self-contained and pass cold-start smoke tests;
- the new NoSQL collection and indexes exist with `ADMINONLY` permission before
  deploying the Alibaba function;
- all live Alibaba pages pass dry-run before apply;
- post-apply database counts and sampled tier/attribute/evidence records match
  the immutable raw payloads;
- `products`, source links and category mappings remain unchanged by replay.
