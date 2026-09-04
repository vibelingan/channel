# Post-live-sync catalog integration plan — 2026-09-03

## Decision

Continue on `fix/alibaba-sync-storage-wiring` for the next isolated Alibaba
correction. Do not merge the older `origin/feat/alibaba-icbu-top` into `main`
first: the current branch already contains that branch plus the seven live-sync
fix commits plus the two post-live contract/hardening MIUs, so merging the older
head would deliberately land the incomplete state.

Do not start public-catalog integration from
`origin/refactor/catalog-architecture-hardening` yet. The branch is active, not
abandoned (its latest observed commit is `03b5f17`, 2026-09-03), but its public
family adapter/controller work is still in progress. Treat its eventual public
projection interface as an integration dependency, not as today's write base.

## Verified workstream snapshot

| Workstream | Verified head | Current meaning |
| --- | --- | --- |
| Alibaba live sync | `fix/alibaba-sync-storage-wiring`, ten commits ahead of upstream base `26eb279` after MIU 18 is committed | OAuth/TOP/full-sync/SKU-contract fixes and the one-product inspection path exist locally; no Alibaba PR to `main` exists yet |
| Dianxiaomi/Lazada import | remote `0cf5526` | import core is on the feature branch; PR #29 to `main` remains draft |
| Catalog architecture refactor | remote `03b5f17` | actively implementing MIU 14; later public seams are not released |
| `main` | remote `78506d5` | does not contain the three workstreams above |

The local Dianxiaomi worktree is intentionally read-only for this MIU. It is
behind its remote and contains uncommitted Admin/UI/prototype work. Those files
must be preserved and reviewed against the final public projection rather than
bulk-merged or discarded.

## Ownership and write scope

MIUs 16 and 17 wrote only:

- `packages/alibaba-catalog-sync/src/alibaba-json.ts`;
- `packages/alibaba-catalog-sync/src/alibaba-json.test.ts`;
- `packages/alibaba-catalog-sync/src/alibaba-client.ts`;
- `packages/alibaba-catalog-sync/src/alibaba-client.test.ts`;
- `packages/alibaba-catalog-sync/src/alibaba-contracts.ts`;
- `packages/alibaba-catalog-sync/src/alibaba-contracts.test.ts`;
- Alibaba-specific design/execution documentation.

MIU 18 additionally owns the Alibaba function's handler, inspection module and
focused tests. It must not write `apps/site`, `apps/functions/public-api`,
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

“Scoped to that SKU” means the product-level dictionary only says which option
values are possible, while each `sku_definition` identifies one sellable
variant and its `attr2_value` says which values that exact variant selected.
For example, a product may define both Black and Red; the Black SKU's embedded
map selects Black and the Red SKU's embedded map selects Red. A generic/direct
compatibility field cannot override that variant-specific fact.

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

## MIU 17 — Provider-boundary JSON hardening

### Decision

Keep the existing bounded lossless parser and harden its boundary rather than
adding lodash or replacing it with an incomplete parser stack.

- lodash is an object/path utility, not a JSON grammar, numeric-lexeme, depth,
  or prototype-poisoning boundary;
- the maintained `lossless-json` package preserves numeric source text, but its
  parser does not supply this integration's explicit maximum-depth policy and
  does not by itself replace the need for dangerous-key handling;
- `secure-json-parse` protects ordinary `JSON.parse` output against prototype
  poisoning, but ordinary parsing has already converted Alibaba decimal and id
  lexemes to JavaScript numbers;
- Zod is already used in the deployed function and remains the right tool for
  strict normalized/admin DTOs. It validates values after JSON syntax parsing;
  it is not a substitute for the lossless source parser.

The result is layered:

```text
streamed 8 MiB transport cap
  -> bounded lossless JSON syntax parse
  -> reject dangerous/duplicate keys
  -> tolerant Alibaba source extraction
  -> strict normalized/public DTO validation
  -> allowlisted frontend projection (never raw JSON)
```

The embedded `attr2_value` parser also receives a 64 KiB cap. Real selections
are tiny maps; an oversized value is treated as absent evidence for that SKU,
not allowed to spend the remaining function slice parsing a pathological
second JSON document.

### Required behavior

- empty/whitespace, `null`, `undefined`, scalar, array, malformed, oversized,
  and over-depth embedded values do not throw from product extraction;
- forbidden `__proto__`, `prototype`, and `constructor` object keys fail the
  JSON boundary before the object is used;
- duplicate keys fail rather than silently applying a first/last-wins policy;
- path reads accept own properties only and never treat `Object.prototype`
  members such as `toString` as provider data;
- source number lexemes remain exact;
- malformed source data never reaches the frontend: raw bytes remain durable,
  the ingest reports a coarse parse failure, and no parsed mirror row is
  promoted from that body.

### Verification result

Five boundary failures were observed before the implementation: the
old code accepted dangerous/duplicate keys, accepted a multibyte response over
8 MiB because it counted JavaScript characters, buffered the complete response
before checking its size, treated inherited object properties as source data,
and had no caller-specific embedded JSON cap. The
oversized-SKU test was also mutation-checked by removing the cap call: it failed
by incorrectly accepting the oversized map and overwriting the direct
compatibility value.

After the change, package tests and both Alibaba package/function typechecks
pass. A fresh read-only replay streamed all 1,074 raw objects referenced by the
current source mirror from CloudBase through the hardened parser: 1,074
successes, zero read failures, malformed envelopes, API errors, or missing
product ids; 3,672 SKUs, 3,661 attributed SKUs and 10,100 attribute pairs were
recovered, exactly matching the pre-hardening replay.

### Raw/detail evidence and probe boundary

`alibabaSourcePayloads` is not a second or simplified API. For
`endpointId = product.get`, its storage object is the exact HTTP response returned by
`alibaba.icbu.product.get`, persisted before parsing and addressed by that
body's SHA-256. The parsed source mirror is the simpler internal projection.

A read-only check on three current products confirmed three distinct
`product.get` payloads (5,144, 15,508 and 8,759 bytes), each with a payload id
equal to `responseSha256` and a private `alibaba-raw/...json` object. Their
descriptions show three real shapes: div-heavy content with image runs,
list/table content, and simpler semantic headings/lists/tables. This variance
is why HTML is evidence, not a public rendering contract.

## MIU 18 — Admin-only one-product detail inspection

Alibaba already exposes the remote detail method
`alibaba.icbu.product.get`, and the full-sync runner already calls it once per
listed `product_id`. What was missing was a bounded application action that can
ask for one fresh detail during diagnosis without starting or mutating a whole
catalog run.

The new `inspectProductDetail` action has this contract:

- require the live `admin` role and a bounded provider product id;
- acquire the same per-connection fenced lease as scheduled/manual sync, then
  resolve or refresh the token under that lease;
- call TOP `alibaba.icbu.product.get` once with `product_id` and English;
- persist the exact response to private hash-addressed raw storage before
  parsing;
- run the production lossless parser, live-detail extractor and normalizer;
- verify the returned product id equals the requested id;
- return only an allowlisted structural summary: raw byte count, description
  kind/length, image/SKU/attribute/tier counts, price modes, currency, status,
  deduplication result and private payload id.

The action deliberately does **not** upsert `alibabaSourceProducts` or
`alibabaSupplierOffers`. Those rows use runner-owned `lastSeenRunId`, checkpoint,
tombstone, quarantine and promotion semantics. A direct diagnostic write would
look like a real catalog run without owning those invariants and could race a
full-run disappearance sweep. If product-by-product mutation is later required,
it should be a first-class `targeted` sync run, not a side effect of inspection.

Focused verification covers admin authorization, invalid ids before any lease
or provider call, the exact TOP method/parameters, raw-before-parse persistence,
provider-id mismatch, lease release, zero source-mirror/offer writes, and the
absence of token/title/description/image URL content from the response.

### Deployment and live data-analysis gate

The user approved deploying the finalized Alibaba function to the current
CloudBase environment. Release verification must prove:

1. the function health endpoint reports the deployed commit under remote Node
   20.19;
2. one authenticated admin inspection produces a fresh or deduplicated private
   `product.get` payload and a safe structural summary;
3. the payload metadata hash matches its private storage object;
4. source-mirror and offer counts/content are unchanged by the inspection;
5. current completed full-run rows, all active source products and all supplier
   offers remain mutually referential before any shared schema/UI integration.

Live status on 2026-09-04: gates 1, 3, 4 and 5 passed. Gate 2 passed its
deployment and authorization boundary—the new action is recognized and rejects
an anonymous caller with 401—but a fresh authenticated one-product inspection
was not invoked because the current Admin UI has no diagnostic control and the
browser session credential was not exported. Separately, the existing
authenticated Admin action completed a new incremental run, persisted its exact
zero-item TOP list response and advanced the committed cursor without changing
product or offer rows. The full post-deploy evidence is recorded in
`LIVE-DATA-STRUCTURE-AUDIT-2026-09-04.md`.

## MIU 19 — Authenticated Admin detail inspection control

### Runtime problem

The function action exists, but the current Admin UI cannot invoke it through
the browser's existing authenticated session. An anonymous HTTP probe returning
401 proves only that the route and auth guard are deployed; it does not exercise
Alibaba TOP or produce a fresh `product.get` observation.

### Data and trust boundary

The browser sends `{ action: 'inspectProductDetail', token,
data: { sourceProductId } }` through the existing Alibaba Admin client. The JWT
is browser-session state and must not be exported. The server resolves the
encrypted Alibaba OAuth token only after it has authenticated the current user
as an admin and acquired the shared sync lease. The UI receives only the
allowlisted structural summary; it must never receive or render source title,
description HTML, image URLs or either token.

### Design and technology constraints

Add one feature-level form between the connection panel and the run-management
surfaces. Reuse the existing slate visual language and shared busy state. Use a
labelled, bounded provider-id input, native form validation, explicit disabled
state when disconnected, and an `aria-live` result region. Treat the API body
as `unknown` and validate every field before rendering; a generic TypeScript
cast is not a runtime contract.

```ts
const raw: unknown = await call('inspectProductDetail', { sourceProductId });
const summary = decodeProductDetailInspectionSummary(raw);
if (!summary) throw new AlibabaSyncApiError('INTERNAL_ERROR', 'Invalid inspection summary.');
```

### Alternatives rejected

- Exporting the browser JWT to curl: breaks the session boundary merely to
  close a test checkbox.
- Calling Alibaba directly from the browser: exposes provider credentials and
  bypasses the server lease/raw-evidence path.
- Making the probe update source mirror rows: creates an incomplete catalog run
  without checkpoint, `lastSeenRunId` and tombstone ownership.

### Risk and verification

Component/API tests must reject malformed summaries and prove the rendered
surface contains no raw content. Browser verification must exercise the real
Admin session, submit one known source product id, observe a structural result,
confirm no console error, and then compare the newly stored detail evidence to
the list payload and existing mirror counts.

### Local acceptance (2026-09-04)

The implementation passed 211 site unit/render tests, the nine-test Catalog
Admin browser lane (including authenticated request and 375 px overflow
coverage), site and E2E type checks, Biome, the production static build, and a
secret-name/build-fixture scan. Live deployment and the authenticated provider
observation remain the release gate; local mocks alone do not prove Alibaba's
current contract.

## Pricing and content decisions carried into integration

Alibaba tiered prices represent supplier quantity breaks, for example one unit
price from MOQ 500 and a lower unit price from 1,000. Preserve those supplier
tiers exactly. The customer has said the existing `vipPrice` behavior is not
needed now, so VIP mapping, policy and UI are out of this integration scope.
The legacy field remains untouched only for backward compatibility; Alibaba
sync never reads or writes it.

The exact current-payload replay found HTML-like tags in 1,073 of 1,074 Alibaba
TOP `product.get` descriptions; this is API data, not only an Excel concern.
Do not attempt to “understand arbitrary HTML” with one brittle selector set.
Keep the exact source once, sanitize through a reviewed tag/attribute/protocol
allowlist, and extract only conservative structures (headings, paragraphs,
lists and two-column label/value tables). Unrecognized content degrades to
sanitized text/evidence, never direct `innerHTML`. The Dianxiaomi branch already
has HTML sanitization and description fallback work. During integration,
extract that capability behind one provider-neutral content-evidence module;
do not copy a second sanitizer into the Alibaba package.

Option-name normalization (`color` / `Color` / `颜色`) does not require a source
mirror schema change. `sourceAttributes` keeps the provider labels today; the
future common adapter maps them to canonical keys and records provenance.
Evidence means both the immutable raw-object reference and compact field-level
facts such as source path/label, normalized key, confidence and conflicts. The
large raw body is stored once by content hash; field evidence references its
payload id rather than duplicating the JSON.

## Integration gates after MIU 17

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
