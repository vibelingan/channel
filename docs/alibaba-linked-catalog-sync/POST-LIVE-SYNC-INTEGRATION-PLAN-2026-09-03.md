# Post-live-sync catalog integration plan — 2026-09-03

## Decision

Continue on `fix/alibaba-sync-storage-wiring` for the next isolated Alibaba
correction. Do not merge the older `origin/feat/alibaba-icbu-top` into `main`
first: the current branch already contains that branch plus the seven live-sync
fix commits that preceded this MIU, so merging the older head would deliberately
land the incomplete state.

Do not start public-catalog integration from
`origin/refactor/catalog-architecture-hardening` yet. The branch is active, not
abandoned (its latest observed commit is `03b5f17`, 2026-09-03), but its public
family adapter/controller work is still in progress. Treat its eventual public
projection interface as an integration dependency, not as today's write base.

## Verified workstream snapshot

| Workstream | Verified head | Current meaning |
| --- | --- | --- |
| Alibaba live sync | `fix/alibaba-sync-storage-wiring`, eight commits ahead of upstream base `26eb279` | OAuth/TOP/full-sync/SKU-contract fixes exist locally; no Alibaba PR to `main` exists yet |
| Dianxiaomi/Lazada import | remote `0cf5526` | import core is on the feature branch; PR #29 to `main` remains draft |
| Catalog architecture refactor | remote `03b5f17` | actively implementing MIU 14; later public seams are not released |
| `main` | remote `78506d5` | does not contain the three workstreams above |

The local Dianxiaomi worktree is intentionally read-only for this MIU. It is
behind its remote and contains uncommitted Admin/UI/prototype work. Those files
must be preserved and reviewed against the final public projection rather than
bulk-merged or discarded.

## Ownership and write scope

This Alibaba MIU may write only:

- `packages/alibaba-catalog-sync/src/alibaba-contracts.ts`;
- `packages/alibaba-catalog-sync/src/alibaba-contracts.test.ts`;
- Alibaba-specific design/execution documentation.

It must not write `apps/site`, `apps/functions/public-api`,
`packages/catalog-import`, the Dianxiaomi worktree, or the catalog-refactor
worktree. This keeps the live contract correction independently mergeable.

## MIU 16 — Live TOP SKU attribute contract correction

### Runtime problem

The completed full sync stored 3,672 active SKU offers, but every offer had an
empty `sourceAttributes` object. The provider returned the option data; the
extractor read a different shape:

```ts
// Old compatibility path only
const attributes = getPath(sku, ['attributes']);
```

The live TOP response instead separates the dictionary from the selection:

```text
product_sku.sku_attributes.sku_attribute[]
  attribute_id + attribute_name
  values.sku_attribute_value[]: value_id + system_value_name

product_sku.skus.sku_definition[].attr2_value
  JSON string: { attribute_id: value_id }
```

### Data shape

| Value | Example | Lifetime | Scope |
| --- | --- | --- | --- |
| Attribute definition | `19089 -> Connectors` | one raw product detail | source product |
| Attribute value | `3236313 -> 3.5 mm` | one raw product detail | source product attribute |
| SKU selection | `{"19089":3236313}` | one raw product detail | source SKU |
| Normalized fact | `{ "Connectors": "3.5 mm" }` | refreshed on sync/replay | supplier offer |

Negative value ids are valid provider identifiers. A sampled live response used
`-2` for the named value `USB + 3.5mm`; sign is not a validity rule for ids.

### Technology constraint

`attr2_value` is JSON encoded inside a JSON string. It must pass through the
existing lossless parser so numeric identifiers are compared as exact lexemes.
Malformed embedded JSON or an unknown id must not crash a page/run and must not
invent an option name. The immutable raw object remains the recovery evidence.

### Design / flow

```text
sku_attribute definitions ──> id/name lookup
                                  +
sku_definition.attr2_value ──> id selections
                                  |
                                  v
                       sourceAttributes
```

The existing direct `sku.attributes[]` shape remains a compatibility fallback.
When both shapes provide the same named option, the live TOP `attr2_value`
selection wins because it is explicitly scoped to that SKU.

### Best-practice fix

Build the product-level lookup once, then join it for every SKU. Keep malformed
and unknown entries absent rather than exposing raw provider ids as customer
content.

```ts
const definitions = extractSkuAttributeDefinitions(product);
const selections = extractSkuAttributeSelections(getPath(sku, ['attr2_value']));

for (const [attributeId, valueId] of selections) {
  const definition = definitions.get(attributeId);
  const valueName = definition?.valuesById.get(valueId);
  if (definition && valueName) skuDraft.attributes[definition.name] = valueName;
}
```

### Alternatives rejected

- Treat empty attributes as provider truth: rejected because the raw payloads
  prove the data exists.
- Parse ids with `JSON.parse` and numbers: rejected because the integration's
  existing contract preserves numeric lexemes across the trust boundary.
- Put unresolved ids into `sourceAttributes`: rejected because this record will
  later feed operator and storefront projections; raw evidence already retains
  the unresolved source value safely.
- Implement the shared catalog adapter in this MIU: rejected because its seam is
  jointly owned with the active Dianxiaomi/refactor workstreams.

### Risk / test

Required focused tests:

- join two live-style attributes across two SKUs;
- preserve valid negative value ids;
- unwrap singleton attribute/value wrappers;
- keep direct compatibility attributes when embedded JSON is malformed;
- ignore unknown ids without throwing.

Validation:

```sh
pnpm --filter @vibelingan-channel/alibaba-catalog-sync test
pnpm --filter @vibelingan-channel/alibaba-catalog-sync typecheck
```

The read-only replay gate was completed against the exact 1,074 payload ids
currently referenced by `alibabaSourceProducts`:

- 1,074/1,074 payload files matched and parsed with no malformed/API errors;
- 3,672 SKUs were recovered;
- 3,661 SKUs have source attributes (99.70% coverage);
- 10,100 attribute name/value pairs were recovered;
- the remaining 11 are all Alibaba default SKU `-1`, with no attribute
  dictionary or `attr2_value` in the source response;
- zero malformed `attr2_value` strings.

The replay also exposed source-label normalization work for the future common
contract: Alibaba uses case and language variants such as `color`, `Color`,
`颜色`, `connectors` and `Connectors`. Preserve the source label in evidence,
then map it to a canonical option key during reviewed catalog integration.

Deployment and mutation of the live source mirror remain a separate gate.

## Pricing and content decisions carried into integration

Alibaba tiered prices represent supplier quantity breaks, for example one unit
price from MOQ 500 and a lower unit price from 1,000. This is related to the
customer's earlier quantity-based quotation requirement, but it is not the same
thing as Channel's existing `vipPrice` entitlement. Preserve the source tiers
exactly first; later pricing policy may derive customer/VIP selling prices from
them with explicit margin, currency, rounding and visibility rules. Never copy
a supplier tier amount directly into `vipPrice`.

The exact current-payload replay found HTML-like tags in 1,073 of 1,074 Alibaba
TOP `product.get` descriptions; this is API data, not only an Excel concern.
The Dianxiaomi branch already has
HTML sanitization and description fallback work. During integration, extract
that capability behind one provider-neutral content-evidence module; do not
copy a second sanitizer into the Alibaba package. The browser renders only
approved structured public content.

## Integration gates after MIU 16

1. Preserve and inventory the uncommitted Dianxiaomi UI/prototype files.
2. **Completed:** Alibaba raw-payload replay report; no canonical products were
   published during replay.
3. Freeze a provider-neutral `SourceObservationBundle` with the Dianxiaomi and
   Alibaba shapes as two real adapters.
4. Wait for, or explicitly coordinate ownership of, the catalog-refactor public
   projection seam before changing `public-api` or storefront files.
5. Consolidate the complete Alibaba branch into one reviewed feature head, then
   open/merge one PR to `main`; never merge the known-incomplete earlier head as
   an intermediate release.
