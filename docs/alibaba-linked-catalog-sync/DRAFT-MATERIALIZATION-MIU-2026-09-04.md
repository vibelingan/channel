# Alibaba draft materialization MIU — 2026-09-04

## Outcome

The source mirror is not the operator's product list. Every active Alibaba
source product must therefore have one idempotent, admin-visible Channel
product draft. The draft is always `published: false`; missing category mapping
keeps it uncategorized instead of hiding it or inventing a family.

## MIU ALC-DRAFT-01 - Visible unpublished drafts

### Runtime Problem

The completed live replay produced 1,074 `alibabaSourceProducts` and 1,074
provider-neutral observations, but `products` remained at seven. The current
worker called `createDraftForSource()` only after finding an
`alibabaCategoryMappings` row. With zero mappings, all 1,074 products were
silently absent from the screen where operators work.

Current risky shape:

```ts
const mapping = mappings.items[0];
if (!mapping) return { ok: false, reason: 'no-category-mapping' };
```

### Data Shape

| Value | Example | Lifetime | Owner/scope |
| --- | --- | --- | --- |
| Source mirror | `alibabaSourceProducts/<sourceKey>` | current provider state | Alibaba sync |
| Sanitized observation | `catalogSourceObservations/<sha256>` | current derived state | source adapter |
| Source link | `alibabaProductLinks/<sourceKey>` | durable identity | sync/link service |
| Product draft | `products/<opaque-id>` | durable until archived | operator after creation |
| Publication | `published: false` | operator-controlled | admin catalog |

### Technology Constraint

CloudBase document writes are individually durable, while creating a link and
a product spans two documents. A random product id chosen after claiming the
link can leave an orphan under a concurrent retry. The admin list reads only
`products`; showing source rows in another diagnostic table would not satisfy
the product-management workflow.

### Design / Flow

```mermaid
sequenceDiagram
  participant Admin
  participant SyncFn as Alibaba sync function
  participant Mirror as Source mirror
  participant Link as Source link
  participant Product as Products
  Admin->>SyncFn: materializeDrafts(cursor, optional category)
  SyncFn->>Mirror: active rows, _id ordered, max 20
  loop each source
    SyncFn->>Link: create-if-absent(sourceKey -> deterministic opaque productId)
    SyncFn->>Product: create-if-absent(unpublished draft)
  end
  SyncFn-->>Admin: bounded counts + next cursor
```

### Best-Practice Fix

- Treat category mapping as publication enrichment, not admin visibility.
- Prefer provider-neutral `sourceCategoryMappings`; retain the old Alibaba-only
  mapping as a compatibility fallback.
- Seed the draft from sanitized observation text, never the raw HTML.
- Store source id, category id, status and HTTPS image candidates as read-only
  Alibaba fields; the public API allowlist never exposes them.
- Use the same `createDraftForSource()` primitive from normal sync, selected
  product sync and catch-up materialization.
- Generate a stable opaque product id before the link claim so retries converge
  and a link-first crash is repairable.

Target invariant:

```ts
draft.published === false;
unmapped => draft.productFamily === undefined;
one sourceKey => one link => one productId;
```

### Alternatives Rejected

- Default every unmapped product to `misc`: rejected because it converts
  missing operator taxonomy into false catalog truth.
- Render source rows directly inside Products without creating products:
  rejected because edit, preview and publication would still operate on a
  different collection.
- Repeat the 1,074 live detail calls for migration: rejected because the exact
  validated current mirror already exists and replaying the provider adds
  latency, quota use and another failure surface without new information.
- Auto-publish or auto-import every image: rejected because publication and
  media selection are operator decisions. Admin previews may use validated
  source HTTPS URLs; public images still require the managed image lifecycle.

### Code Translation

`materializeAlibabaDraftPage()` walks at most 20 rows by unique `_id` cursor.
If a request fails after a prefix committed, retrying the same cursor is safe:
existing links and products are returned as existing, not duplicated.

`syncSelectedAlibabaProduct()` calls TOP `product.get`, writes immutable raw
evidence, updates source observation/offers, creates or repairs the same draft,
then materializes only Alibaba-owned pricing/status fields. It does not create
a special one-off schema or bypass the sync lease.

### Risk / Test

Primary failure modes:

- accidental public visibility;
- invented category;
- duplicate/orphan product under retry;
- raw supplier HTML entering product description;
- untrusted remote image URL entering the DOM.

Tests:

- `an unmapped source still creates a visible unpublished draft`
- `RACE: concurrent draft creation converges on one product`
- `materializes active sources in stable cursor pages and is idempotent`
- `selected product sync ingests detail and creates one unpublished visible draft`
- `admin source previews allow only bounded HTTPS Alibaba CDN URLs`
- publication validation continues to require family, description and a
  managed image before `published: true` can commit.

Validation commands:

```sh
pnpm --filter @vibelingan-channel/fn-alibaba-catalog-sync typecheck
pnpm --filter @vibelingan-channel/fn-alibaba-catalog-sync test
pnpm --filter @vibelingan-channel/site typecheck
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @vibelingan-channel/site test
pnpm lint
pnpm verify:cloudbase-sdk
```

## Business correction result

`safe`, subject to deployed acceptance:

- actor: live admin only for materialization and selected sync;
- durable identity: one source link names one product;
- external provider: selected sync is lease-serialized and bounded to one
  product call;
- user-visible truth: source data appears in Products as disabled drafts;
- public truth: `published === true` plus existing publication validation
  remains the only storefront gate;
- money: Alibaba tier/range/quote values remain the discriminated
  `alibabaCatalogPricing` model and never overwrite legacy scalar prices.
