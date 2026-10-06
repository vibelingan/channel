# Catalog single source of truth — MIU breakdown

Design and decisions: [DESIGN.md](DESIGN.md). Progress: [EXECUTION_LOG.md](EXECUTION_LOG.md).
Branch: `feat/catalog-alibaba-price-tiers` (continue here until it merges to `main`).

Each MIU goes through test-first → implement → simplify → review → validate →
commit on its own. MIUs marked **Owner: DEC-n** must not start until the owner has
confirmed that decision (README "Open decisions").

Validation commands used below (repo root):

```bash
pnpm lint
pnpm typecheck
NODE_OPTIONS=--no-experimental-webstorage pnpm test
pnpm build
pnpm build:functions && pnpm smoke:functions
```

`NODE_OPTIONS=--no-experimental-webstorage` is needed only on local Node 25 (its
built-in `localStorage` breaks some admin tests); CI uses Node 22.

---

## Level 1 — product tasks

| ID | Product task (what a buyer or admin notices) | MIUs |
|---|---|---|
| PT-0 | Product page shows Alibaba-style tier prices (done: PR #64 to `test`, commits `5913f20`, `7984dea`) | — |
| PT-A | A product's headline Alibaba price is never shown as a fixed price | 1–2 |
| PT-B | List card, product page and quote always show the same approved data | 3–14 |
| PT-C | Admins see which products changed since approval and approve them in one action | 15–25 |
| PT-D | The 21 products are restored and consistency is proven on the live site | 26 + runbook |

## Dependency order and deploy batches

```
PT-A   1 → 2
PT-B   3 → 4
       3 → 6 → 7
       3 → 5 → 8, 9, 10
       3 → 11 → 12 → 13
       8, 12 → 14
PT-C   15 → 21, 23 → 24, 25
       16 → 17 → 18
       15, 16, 18 → 19 → 20
       15, 16, 18 → 22
PT-D   26 (no code dependency; run after batch 3 and batch 4)
```

Contracts come first: MIU-3 (price summary schema), MIU-5 (public version rule),
MIU-15 (review reason field) and MIU-16 (source digest) define shapes that later
MIUs consume.

| Batch | MIUs | Deployed state after the batch |
|---|---|---|
| 1 | 1, 2 | Headline no longer a price; stored offers rebuilt by replay (runbook R2) |
| 2 | 3, 4, 6, 7 | Every approval stores a price summary; existing versions backfilled (R4). **Public reads unchanged.** |
| 3 | 5, 8, 9, 10, 11, 12, 13, 14, 26 | All public surfaces read the one version; consistency audit passes (R5) |
| 4 | 15–25 | "Changed" flag live; audit flags stale products (R6); admin re-approves (R7) |

Each batch: PR into `test` → Deploy Test → runbook checks → next batch.

---

## PT-A — Headline price is not a fixed price

### MIU-1: `normalizeProductDetail` — omit the wholesale headline offer when SKUs exist

```
Block:      BACKEND
Files:      packages/alibaba-catalog-sync/src/alibaba-normalizer.ts
            packages/alibaba-catalog-sync/src/alibaba-raw-completeness.test.ts
            packages/alibaba-catalog-sync/src/alibaba-normalizer.test.ts
Type:       modify-existing
Depends on: none
```

**What it does**
- In the product-level offer block (today `alibaba-normalizer.ts:317-364`), stop
  emitting the `'@product'` offer for `productType === 'wholesale'` when
  `detail.skus.length > 0`. The wholesale headline
  (`wholesaleTrade.priceLexeme`) is Alibaba's cheapest-tier summary, not a price
  (DESIGN §2.3).
- Products **without** SKUs keep today's behaviour (ladder → tiered, wholesale
  price → fixed, FOB → range). Sourcing (FOB) products **with** SKUs are unchanged.
- Return type `NormalizeResult` unchanged; only the `offers` array content changes.
- Keep the headline amount available for audit only if a caller needs it (no new
  field unless a test requires it).

**Build/Deploy/Runtime impact**
- Package is bundled by `tsup` into `apps/functions/alibaba-catalog-sync`; no new
  dependency. Verify `pnpm build:functions && pnpm smoke:functions`.
- Changes the source content hash for affected products on their next ingest;
  handled by MIU-2 (replay stores the new hash) and runbook R2.
- No CloudBase index or env change.

**Test plan (write first)**
- `alibaba-raw-completeness.test.ts:359-409` (headline 390 next to SKU tiers):
  assert `offers` has **no** `sourceSkuId === '@product'` entry and every SKU offer
  keeps its tiers.
- `:329-357` (headline only, SKU invalid): assert no `'@product'` offer and SKU
  pricing `mode === 'unavailable'` (product shows "Request a quote").
- `:498-514` captured wire fixture: update the "both price scopes" expectation to
  SKU scope only.
- Regression: a wholesale product with **zero** SKUs still yields one `'@product'`
  fixed offer (`alibaba-normalizer.test.ts:126` stays green); a sourcing product
  with SKUs still yields its FOB range offer.

**Done when**
- The four assertions pass; all `packages/alibaba-catalog-sync` tests pass.
- `pnpm typecheck` and `pnpm build:functions && pnpm smoke:functions` pass.

### MIU-2: raw replay — accept and deactivate a dropped `'@product'` offer; store the new content hash

```
Block:      BACKEND
Files:      apps/functions/alibaba-catalog-sync/src/raw-replay.ts
            apps/functions/alibaba-catalog-sync/src/raw-replay.test.ts
            apps/functions/alibaba-catalog-sync/src/ingest.ts
Type:       modify-existing
Depends on: MIU-1
```

**What it does**
- Bump `REPLAY_PARSER_VERSION` (`raw-replay.ts:35`, today
  `'alibaba-content-media-v5'`) to `'alibaba-content-media-v6'`.
- Extend the one-way key exception (`raw-replay.ts:606-621`): when the existing
  active set equals the replayed set **plus** exactly the `'@product'` offer, the
  manifest row is valid (reason `product-headline-dropped`) instead of
  `offer-set-mismatch`. Any other difference still fails.
- On apply (`raw-replay.ts:706-769`), set `active: false` on that `'@product'`
  offer in the same guarded write as the rebuilt SKU offers.
- Export `contentFingerprint` from `ingest.ts` (no behaviour change) and have apply
  write the recomputed `alibabaSourceProducts.contentHash`, so the next ingest
  compares like with like and does not count the product as changed (surge guard:
  `runner.ts:708`).
- Still never writes `products`, `catalogDetailPublication` or
  `catalogDetailVariants`; still never calls Alibaba.

**Build/Deploy/Runtime impact**
- Function code only (`alibaba-catalog-sync`). Writes one more field on
  `alibabaSourceProducts`; no index change. Runs only when an admin triggers replay
  (admin page "Alibaba observation replay").

**Test plan (write first)**
- Existing active offers = SKU offers + `'@product'`; replayed = SKU offers only →
  dry-run row status valid with reason `product-headline-dropped` (not
  `offer-set-mismatch`).
- Apply on that row: SKU offers rebuilt; `'@product'` offer `active === false`;
  `alibabaSourceProducts.contentHash` equals `contentFingerprint(...)` of the
  replayed result; no `products` write captured.
- Negative: replay set missing a **SKU** offer → still `offer-set-mismatch`, nothing
  written.
- `raw-replay.test.ts:74` add-only exception still passes.

**Done when**
- All `raw-replay` tests pass; `apps/functions/alibaba-catalog-sync` tests pass.
- `pnpm typecheck`, `pnpm build:functions && pnpm smoke:functions` pass.

---

## PT-B — One public version for list, page and quote

### MIU-3: `CatalogPriceSummarySchema` + `derivePriceSummary` + optional `priceSummary` on the publication

```
Block:      BACKEND (shared contract)
Files:      packages/shared/src/catalog/price-summary.ts        (new)
            packages/shared/src/catalog/price-summary.test.ts   (new)
            packages/shared/src/catalog/product-detail.ts
Type:       new-file + modify-existing
Depends on: none
```

**What it does**
- Contract (consumed by MIU-4, 6, 8, 11, 12):
  ```ts
  CatalogPriceSummarySchema = z.object({
    source: z.enum(['website', 'sku', 'product']),
    variantId: z.string().min(1).max(200).optional(), // SKU that supplied it
    pricing: <existing offer pricing schema from offer-pricing.ts>,
  }).strict();
  ```
- `CatalogDetailPublicationSchema` (`product-detail.ts:88-116`) gains
  `priceSummary: CatalogPriceSummarySchema.optional()` at **top level**. The strict
  `CatalogDetailHeaderSchema` is **not** changed (a header key would break every
  product page decode).
- `derivePriceSummary({ websitePricing?, offers, variants: {id, offers}[] })
  → CatalogPriceSummary | undefined`, pure, never throws:
  1. `websitePricing` with an amount-bearing mode → `source: 'website'`.
  2. Else the amount-bearing SKU offer with the lowest minimum unit amount;
     currency preference USD, then CNY, then others alphabetically; ties → earliest
     SKU position → `source: 'sku'`, `variantId`.
  3. Else an amount-bearing product-level offer → `source: 'product'`.
  4. Else `undefined` (card shows "Request a quote").
- Re-exported from `packages/shared/src/catalog/index.ts` only if that is the
  existing pattern for catalog helpers.

**Build/Deploy/Runtime impact**
- `@vibelingan-channel/shared` is consumed raw-TS by the site (Astro/Vite) and
  bundled by `tsup` into every function. No new dependency. Verify `pnpm build`
  and `pnpm build:functions && pnpm smoke:functions`.
- Adding an optional key to a strict schema: existing stored publications (no key)
  still decode.

**Test plan (write first)**
- Website tiered pricing present → `{source: 'website', pricing: <that pricing>}`.
- SKUs A (tiers 130/122/120 USD) and B (fixed 125 USD) → `source: 'sku'`,
  `variantId: 'A'` (minimum 120 < 125).
- SKU USD 500 and SKU CNY 300 → picks the USD one (currency preference over amount).
- All SKUs `unavailable`, header fixed 400 → `source: 'product'`.
- Everything unavailable/negotiable → `undefined`.
- Schema: a publication without `priceSummary` decodes; one with an unknown key
  inside `priceSummary` is rejected; a header with `priceSummary` is still rejected.

**Done when**
- Tests pass; `pnpm typecheck` passes for all packages and the e2e project.
- `pnpm build` and `pnpm build:functions && pnpm smoke:functions` pass.

### MIU-4: `planCatalogDetailApproval` stores `priceSummary` on every new approval

```
Block:      BACKEND
Files:      packages/shared/src/catalog/detail-approval.ts
            packages/shared/src/catalog/detail-approval.test.ts
            packages/db/src/catalog-detail-staging.test.ts
Type:       modify-existing
Depends on: MIU-3
```

**What it does**
- After the variants are planned (`detail-approval.ts` ~146) and before the
  publication object is built (~159-167), call `derivePriceSummary` with
  `header.websitePricing`, `header.offers` and the full planned `variants` and set
  `publication.priceSummary` when defined.
- All approval paths inherit it: staged prepare (`catalog-detail-staging.ts:119-169`,
  stored in `job.publication`), single-transaction commit, workflow review and the
  local rehearsal. `stageApprovalPage` re-plans one page of ≤20 rows and uses only
  `.variants`; the derivation must not throw on that partial set (its summary is
  discarded there).
- `finishStagedApproval` copies `job.publication` unchanged
  (`catalog-detail-staging.ts:323-326`) — no change needed there.
- `catalogApprovalDigest` hashes the plan (`catalog-detail-commit.ts:81`), so every
  open review digest changes once. Expected; see DESIGN §8.

**Build/Deploy/Runtime impact**
- Shared package (site + functions, as MIU-3). Job documents grow by one small
  object (512 KB cap at `catalog-detail-staging.ts:164` unaffected).
- Deploy when no admin review is open (one CONFLICT otherwise).

**Test plan (write first)**
- `planCatalogDetailApproval` with two SKUs (tiers min 120, fixed 125) →
  `publication.priceSummary` = `{source: 'sku', variantId: <first>, ...}`.
- With manual website pricing → `priceSummary.source === 'website'`.
- One-page partial plan (stage path) does not throw.
- `catalog-detail-staging.test.ts`: after begin → page → finish, the product's
  `catalogDetailPublication.priceSummary` equals the prepared job's summary and the
  revision is the job's revision.

**Done when**
- Tests pass; existing approval/staging/commit tests pass (update pinned digests
  only where the new field changes them, and say so in the commit).
- `pnpm typecheck`, `pnpm build:functions && pnpm smoke:functions` pass.

### MIU-5: `resolvePublicVersion` — the shared rule for which version is public

```
Block:      BACKEND (shared contract)
Files:      packages/shared/src/catalog/public-version.ts        (new)
            packages/shared/src/catalog/public-version.test.ts   (new)
Type:       new-file
Depends on: MIU-3
```

**What it does**
- `resolvePublicVersion(product: unknown, opts: { detailEnabled: boolean })
  → { kind: 'approved'; publication: CatalogDetailPublication } | { kind: 'row' }`.
- Returns `approved` only when all hold: `opts.detailEnabled`; the product has a
  non-empty `alibabaPrimarySourceKey` (still linked); `catalogDetailPublication`
  decodes with `CatalogDetailPublicationSchema`; `header._id === product._id`.
- Everything else (manual products, unlinked-after-approval, linked but never
  approved, feature off) → `row` (DEC-1, DEC-4).
- Pure; never throws.

**Build/Deploy/Runtime impact**
- Shared package, as MIU-3. None beyond build verification.

**Test plan (write first)**
- Linked + valid publication + enabled → `approved` with the decoded publication.
- Same product with `detailEnabled: false` → `row`.
- Unlinked (`alibabaPrimarySourceKey` absent) + valid publication → `row`.
- Linked + malformed publication / header `_id` mismatch → `row`.
- Manual product → `row`.

**Done when**
- Tests pass; `pnpm typecheck` passes.

### MIU-6: price summary backfill (db) for existing approved versions

```
Block:      BACKEND
Files:      packages/db/src/catalog-price-summary-backfill.ts        (new)
            packages/db/src/catalog-price-summary-backfill.test.ts   (new)
Type:       new-file
Depends on: MIU-3
```

**What it does**
- `planPriceSummaryBackfill({ afterId?, pageSize ≤ 20 })` pages `products` by
  `_id asc`, keeps those with a decodable `catalogDetailPublication` and no
  `priceSummary`, reads their approved SKU rows by storage mode
  (`catalogDetailVariants` filtered by `productId` + `catalogDetailRevision` for
  `immutable-v1`, else `productVariants.catalogDetailApproved`, same as
  `catalog-detail.ts:43-48`), and returns a manifest row per product:
  `{productId, revision, proposedSummary | null, reason}`.
- `applyPriceSummaryBackfill(manifestRows)` writes **only**
  `catalogDetailPublication.priceSummary`, in a transaction that re-reads the
  product and requires the same `revision` (skip with `revision-changed`
  otherwise). Never changes `revision`, receipts, `published` or any other field.
  Idempotent: rows that already have a summary are skipped.
- Uses only the existing db adapter (`get`, `list`, transactions). No new CloudBase
  SDK surface, so `pnpm verify:cloudbase-sdk` is not affected.

**Build/Deploy/Runtime impact**
- `packages/db` is bundled into the admin function. No index change: paging by
  `_id` uses the default index; SKU reads use `approved_variant_page` /
  `variant_product_position` (declared in `scripts/cloudbase-nosql-resources.mjs`).

**Test plan (write first)**
- Immutable-v1 product with two SKUs → manifest proposes the cheapest SKU summary.
- Legacy-storage product (`productVariants.catalogDetailApproved`) → same rule.
- Product whose revision changes between plan and apply → `revision-changed`, no
  write captured.
- Apply writes exactly one field path (assert the captured update object has only
  `catalogDetailPublication.priceSummary`); second apply is a no-op.

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm build:functions && pnpm smoke:functions`.

### MIU-7: admin action + script to run the backfill

```
Block:      BACKEND
Files:      apps/functions/admin/src/handler.ts
            apps/functions/admin/src/handler.test.ts
            scripts/catalog-price-summary-backfill.mjs   (new)
Type:       modify-existing + new-file
Depends on: MIU-6
```

**What it does**
- Admin-only action `backfillPublicationPriceSummary { mode: 'plan' | 'apply',
  afterId?, manifest? }` → plan returns the manifest page and `nextAfterId`; apply
  takes the reviewed manifest rows back and returns per-row outcomes.
- Script mirrors `scripts/catalog-price-repair.mjs` (same auth/env handling): pages
  through `plan`, writes the manifest to a local file, and only with
  `--apply <manifest>` calls `apply`. Prints totals: eligible, applied, skipped by
  reason.
- Non-admin roles → `FORBIDDEN`.

**Build/Deploy/Runtime impact**
- New action on the admin function; no env, index or trigger change. Script runs
  locally against the deployed function (same as the price repair script).

**Test plan (write first)**
- Plan as admin returns manifest rows from MIU-6 with `nextAfterId`.
- Apply as admin returns per-row outcomes; as contributor → `FORBIDDEN`, no write.
- Script dry run (mocked fetch) writes a manifest file and makes no apply call.

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm build:functions && pnpm smoke:functions`.

### MIU-8: public list / item / slug projection reads the one version

```
Block:      BACKEND
Files:      apps/functions/public-api/src/handler.ts
            apps/functions/public-api/src/http-adapter.test.ts
            apps/functions/public-api/src/handler.test.ts
Type:       modify-existing
Depends on: MIU-3, MIU-5
```

**What it does**
- In `publicDoc` (`handler.ts:296-341`), call
  `resolvePublicVersion(doc, { detailEnabled: config.enableCatalogDetail === true })`.
- `approved` →
  - `name` = `header.name`
  - `images` = `header.images` made absolute exactly like today's row images
    (`apiBaseUrl` + path, ≤9, `handler.ts:128-140`)
  - `description` = `header.descriptionText` (omit if absent)
  - `priceSummary` = `publication.priceSummary` (new allowlisted key)
  - `moq` = the summary's MOQ (first tier `minimumQuantity` or
    `minimumOrderQuantity`), omitted if unknown
  - **omit** `alibabaCatalogPricing`, `unitPrice`, `wholesalePrice`,
    `manualCatalogPricing` (sync and row prices must not reach the card)
- `row` → today's projection, byte-identical.
- Applies to `listCatalog` (`handler.ts:348-422`), item (`:424-439`) and slug
  (`:441-456`) because all three use `publicDoc`. Filters, sort, paging, search and
  `attachVariants` unchanged.

**Build/Deploy/Runtime impact**
- Public function response shape gains `priceSummary` and loses row price keys for
  approved products. The site must ship MIU-11/12 in the **same** deploy (Deploy
  Test deploys site and functions together). Old cached site bundles ignore
  `priceSummary` and show "Request a quote" for those cards until reload — accepted.
- `scripts/smoke-cloudbase-deploy.mjs` checks (`productFamily`, `images` ≤9,
  forbidden keys) still hold; run it after deploy.
- No index or query change.

**Test plan (write first)**
- Approved linked product: list item has `name/images/description` from the header,
  `priceSummary` equal to the stored one, and **no** `alibabaCatalogPricing`,
  `unitPrice`, `wholesalePrice`, `manualCatalogPricing`.
- Same product with `enableCatalogDetail: false` → today's row projection.
- Manual product → byte-identical to today (`http-adapter.test.ts:459` allowlist
  test unchanged).
- Unlinked product with an old publication → row projection.
- Images: absolute URLs, ≤9, header order.
- Item and slug endpoints return the same projection as the list for the same product.

**Done when**
- Updated public-api tests pass (`http-adapter.test.ts`, `handler.test.ts`,
  `catalog-variants.test.ts`).
- `pnpm typecheck`, `pnpm build:functions && pnpm smoke:functions` pass.

### MIU-9: product page endpoint uses the shared rule

```
Block:      BACKEND
Files:      apps/functions/public-api/src/catalog-detail.ts
            apps/functions/public-api/src/catalog-detail.test.ts   (new; today the
            endpoint is only covered through apps/local-server tests)
Type:       modify-existing + new-test
Depends on: MIU-5
```

**What it does**
- `getProductDetail` replaces its own publication check (`catalog-detail.ts:38-41`)
  with `resolvePublicVersion(product, { detailEnabled: true })` (the route exists
  only when the feature is on). `row` → `NOT_FOUND 'Detail not available'`, which
  sends the site to the legacy page that reads the same row as the card.
- Unlinked-after-approval products therefore stop serving their stale approved page.
- Everything after the check (variant paging, revision checks, decode) unchanged.

**Build/Deploy/Runtime impact**
- Public function only. Behaviour change limited to unlinked products with an old
  publication (count them in runbook R5 before deploy).

**Test plan (write first)**
- Linked approved product → same response as today (snapshot).
- Unlinked product with a valid publication → `NOT_FOUND 'Detail not available'`.
- Manual product → `NOT_FOUND` as today.

**Done when**
- Tests pass, including `apps/local-server/src/catalog-detail-staging.test.ts`;
  `pnpm typecheck`; `pnpm build:functions && pnpm smoke:functions`.

### MIU-10: quote request uses the shared rule

```
Block:      BACKEND
Files:      packages/db/src/catalog-quote.ts
            packages/db/src/catalog-quote.test.ts
Type:       modify-existing
Depends on: MIU-5
```

**What it does**
- Replace the publication parse at `catalog-quote.ts:37-45` with
  `resolvePublicVersion(product, { detailEnabled: true })`; `row` → the existing
  "not available" failure. The snapshot (`header.name`, `header.images`,
  `header.offers`, `header.websitePricing`, selected SKU) is unchanged.
- Add `priceSummary` to the stored snapshot only if the inquiry schema already
  allows extra keys; otherwise leave the snapshot as is (no schema change here).

**Build/Deploy/Runtime impact**
- `packages/db` bundled into public-api / admin functions. No storage change.

**Test plan (write first)**
- Approved linked product + valid SKU → record created with the same snapshot as today.
- Unlinked product with an old publication → failure, no record written.

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm build:functions && pnpm smoke:functions`.

### MIU-11: site list decoder and `Product` type accept `priceSummary`

```
Block:      FRONTEND
Files:      apps/site/src/islands/shop/catalog-types.ts
            apps/site/src/islands/shop/api.ts
            apps/site/src/islands/shop/api.test.ts
Type:       modify-existing
Depends on: MIU-3 (contract: packages/shared/src/catalog/price-summary.ts)
```

**What it does**
- `Product` (`catalog-types.ts:45-77`) gains `priceSummary?: CatalogPriceSummary`
  (type imported from the MIU-3 contract).
- `isProduct` (`api.ts:152-209`) validates `priceSummary` with
  `CatalogPriceSummarySchema.safeParse`; on failure it **drops only that key** and
  keeps the product, so one bad summary cannot fail the whole page
  (`isCatalogPage`, `api.ts:211-220`).

**Build/Deploy/Runtime impact**
- Site bundle only. Ships in the same deploy as MIU-8.

**Test plan (write first)**
- Valid summary → kept on the decoded product.
- Malformed summary (unknown key / bad pricing) → product kept, `priceSummary`
  undefined, page decodes.
- Product without summary → unchanged behaviour.

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm build`.

### MIU-12: card price and MOQ read the summary

```
Block:      FRONTEND
Files:      apps/site/src/islands/shop/EffectiveCatalogPricingBlock.tsx
            apps/site/src/islands/shop/catalog-pricing.ts
            apps/site/src/islands/shop/catalog-family-render.test.ts
Type:       modify-existing
Depends on: MIU-11
```

**What it does**
- `effectiveCatalogPriceSummary` and `effectiveCatalogMoq`
  (`EffectiveCatalogPricingBlock.tsx:11-22`, `catalog-pricing.ts:15-22`): when
  `product.priceSummary` is present it is the only price input. Card text:
  - tiered → "From <lowest tier>"
  - fixed → the amount
  - range → "From <min>"
  - MOQ from the summary
- USD/CNY use the existing card formatter ("$7.67"); any other currency uses the
  product page formatter (`formatCatalogQuoteAmount`, "EUR 7.67").
- No `priceSummary` → today's row logic (manual products), unchanged.

**Build/Deploy/Runtime impact**
- Site bundle only; same deploy as MIU-8.

**Test plan (write first)**
- Summary tiered 130/122/120 USD → card shows "From $1.20" and MOQ 10.
- Summary fixed EUR 1200 → "EUR 12.00".
- Product with summary **and** stale `alibabaCatalogPricing` (old cached API) →
  summary wins.
- Manual product without summary → existing `catalog-family-render.test.ts:137,254`
  expectations unchanged.

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm build`.

### MIU-13: hub "featured" strip shows the effective MOQ

```
Block:      FRONTEND
Files:      apps/site/src/islands/shop/FeaturedProducts.tsx
            apps/site/src/islands/shop/featured-products.test.ts (new, or the existing render test)
Type:       modify-existing
Depends on: MIU-12
```

**What it does**
- Replace the raw `product.moq` read (`FeaturedProducts.tsx:105-108`) with
  `effectiveCatalogMoq(product)` (MIU-12) so the hub matches the card.
- The strip still shows no price (unchanged); only the MOQ source changes. Products
  without any MOQ keep rendering no MOQ line.

**Build/Deploy/Runtime impact**
- Site bundle only.

**Test plan (write first)**
- Product with `priceSummary` MOQ 10 and row `moq` 2 → strip shows 10.
- Manual product with row `moq` 50 → strip shows 50.

**Done when**
- Tests pass; `pnpm build`.

### MIU-14: e2e — configuration switch changes the price; card matches page

```
Block:      TESTING
Files:      tests/e2e/sku-detail.spec.ts
Type:       new-test
Depends on: MIU-8, MIU-12
```

**What it does**
- New mocked-API test: product with SKU "Black" (tiers 2–99 $6.61, 100–999 $5.55,
  ≥1,000 $4.76) and SKU "White" (≥1,000 $4.30). Selecting each configuration shows
  that configuration's own tiers in `[data-price-tier]`.
- Card test: list item with `priceSummary` from "White" → card shows "From $4.30";
  opening the product shows the cheapest configuration's price when it is selected.

**Build/Deploy/Runtime impact**
- Test only. Runs in the existing e2e lane against a local or deployed site.

**Test plan (this MIU is the test)**
- `[data-price-tier]` texts equal Black's three tiers after selecting Black, and
  `['USD 4.30 ≥1,000 pieces']` after selecting White.
- Card text contains "From $4.30".

**Done when**
- `pnpm exec playwright test tests/e2e/sku-detail.spec.ts --project=chromium`
  passes locally (with `NODE_OPTIONS=--no-experimental-webstorage` on Node 25).

---

## PT-C — Changed products are flagged and approved in one action

### MIU-15: `alibabaReviewReason` field and identity rules

```
Block:      BACKEND (shared contract + db)
Files:      packages/shared/src/collections.ts
            packages/db/src/alibaba-product-identity.ts
            packages/shared/src/alibaba-collections.test.ts
Type:       modify-existing
Depends on: none
```

**What it does**
- New read-only product field `alibabaReviewReason: 'new' | 'changed' | 'removed' | null`
  next to `alibabaReviewPending` (`collections.ts:439-445`), in the pinned field
  list (`alibaba-collections.test.ts:77-91`).
- `alibaba-product-identity.ts`: add to `writableFields` / `clearedFields`
  (`:86-114`); create-draft sets `alibabaReviewReason: 'new'` with
  `alibabaReviewPending: true` (`:326`); `reconciliationPatch` (`:130-139`) sets
  `'new'` only when it sets pending `true`, `null` when `false`; unlink clears it.
- No index (the list is not sorted or filtered by reason).

**Build/Deploy/Runtime impact**
- Shared + db packages (site, functions). Existing rows have no reason: treated as
  `'new'` when `alibabaReviewPending === true` (absent field is a state —
  `docs/ENGINEERING_CRAFT.md`).

**Test plan (write first)**
- Field list test includes `alibabaReviewReason` as read-only; a generic write of
  it is rejected.
- Create-draft → `{alibabaReviewPending: true, alibabaReviewReason: 'new'}`.
- Unlink → both cleared to `null`.

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm build:functions && pnpm smoke:functions`.

### MIU-16: `publicSourceDigest` — stable hash of what a buyer would see

```
Block:      BACKEND (shared contract)
Files:      packages/shared/src/catalog/public-source-digest.ts        (new)
            packages/shared/src/catalog/public-source-digest.test.ts   (new)
Type:       new-file
Depends on: none
```

**What it does**
- `publicSourceDigest(observation: PublicSourceDigestInput) → string` (sha256 hex).
  `PublicSourceDigestInput` is a structural type defined here (the
  `catalog-import` observation satisfies it; `packages/db` depends only on
  `shared`, so the helper cannot live in `catalog-import`).
- Canonical JSON over DEC-6 content only:
  - each SKU (by `sourceVariantKey`): option name/value pairs and offer `pricing`
  - the product-level offer pricing
  - ordered media `sourceUrl`s
  - identity attributes
  - trimmed description text
- Excludes: `observedAt`, `captureMode`, evidence/payload ids, inventory/stock,
  `sourceUpdatedAt`, pricing `syncedAt`, title.

**Build/Deploy/Runtime impact**
- Shared package; uses `node:crypto` like existing digest helpers in `packages/db`
  and `alibaba-catalog-sync`. It must not be imported by site/browser code (add a
  comment and keep it out of the browser `index.ts` export if that index is
  browser-shared).

**Test plan (write first)**
- Same observation with different `observedAt`, `captureMode`, stock and
  `syncedAt` → identical digest.
- One SKU tier amount changed → different digest.
- SKU added / option value changed / media order changed → different digest.
- Title changed → identical digest.

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm build:functions && pnpm smoke:functions`.

### MIU-17: prepare records the source digest of the candidate it builds

```
Block:      BACKEND
Files:      packages/db/src/catalog-source-staging.ts
            packages/db/src/catalog-source-staging.test.ts
Type:       modify-existing
Depends on: MIU-16
```

**What it does**
- Where prepare reads the observation in the transaction
  (`catalog-source-staging.ts:66-72`) and writes `detailSourceReady` /
  `detailSourceCandidate` (`:136-137`), also write
  `detailSourcePublicDigest = publicSourceDigest(observed.observation)`.
- Field is internal (not projected publicly; add to the read-only admin field list
  if the collection registry requires it).

**Build/Deploy/Runtime impact**
- db package; one extra field on `products`. No index.

**Test plan (write first)**
- Prepare → product has `detailSourcePublicDigest` equal to
  `publicSourceDigest(observation)`.
- Re-prepare after a price change in the observation → digest changes.

**Done when**
- Tests pass; `pnpm typecheck`.

### MIU-18: approval receipt carries the source digest

```
Block:      BACKEND
Files:      packages/db/src/catalog-detail-staging.ts
            packages/db/src/catalog-detail-staging.test.ts
Type:       modify-existing
Depends on: MIU-17
```

**What it does**
- `prepareStagedApproval` copies the product's `detailSourcePublicDigest` into the
  job (extend strict `JobSchema`, `catalog-detail-staging.ts:25-42`).
- `finishStagedApproval` writes it into `catalogDetailApprovalReceipt.sourceDigest`
  (receipt at `:346-358`). The existing product fingerprint check already
  guarantees the candidate did not change between prepare and finish.
- Missing digest (product prepared before MIU-17) → receipt without `sourceDigest`
  (handled by the MIU-22 audit).

**Build/Deploy/Runtime impact**
- db package; receipt grows by one string. In-flight jobs created before deploy lack
  the key → still valid (optional).

**Test plan (write first)**
- begin → page → finish → receipt `sourceDigest` equals the product's
  `detailSourcePublicDigest` at prepare.
- Job created without a digest → finish succeeds, receipt has no `sourceDigest`.

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm build:functions && pnpm smoke:functions`.

### MIU-19: sync promote step flags "changed" / "removed"

```
Block:      BACKEND
Files:      apps/functions/alibaba-catalog-sync/src/promotion.ts
            packages/db/src/alibaba-product-identity.ts
            apps/functions/alibaba-catalog-sync/src/promotion.test.ts
Type:       modify-existing
Depends on: MIU-15, MIU-16, MIU-18
```

**What it does**
- In `promoteLinkedProduct` (`promotion.ts:68-168`), compute
  `publicSourceDigest(observation)` (observation already loaded) and pass it to the
  fenced promote mutation.
- In the promote transaction (`alibaba-product-identity.ts:473-516`), re-read the
  product. If it has `catalogDetailApprovalReceipt.sourceDigest`, is not archived,
  and either the digest differs **or** the source is inactive → set
  `alibabaReviewPending: true` and `alibabaReviewReason` to `'changed'` or
  `'removed'`.
- Never clears a pending flag. Never touches `catalogDetailPublication`.

**Build/Deploy/Runtime impact**
- Sync function + db package. One extra read-free comparison inside an existing
  transaction (no extra operations against the 100-op limit beyond the existing
  product read). "Removed" only fires on full runs; the timer is off (DESIGN §9).

**Test plan (write first)**
- Receipt digest D1, observation digest D2 → product flagged
  `{pending: true, reason: 'changed'}`.
- Same digest → no flag change (assert the update has no review fields).
- Inactive source with receipt → `reason: 'removed'`.
- No receipt digest → no flag (audit handles it).
- Archived product → no flag.

**Done when**
- Tests pass; `apps/functions/alibaba-catalog-sync` tests pass; `pnpm typecheck`;
  `pnpm build:functions && pnpm smoke:functions`.

### MIU-20: quarantine approval uses the same flag rule; retire "never resurrect"

```
Block:      BACKEND
Files:      apps/functions/alibaba-catalog-sync/src/quarantine.ts
            apps/functions/alibaba-catalog-sync/src/linking.test.ts
            docs/alibaba-linked-catalog-sync/NEW-PRODUCT-REVIEW-QUEUE-MIU-2026-09-04.md
Type:       modify-existing
Depends on: MIU-19
```

**What it does**
- Quarantine approval builds its own promote patch (`quarantine.ts:136-210`); route
  it through the same digest comparison and pass the digest to the promote mutation.
- `linking.test.ts:731-748` pins "an incremental refresh never resurrects a reviewed
  product as New". Keep that for **New** (a refresh never sets reason `'new'` on a
  reviewed product), and add the new rule: a refresh with a changed digest sets
  `'changed'`.
- Add a dated note to the review-queue doc pointing to this design.

**Build/Deploy/Runtime impact**
- Sync function only.

**Test plan (write first)**
- Quarantined candidate approved with a changed digest → `reason: 'changed'`.
- Refresh of a reviewed product with an unchanged digest → stays
  `{pending: false}`.

**Done when**
- Tests pass; `pnpm build:functions && pnpm smoke:functions`.

### MIU-21: approving or acknowledging clears the reason

```
Block:      BACKEND
Files:      apps/functions/admin/src/handler.ts
            packages/db/src/adapter.ts
            apps/functions/admin/src/handler.test.ts
Type:       modify-existing
Depends on: MIU-15
```

**What it does**
- `acknowledgeAlibabaProductReview` (`handler.ts:1468-1510`) writes
  `alibabaReviewReason: null` with `alibabaReviewPending: false`.
- `markProductReviewed` (`handler.ts:1532-1551`) is allowed only when the reason is
  `'new'` or absent (DEC-11, **Owner**); for `'changed'` / `'removed'` it returns
  `CONFLICT 'Approve the changes or unpublish the product.'`
- `adapter.ts:190-201` no-op strip treats the reason like the reviewer fields
  (already-reviewed rows stay idempotent).
- `rejectPendingReview` (`adapter.ts:179-184`) unchanged: it already stops
  publishing a product that became pending meanwhile.

**Build/Deploy/Runtime impact**
- Admin function + db package.

**Test plan (write first)**
- Publish of a `'changed'` product through the update path → pending `false`,
  reason `null`.
- Mark reviewed on `'new'` → cleared; on `'changed'` → `CONFLICT`, no write.
- Re-acknowledging an already-reviewed product → unchanged row (idempotent).

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm build:functions && pnpm smoke:functions`.

### MIU-22: one-time "changed since approval" audit action

```
Block:      BACKEND
Files:      apps/functions/admin/src/catalog-change-audit.ts        (new)
            apps/functions/admin/src/catalog-change-audit.test.ts   (new)
            apps/functions/admin/src/handler.ts
Type:       new-file + modify-existing
Depends on: MIU-15, MIU-16, MIU-18
```

**What it does**
- Admin-only action `auditChangesSinceApproval { mode: 'plan' | 'apply', afterId? }`
  for linked, non-archived products that have an approved version but no receipt
  `sourceDigest`.
- Plan: read the current observation; build the candidate in memory with
  `buildCatalogDetailCandidate` (no staging writes); compare with the approved
  version on DEC-6 content that both sides express:
  - per-SKU offer pricing and option values
  - SKU set
  - facts
  - description text
  - **Not compared:** images, because approved rows hold image IDs and the source
    holds URLs.

  Manifest row: `{productId, revision, outcome: 'unchanged' | 'changed', diffSummary}`.
- Apply: `unchanged` → write receipt `sourceDigest = publicSourceDigest(observation)`
  (baseline); `changed` → set `alibabaReviewPending: true, alibabaReviewReason:
  'changed'`. Both in a transaction that requires the same revision.

**Build/Deploy/Runtime impact**
- Admin function (depends on `catalog-import` and `shared`, already dependencies).
  Paged ≤20 products per call; no index change.

**Test plan (write first)**
- Approved SKU tiers = `unavailable`, observation SKU tiers = 130/122/120 →
  `changed` with a diff naming the SKU.
- Identical pricing/options → `unchanged`; apply writes only the receipt digest.
- Revision changed between plan and apply → skipped, no write.
- Contributor role → `FORBIDDEN`.

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm build:functions && pnpm smoke:functions`.

### MIU-23: admin badge and preview chip show the reason

```
Block:      FRONTEND
Files:      apps/site/src/islands/admin/CollectionView.tsx
            apps/site/src/islands/admin/PreviewModal.tsx
            apps/site/src/islands/admin/review-badge.test.ts   (new, or existing admin render test)
Type:       modify-existing
Depends on: MIU-15
```

**What it does**
- `ProductThumbnail` badge (`CollectionView.tsx:1154-1161`) text by reason:
  - `'new'` or absent → "New"
  - `'changed'` → "Changed"
  - `'removed'` → "Removed"

  Same amber style.
- Category tab markers (`CollectionView.tsx:529,537`) read "• Needs review" instead
  of "• New" (counts unchanged: they count `alibabaReviewPending`).
- `PreviewModal` chip (`:135-139`) shows the same text; "Mark reviewed"
  (`:334-342`) renders only for `'new'` / absent.

**Build/Deploy/Runtime impact**
- Site (admin island) bundle only.

**Test plan (write first)**
- Badge renders "Changed" for `{pending: true, reason: 'changed'}`, "New" for
  `{pending: true}` without reason, nothing for `{pending: false}`.
- Mark reviewed button absent for `'changed'`, present for `'new'`.

**Done when**
- Tests pass; `pnpm build`.

### MIU-24: "Approve changes" for a flagged, already-published product

```
Block:      FRONTEND
Files:      apps/site/src/islands/admin/PreviewModal.tsx
            apps/site/src/islands/admin/CollectionView.tsx
            apps/site/src/islands/admin/catalog-detail-approval-api.test.ts
Type:       modify-existing
Depends on: MIU-21, MIU-23
```

**What it does**
- In the preview of a product with `published === true` and reason
  `'changed'` / `'removed'`, show **"Approve changes"**. It calls the existing
  `updateRecord(..., { published: true })` (`apps/site/src/islands/admin/api.ts:258-377`),
  which already runs prepare → begin/page/finish → publish and, on the server,
  clears the flag (MIU-21).
- For `'removed'`, the modal also offers **Unpublish** (existing update with
  `published: false`).
- Show the per-SKU price difference from the preview data next to the button, so
  the admin sees what they are approving.

**Build/Deploy/Runtime impact**
- Admin island bundle only; no new endpoint.

**Test plan (write first)**
- Clicking "Approve changes" calls the approval sequence once and then the publish
  update (assert call order with mocked API).
- Button absent for unflagged or unpublished products (Publish covers those).

**Done when**
- Tests pass; `pnpm build`; local admin e2e `pnpm test:e2e:catalog-admin-local`
  passes.

### MIU-25: batch category assignment skips "changed" products

```
Block:      FRONTEND
Files:      apps/site/src/islands/admin/api.ts
            apps/site/src/islands/admin/product-batch-update.test.ts
Type:       modify-existing
Depends on: MIU-15
```

**What it does**
- Before `refreshPublishedDetail` re-approves a published product during a category
  change (`api.ts:264-276, 356-361`), skip products whose reason is `'changed'` or
  `'removed'` and return outcome `review-first` for them. Other products proceed
  as today.
- Existing batch feedback lists them as "Review changes first".

**Build/Deploy/Runtime impact**
- Admin island bundle only.

**Test plan (write first)**
- Batch of 3 with one `'changed'` → two assignments + re-approvals, one
  `review-first`, no approval call for the flagged one.
- Batch with no flagged products → behaviour identical to today
  (`product-batch-update.test.ts:107-150` unchanged).

**Done when**
- Tests pass; `pnpm build`.

---

## PT-D — Restore and prove

### MIU-26: `catalog-consistency-audit` script (list vs product page)

```
Block:      TESTING
Files:      scripts/catalog-consistency-audit.mjs        (new)
            scripts/catalog-consistency-audit.test.mjs   (new)
Type:       new-file + new-test
Depends on: none (uses the public API contract from MIU-8)
```

**What it does**
- `node scripts/catalog-consistency-audit.mjs --api <public api base>` reads every
  family list page, then each product's detail (bounded concurrency 8).
- For approved products it compares:
  - name
  - main photo id
  - card price summary vs the price derived from the detail with the same rule as
    `derivePriceSummary`
- Reports products with no detail (manual / row products) separately.
- Exits 1 on any mismatch; prints counts and the first 20 mismatches. Read-only.

**Build/Deploy/Runtime impact**
- Script only (`node:test` like other `scripts/*.test.mjs`, run by
  `pnpm test:deploy-smoke`). Not part of deploy.

**Test plan (write first)**
- Fixture where list and detail agree → exit 0.
- Fixture with a price mismatch → exit 1 and the product named.
- Detail 404 for a manual product → counted as row product, not a mismatch.

**Done when**
- `pnpm test:deploy-smoke` passes.

---

## Rollout runbook (operations, not code)

Each step needs the batch before it deployed to `test`. Steps marked ⚠ write
production data and need the owner's go-ahead at the time.

| Step | When | What | Check |
|---|---|---|---|
| R1 ⚠ | Now (Owner: DEC-13) | Unpublish the 21 products (list in EXECUTION_LOG) via admin | Their list/detail URLs return not found |
| R2 ⚠ | After batch 1 | Alibaba observation replay: Validate (dry run) → review manifest (`product-headline-dropped` rows) → Apply | No `offer-set-mismatch`; next "Run now" counts no surge |
| R3 | After batch 2 | Count products with `alibabaPinnedOfferKey` | 0 → continue; >0 → stop and ask (DESIGN §9) |
| R4 ⚠ | After batch 2 | `catalog-price-summary-backfill.mjs` plan → review → `--apply` | Approved versions without `priceSummary`: 0 |
| R5 | After batch 3 | Count (a) unlinked products with an old publication and (b) linked published products without an approved version; run `catalog-consistency-audit.mjs` | (b) = 0 expected (2026-10-06: 0); mismatches: 0 (the 21 are unpublished, so not counted) |
| R6 ⚠ | After batch 4 | `auditChangesSinceApproval` plan → review → apply | The 21 appear as `changed`; others get a baseline digest |
| R7 | After R6 | Admin approves each flagged product ("Approve changes" or Publish) | Flags cleared; products back in the list |
| R8 | After R7 | `catalog-consistency-audit.mjs`; browser check at 390px and 1440px: one multi-tier, one single-tier, one website-price, one "Request a quote" product; switch configurations | 0 mismatches; each configuration shows its own price |
